import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { Prisma, TournamentMatch } from '@prisma/client';
import { PrismaService } from '../database/prisma.service';
import {
  BracketGenerationError,
  generateBracket,
  getBracketSize,
} from './engine/bracket-generator';
import {
  GeneratedBracket,
  ParticipantToSeed,
} from './engine/tournament-engine.types';
import {
  TournamentMatchStatus,
  TournamentStatus,
} from './types/tournament.types';
import { checkInDeadlineFrom } from './tournament-rules';

export interface AdvanceWinnerResult {
  completedMatchId: string;
  // null on a double forfeit
  winnerId: string | null;
  nextMatchId: string | null;
  // set only when this call ended the tournament with a champion
  championId: string | null;
  // for #168 realtime updates
  changedMatchIds: string[];
  // true even when the tournament ended without a champion
  tournamentFinished: boolean;
}

export interface MatchDrawResult {
  action: 'REPLAY' | 'ADVANCED_BY_SEED';
  replayCount: number;
  winnerId?: string;
  advanceResult?: AdvanceWinnerResult;
}

const BRACKET_STARTABLE_STATUSES: TournamentStatus[] = ['REGISTRATION_CLOSED'];

const PLAYABLE_MATCH_STATUSES: TournamentMatchStatus[] = [
  'SCHEDULED',
  'IN_PROGRESS',
];

const CONCLUDED_MATCH_STATUSES: TournamentMatchStatus[] = ['COMPLETED', 'WALKOVER'];

type PlayableMatch = TournamentMatch & { player1Id: string; player2Id: string };

@Injectable()
export class TournamentBracketService {
  private readonly logger = new Logger(TournamentBracketService.name);

  constructor(private readonly prisma: PrismaService) {}

  // Claims the tournament first, so a second call gets 409 instead of a duplicate bracket.
  async generateAndSaveBracket(
    tx: Prisma.TransactionClient,
    tournamentId: string,
    customBracketSize?: number,
  ): Promise<GeneratedBracket> {
    const claimed = await tx.tournament.updateMany({
      where: {
        id: tournamentId,
        status: { in: BRACKET_STARTABLE_STATUSES },
      },
      data: {
        status: 'IN_PROGRESS',
        startedAt: new Date(),
      },
    });

    if (claimed.count !== 1) {
      const existing = await tx.tournament.findUnique({
        where: { id: tournamentId },
        select: { status: true },
      });
      if (!existing) {
        throw new NotFoundException(`Tournament ${tournamentId} not found.`);
      }
      throw new ConflictException(
        `Tournament ${tournamentId} cannot be started from status ${existing.status}.`,
      );
    }

    const existingMatches = await tx.tournamentMatch.count({
      where: { tournamentId },
    });
    if (existingMatches > 0) {
      throw new ConflictException(
        `Tournament ${tournamentId} already has a generated bracket.`,
      );
    }

    const tournament = await tx.tournament.findUnique({
      where: { id: tournamentId },
      include: {
        participants: {
          include: {
            user: {
              select: {
                id: true,
                rating: true,
              },
            },
          },
        },
      },
    });

    if (!tournament) {
      throw new NotFoundException(`Tournament ${tournamentId} not found.`);
    }

    if (tournament.participants.length < 2) {
      throw new BadRequestException(
        `Tournament ${tournamentId} has fewer than 2 participants (${tournament.participants.length}).`,
      );
    }

    // freeze seed_rating from the current rating, unless already set
    const participantsToSeed: (ParticipantToSeed & { participantId: string })[] =
      tournament.participants.map((p) => ({
        participantId: p.id,
        userId: p.userId,
        seedRating: p.seedRating ?? p.user.rating,
        registeredAt: p.registeredAt,
      }));

    const bracketSize =
      customBracketSize ?? getBracketSize(participantsToSeed.length);

    let bracket: GeneratedBracket;
    try {
      bracket = generateBracket({
        tournamentId,
        participants: participantsToSeed,
        bracketSize,
      });
    } catch (err) {
      if (err instanceof BracketGenerationError) {
        // throwing here also rolls back the status claim
        throw new BadRequestException({
          error: { code: 'INVALID_BRACKET', message: err.message },
        });
      }
      throw err;
    }

    // clear old seeds first, otherwise the updates hit the (tournament_id, seed) unique index
    await tx.tournamentParticipant.updateMany({
      where: { tournamentId },
      data: { seed: null },
    });

    const participantIdByUser = new Map(
      participantsToSeed.map((p) => [p.userId, p.participantId]),
    );
    for (const sp of bracket.seededParticipants) {
      const participantId = participantIdByUser.get(sp.userId);
      if (participantId) {
        await tx.tournamentParticipant.update({
          where: { id: participantId },
          data: {
            seed: sp.seed,
            seedRating: sp.seedRating,
          },
        });
      }
    }

    // every match that starts SCHEDULED (round 1, or round 2 filled by byes) opens check-in now
    const checkInDeadline = checkInDeadlineFrom(new Date());
    await tx.tournamentMatch.createMany({
      data: bracket.matches.map((m) => ({
        id: m.id,
        tournamentId,
        round: m.round,
        matchIndex: m.matchIndex,
        identifier: m.identifier,
        player1Id: m.player1Id,
        player2Id: m.player2Id,
        winnerId: m.winnerId,
        status: m.status,
        isBye: m.isBye,
        nextMatchId: m.nextMatchId,
        nextMatchSlot: m.nextMatchSlot,
        checkInDeadline: m.status === 'SCHEDULED' ? checkInDeadline : null,
      })),
    });

    this.logger.log(
      `Generated bracket for tournament ${tournamentId}: size=${bracketSize}, matches=${bracket.matches.length}`,
    );

    return bracket;
  }

