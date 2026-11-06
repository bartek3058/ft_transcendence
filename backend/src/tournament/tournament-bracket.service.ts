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

export interface AdvanceWinnerResult {
  completedMatchId: string;
  /** null when both players forfeited (nobody advances). */
  winnerId: string | null;
  nextMatchId: string | null;
  /** Set when this call (or a cascade it triggered) finished the tournament with a champion. */
  championId: string | null;
}

export interface MatchDrawResult {
  action: 'REPLAY' | 'ADVANCED_BY_SEED';
  replayCount: number;
  winnerId?: string;
  advanceResult?: AdvanceWinnerResult;
}

/** Tournament statuses from which a bracket may be generated. */
const BRACKET_STARTABLE_STATUSES: TournamentStatus[] = ['REGISTRATION_CLOSED'];

/** Match statuses in which a result (win, draw, walkover) may be recorded. */
const PLAYABLE_MATCH_STATUSES: TournamentMatchStatus[] = [
  'SCHEDULED',
  'IN_PROGRESS',
];

/** Match statuses after which a match never changes again. */
const CONCLUDED_MATCH_STATUSES: TournamentMatchStatus[] = ['COMPLETED', 'WALKOVER'];

/** A match that passed the playable checks: both players are known. */
type PlayableMatch = TournamentMatch & { player1Id: string; player2Id: string };

@Injectable()
export class TournamentBracketService {
  private readonly logger = new Logger(TournamentBracketService.name);

  constructor(private readonly prisma: PrismaService) {}

  /**
   * Freezes seed_rating, runs balanced bracket generation, and persists all
   * tournament_matches rows and seed assignments in a single transaction.
   *
   * The tournament is claimed first with a conditional status update
   * (REGISTRATION_CLOSED -> IN_PROGRESS), so a second or concurrent call
   * gets 409 instead of a duplicate bracket or a raw unique-index error.
   */
  async generateAndSaveBracket(
    tx: Prisma.TransactionClient,
    tournamentId: string,
    customBracketSize?: number,
  ): Promise<GeneratedBracket> {
    // 1. Atomically claim the tournament (zero-race status transition).
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

    // 2. Defensive: a startable tournament must not already have a bracket.
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

    // Freeze seed_rating from users.rating snapshot if not already frozen
    const participantsToSeed: (ParticipantToSeed & { participantId: string })[] =
      tournament.participants.map((p) => ({
        participantId: p.id,
        userId: p.userId,
        seedRating: p.seedRating ?? p.user.rating,
        registeredAt: p.registeredAt,
      }));

    const bracketSize =
      customBracketSize ?? getBracketSize(participantsToSeed.length);

    const bracket = generateBracket({
      tournamentId,
      participants: participantsToSeed,
      bracketSize,
    });

    // 3. Clear any stale seeds first so sequential updates cannot collide on
    //    the (tournament_id, seed) unique index.
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

    // 4. Bulk insert all tournament match nodes
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
      })),
    });

    this.logger.log(
      `Generated bracket for tournament ${tournamentId}: size=${bracketSize}, matches=${bracket.matches.length}`,
    );

    return bracket;
  }

  /**
   * Records a decisive result and advances the winner:
   * - Match must be SCHEDULED/IN_PROGRESS with both players known.
   * - Winner is propagated into the parent slot; parent becomes SCHEDULED
   *   once both of its players are known.
   * - Concluding the Final crowns the Champion and assigns final ranks.
   */
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

  /**
   * Handles draw resolution in a knockout match:
   * Up to 2 replays with colors swapped. If game 3 is also drawn,
   * the higher seed (lower seed number) advances.
   */
  async handleMatchDraw(
    tx: Prisma.TransactionClient,
    tournamentId: string,
    matchId: string,
  ): Promise<MatchDrawResult> {
    await this.assertTournamentInProgress(tx, tournamentId);
    const match = await this.loadPlayableMatch(tx, tournamentId, matchId);

    const gamesCount = await tx.game.count({
      where: { tournamentMatchId: matchId },
    });

    if (gamesCount < 3) {
      this.logger.log(
        `Match ${matchId} drawn (game #${gamesCount}). Triggering replay with swapped colors.`,
      );
      return {
        action: 'REPLAY',
        replayCount: gamesCount,
      };
    }

    // Maximum 2 replays reached (total 3 drawn games) -> better seed advances.
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

  /**
   * Handles player forfeit or no-show.
   * The opponent is declared winner (match status = WALKOVER) and advanced.
   */
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

  /**
   * Both players failed to show up / abandoned: both lose, nobody advances.
   * The match is closed as WALKOVER without a winner; the opponent waiting in
   * the next round then advances without playing (see feedNextMatch).
   */
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

  // ---------------------------------------------------------------------------
  // Internal state-machine helpers
  // ---------------------------------------------------------------------------

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

  /**
   * Loads a match and checks it can receive a result: it belongs to the
   * tournament, is SCHEDULED/IN_PROGRESS and both players are known.
   */
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

  /**
   * Single guarded path for concluding a match (win, seed tiebreak, walkover,
   * double forfeit, or automatic resolution of a match that can no longer be
   * played).
   *
   * Every write is a conditional UPDATE whose WHERE clause re-checks the
   * expected state, so under READ COMMITTED a concurrent caller that read the
   * same row sees count = 0 and gets 409 instead of advancing twice.
   */
  private async completeMatch(
    tx: Prisma.TransactionClient,
    match: TournamentMatch,
    winnerId: string | null,
    finalStatus: 'COMPLETED' | 'WALKOVER',
    allowedFrom: TournamentMatchStatus[] = PLAYABLE_MATCH_STATUSES,
  ): Promise<AdvanceWinnerResult> {
    // 1. Close the match only if it is still open.
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
      await this.concludeTournament(tx, match, winnerId);
      return {
        completedMatchId: match.id,
        winnerId,
        nextMatchId: null,
        championId: winnerId,
      };
    }

    const cascade = await this.feedNextMatch(tx, match, winnerId);

    return {
      completedMatchId: match.id,
      winnerId,
      nextMatchId: match.nextMatchId,
      championId: cascade?.championId ?? null,
    };
  }

  /**
   * Pushes the result of a concluded match into its parent match:
   * - a winner fills the parent slot; with both players known the parent
   *   becomes SCHEDULED;
   * - once both feeders are concluded and the parent still lacks a player
   *   (double forfeit upstream), it is resolved without a game: the lone
   *   player advances by WALKOVER, or with no player it is a double forfeit
   *   too. This cascades up to the Final.
   *
   * The parent row is locked first (SELECT ... FOR UPDATE), so two sibling
   * feeders concluding concurrently are serialized and the second one always
   * sees the first one's committed result.
   */
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
      await tx.tournamentMatch.updateMany({
        where: { id: next.id, status: 'PENDING' },
        data: { status: 'SCHEDULED' },
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

    // The parent can no longer get a second player: resolve it without a game.
    const lonePlayer = next.player1Id ?? next.player2Id ?? null;
    this.logger.log(
      lonePlayer
        ? `Match ${next.id}: opponent slot can never be filled, ${lonePlayer} advances by walkover.`
        : `Match ${next.id}: no players left after double forfeits, nobody advances.`,
    );
    return this.completeMatch(tx, next, lonePlayer, 'WALKOVER', ['PENDING']);
  }

  /**
   * Finishes the tournament after the Final and assigns final ranks:
   * - winner: Champion (1), the other finalist (if any): 2;
   * - double forfeit in the Final: no champion, both finalists get 2;
   * - semifinal losers share 3 (both players of a double-forfeited semifinal too).
   */
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