  async advanceWinner(
    tx: Prisma.TransactionClient,
    tournamentId: string,
    matchId: string,
    winnerId: string,
  ): Promise<AdvanceWinnerResult> {
    await this.assertTournamentInProgress(tx, tournamentId);
    const match = await this.loadPlayableMatch(tx, tournamentId, matchId);

    if (match.player1Id !== winnerId && match.player2Id !== winnerId) {
      throw new BadRequestException(
        `Player ${winnerId} is not a participant in match ${matchId}.`,
      );
    }

    return this.completeMatch(tx, match, winnerId, 'COMPLETED');
  }

  // Up to 2 replays with colours swapped, after a 3rd draw the higher seed goes through.
  async handleMatchDraw(
    tx: Prisma.TransactionClient,
    tournamentId: string,
    matchId: string,
  ): Promise<MatchDrawResult> {
    await this.assertTournamentInProgress(tx, tournamentId);
    const match = await this.loadPlayableMatch(tx, tournamentId, matchId);

    // abandonments are forfeits, not draws; wait until no game of this match is running
    const [liveGames, gamesCount] = await Promise.all([
      tx.game.count({
        where: { tournamentMatchId: matchId, result: 'IN_PROGRESS' },
      }),
      tx.game.count({
        where: {
          tournamentMatchId: matchId,
          result: 'DRAW',
          // `not` alone would also drop rows with a NULL end_reason
          OR: [{ endReason: null }, { endReason: { not: 'ABANDONMENT' } }],
        },
      }),
    ]);

    if (liveGames > 0) {
      throw new ConflictException(
        `Match ${matchId} still has a game in progress.`,
      );
    }
    if (gamesCount === 0) {
      throw new ConflictException(
        `Match ${matchId} has no drawn game to resolve.`,
      );
    }

    if (gamesCount < 3) {
      this.logger.log(
        `Match ${matchId} drawn (game #${gamesCount}). Triggering replay with swapped colors.`,
      );
      return {
        action: 'REPLAY',
        replayCount: gamesCount,
      };
    }

    // 3 draws in a row: better seed advances
    const participants = await tx.tournamentParticipant.findMany({
      where: {
        tournamentId,
        userId: { in: [match.player1Id, match.player2Id] },
      },
      select: {
        userId: true,
        seed: true,
      },
    });

    const p1Seed = participants.find((p) => p.userId === match.player1Id)?.seed;
    const p2Seed = participants.find((p) => p.userId === match.player2Id)?.seed;

    if (p1Seed == null || p2Seed == null) {
      throw new ConflictException(
        `Cannot resolve draw tiebreak in match ${matchId}: participant seed missing.`,
      );
    }

    const winnerId = p1Seed < p2Seed ? match.player1Id : match.player2Id;

    this.logger.log(
      `Match ${matchId} drawn 3 times. Advance by better seed: #${p1Seed} vs #${p2Seed} -> Winner: ${winnerId}`,
    );

    const advanceResult = await this.completeMatch(
      tx,
      match,
      winnerId,
      'COMPLETED',
    );

    return {
      action: 'ADVANCED_BY_SEED',
      replayCount: gamesCount,
      winnerId,
      advanceResult,
    };
  }

  async handleWalkover(
    tx: Prisma.TransactionClient,
    tournamentId: string,
    matchId: string,
    forfeitedUserId: string,
  ): Promise<AdvanceWinnerResult> {
    await this.assertTournamentInProgress(tx, tournamentId);
    const match = await this.loadPlayableMatch(tx, tournamentId, matchId);

    if (
      match.player1Id !== forfeitedUserId &&
      match.player2Id !== forfeitedUserId
    ) {
      throw new BadRequestException(
        `Player ${forfeitedUserId} is not part of match ${matchId}.`,
      );
    }

    const winnerId =
      forfeitedUserId === match.player1Id ? match.player2Id : match.player1Id;

    return this.completeMatch(tx, match, winnerId, 'WALKOVER');
  }

  // Both players no-show: nobody advances, the next-round opponent gets a walkover.
  async handleDoubleForfeit(
    tx: Prisma.TransactionClient,
    tournamentId: string,
    matchId: string,
  ): Promise<AdvanceWinnerResult> {
    await this.assertTournamentInProgress(tx, tournamentId);
    const match = await this.loadPlayableMatch(tx, tournamentId, matchId);

    this.logger.log(`Match ${matchId}: double forfeit, no player advances.`);
    return this.completeMatch(tx, match, null, 'WALKOVER');
  }

  private async assertTournamentInProgress(
    tx: Prisma.TransactionClient,
    tournamentId: string,
  ): Promise<void> {
    const tournament = await tx.tournament.findUnique({
      where: { id: tournamentId },
      select: { status: true },
    });
    if (!tournament) {
      throw new NotFoundException(`Tournament ${tournamentId} not found.`);
    }
    if (tournament.status !== 'IN_PROGRESS') {
      throw new ConflictException(
        `Tournament ${tournamentId} is not in progress (status ${tournament.status}).`,
      );
    }
  }

  private async loadPlayableMatch(
    tx: Prisma.TransactionClient,
    tournamentId: string,
    matchId: string,
  ): Promise<PlayableMatch> {
    const match = await tx.tournamentMatch.findUnique({
      where: { id: matchId },
    });

    if (!match || match.tournamentId !== tournamentId) {
      throw new NotFoundException(
        `Match ${matchId} not found in tournament ${tournamentId}.`,
      );
    }

    if (!PLAYABLE_MATCH_STATUSES.includes(match.status as TournamentMatchStatus)) {
      throw new ConflictException(
        `Match ${matchId} cannot receive a result in status ${match.status}.`,
      );
    }

    if (!match.player1Id || !match.player2Id) {
      throw new ConflictException(
        `Match ${matchId} does not have both players assigned yet.`,
      );
    }

    return match as PlayableMatch;
  }

  // All writes re-check the state in WHERE, so a concurrent caller gets 409 instead of advancing twice.
  private async completeMatch(
    tx: Prisma.TransactionClient,
    match: TournamentMatch,
    winnerId: string | null,
    finalStatus: 'COMPLETED' | 'WALKOVER',
    allowedFrom: TournamentMatchStatus[] = PLAYABLE_MATCH_STATUSES,
  ): Promise<AdvanceWinnerResult> {
    const closed = await tx.tournamentMatch.updateMany({
      where: {
        id: match.id,
        tournamentId: match.tournamentId,
        status: { in: allowedFrom },
        winnerId: null,
      },
      data: {
        status: finalStatus,
        winnerId,
      },
    });

    if (closed.count !== 1) {
      throw new ConflictException(
        `Match ${match.id} was concluded concurrently.`,
      );
    }

    if (!match.nextMatchId) {
      await this.assertFinalRound(tx, match);
      await this.concludeTournament(tx, match, winnerId);
      return {
        completedMatchId: match.id,
        winnerId,
        nextMatchId: null,
        championId: winnerId,
        changedMatchIds: [match.id],
        tournamentFinished: true,
      };
    }

    const cascade = await this.feedNextMatch(tx, match, winnerId);

    return {
      completedMatchId: match.id,
      winnerId,
      nextMatchId: match.nextMatchId,
      championId: cascade?.championId ?? null,
      changedMatchIds: [...new Set([match.id, match.nextMatchId, ...(cascade?.changedMatchIds ?? [])])],
      tournamentFinished: cascade?.tournamentFinished ?? false,
    };
  }

  // Locks the parent row (FOR UPDATE) so two sibling matches finishing at once are serialized.
  // If the parent can't get a second player anymore it's resolved here, up to the final.
  private async feedNextMatch(
    tx: Prisma.TransactionClient,
    match: TournamentMatch,
    winnerId: string | null,
  ): Promise<AdvanceWinnerResult | null> {
    if (match.nextMatchSlot !== 'player1' && match.nextMatchSlot !== 'player2') {
      throw new ConflictException(
        `Match ${match.id} has an invalid next match slot (${match.nextMatchSlot}).`,
      );
    }
    const nextMatchId = match.nextMatchId as string;

    await tx.$queryRaw`SELECT id FROM "tournament_matches" WHERE id = ${nextMatchId}::uuid FOR UPDATE`;

    if (winnerId) {
      const isPlayer1Slot = match.nextMatchSlot === 'player1';
      const emptySlot = isPlayer1Slot ? { player1Id: null } : { player2Id: null };
      const slotUpdate = isPlayer1Slot
        ? { player1Id: winnerId }
        : { player2Id: winnerId };

      const filled = await tx.tournamentMatch.updateMany({
        where: {
          id: nextMatchId,
          tournamentId: match.tournamentId,
          status: 'PENDING',
          ...emptySlot,
        },
        data: slotUpdate,
      });

      if (filled.count !== 1) {
        throw new ConflictException(
          `Next match ${nextMatchId} slot ${match.nextMatchSlot} is not available.`,
        );
      }
    }

    const next = await tx.tournamentMatch.findUnique({ where: { id: nextMatchId } });
    if (!next) {
      throw new NotFoundException(`Next match ${nextMatchId} not found.`);
    }
    if (next.status !== 'PENDING') {
      return null;
    }

    if (next.player1Id && next.player2Id) {
      // becoming SCHEDULED opens check-in (#161)
      await tx.tournamentMatch.updateMany({
        where: { id: next.id, status: 'PENDING' },
        data: { status: 'SCHEDULED', checkInDeadline: checkInDeadlineFrom(new Date()) },
      });
      return null;
    }

    const feeders = await tx.tournamentMatch.findMany({
      where: { nextMatchId: next.id },
    });
    const allFeedersConcluded = feeders.every((f) =>
      CONCLUDED_MATCH_STATUSES.includes(f.status as TournamentMatchStatus),
    );
    if (!allFeedersConcluded) {
      return null; // The other side is still being played.
    }

    // the parent can't get a second player anymore
    const lonePlayer = next.player1Id ?? next.player2Id ?? null;
    this.logger.log(
      lonePlayer
        ? `Match ${next.id}: opponent slot can never be filled, ${lonePlayer} advances by walkover.`
        : `Match ${next.id}: no players left after double forfeits, nobody advances.`,
    );
    return this.completeMatch(tx, next, lonePlayer, 'WALKOVER', ['PENDING']);
  }

  // No parent means final. Catches a lost next_match_id link (ON DELETE SET NULL).
  private async assertFinalRound(
    tx: Prisma.TransactionClient,
    match: TournamentMatch,
  ): Promise<void> {
    const last = await tx.tournamentMatch.aggregate({
      where: { tournamentId: match.tournamentId },
      _max: { round: true },
    });
    if (last._max.round !== match.round) {
      throw new ConflictException(
        `Match ${match.id} (round ${match.round}) has no next match but is not the Final ` +
          `(last round ${last._max.round}): bracket links are inconsistent.`,
      );
    }
  }

  // Ranks: champion 1, finalist 2 (both 2 on a double forfeit), semifinal losers 3.
  private async concludeTournament(
    tx: Prisma.TransactionClient,
    finalMatch: TournamentMatch,
    winnerId: string | null,
  ): Promise<void> {
    const tournamentId = finalMatch.tournamentId;

    const finished = await tx.tournament.updateMany({
      where: { id: tournamentId, status: 'IN_PROGRESS' },
      data: {
        status: 'FINISHED',
        completedAt: new Date(),
        championId: winnerId,
      },
    });

    if (finished.count !== 1) {
      throw new ConflictException(
        `Tournament ${tournamentId} was concluded concurrently.`,
      );
    }

    const setRank = (userId: string | null, finalRank: number) =>
      userId
        ? tx.tournamentParticipant.updateMany({
            where: { tournamentId, userId },
            data: { finalRank },
          })
        : Promise.resolve();

    const finalists = [finalMatch.player1Id, finalMatch.player2Id];
    for (const player of finalists) {
      await setRank(player, player === winnerId ? 1 : 2);
    }

    if (finalMatch.round > 1) {
      const semifinals = await tx.tournamentMatch.findMany({
        where: { tournamentId, round: finalMatch.round - 1 },
      });
      for (const sf of semifinals) {
        if (sf.isBye) continue;
        for (const player of [sf.player1Id, sf.player2Id]) {
          if (player && player !== sf.winnerId) {
            await setRank(player, 3);
          }
        }
      }
    }

    this.logger.log(
      winnerId
        ? `Tournament ${tournamentId} finished! Champion: ${winnerId}`
        : `Tournament ${tournamentId} finished without a champion (double forfeit in the Final).`,
    );
  }
}
