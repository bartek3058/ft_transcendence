import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../database/prisma.service';
import {
  generateBracket,
  getBracketSize,
} from './engine/bracket-generator';
import {
  GeneratedBracket,
  ParticipantToSeed,
} from './engine/tournament-engine.types';

export interface AdvanceWinnerResult {
  completedMatchId: string;
  winnerId: string;
  nextMatchId: string | null;
  championId: string | null;
}

export interface MatchDrawResult {
  action: 'REPLAY' | 'ADVANCED_BY_SEED';
  replayCount: number;
  winnerId?: string;
  advanceResult?: AdvanceWinnerResult;
}

@Injectable()
export class TournamentBracketService {
  private readonly logger = new Logger(TournamentBracketService.name);

  constructor(private readonly prisma: PrismaService) {}

  /**
   * Freezes seed_rating, runs balanced bracket generation, and persists all
   * tournament_matches rows and seed assignments in a single transaction.
   */
  async generateAndSaveBracket(
    tx: Prisma.TransactionClient,
    tournamentId: string,
    customBracketSize?: number,
  ): Promise<GeneratedBracket> {
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

    // 1. Update participant seeds and frozen seedRating
    for (const sp of bracket.seededParticipants) {
      const matchParticipant = participantsToSeed.find(
        (p) => p.userId === sp.userId,
      );
      if (matchParticipant) {
        await tx.tournamentParticipant.update({
          where: { id: matchParticipant.participantId },
          data: {
            seed: sp.seed,
            seedRating: sp.seedRating,
          },
        });
      }
    }

    // 2. Bulk insert all tournament match nodes
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

    // 3. Mark tournament as IN_PROGRESS
    await tx.tournament.update({
      where: { id: tournamentId },
      data: {
        status: 'IN_PROGRESS',
        startedAt: new Date(),
      },
    });

    this.logger.log(
      `Generated bracket for tournament ${tournamentId}: size=${bracketSize}, matches=${bracket.matches.length}`,
    );

    return bracket;
  }

  /**
   * Advances a winner through the tournament ladder:
   * - Marks match as COMPLETED with winnerId.
   * - If nextMatch exists, propagates winnerId into player1/player2 slot.
   * - If nextMatch has both players, marks it as SCHEDULED.
   * - If Final round concludes, crowns Champion and assigns final rankings.
   */
  async advanceWinner(
    tx: Prisma.TransactionClient,
    tournamentId: string,
    matchId: string,
    winnerId: string,
  ): Promise<AdvanceWinnerResult> {
    const match = await tx.tournamentMatch.findUnique({
      where: { id: matchId },
    });

    if (!match) {
      throw new NotFoundException(`Match ${matchId} not found.`);
    }

    if (match.tournamentId !== tournamentId) {
      throw new BadRequestException(
        `Match ${matchId} does not belong to tournament ${tournamentId}.`,
      );
    }

    if (match.status === 'COMPLETED' || match.status === 'WALKOVER') {
      throw new ConflictException(
        `Match ${matchId} has already concluded with status ${match.status}.`,
      );
    }

    if (match.player1Id !== winnerId && match.player2Id !== winnerId) {
      throw new BadRequestException(
        `Player ${winnerId} is not a participant in match ${matchId} (${match.player1Id} vs ${match.player2Id}).`,
      );
    }

    // 1. Mark match completed
    await tx.tournamentMatch.update({
      where: { id: matchId },
      data: {
        status: 'COMPLETED',
        winnerId,
      },
    });

    // 2. If nextMatch exists, advance winner to next round slot
    if (match.nextMatchId) {
      const nextMatch = await tx.tournamentMatch.findUnique({
        where: { id: match.nextMatchId },
      });

      if (!nextMatch) {
        throw new NotFoundException(
          `Next match ${match.nextMatchId} not found in database.`,
        );
      }

      const isPlayer1Slot = match.nextMatchSlot === 'player1';
      const slotUpdate = isPlayer1Slot
        ? { player1Id: winnerId }
        : { player2Id: winnerId };

      const opponentId = isPlayer1Slot
        ? nextMatch.player2Id
        : nextMatch.player1Id;

      // Both players are present -> match is SCHEDULED to be played
      const nextStatus = opponentId ? 'SCHEDULED' : 'PENDING';

      await tx.tournamentMatch.update({
        where: { id: match.nextMatchId },
        data: {
          ...slotUpdate,
          status: nextStatus,
        },
      });

      return {
        completedMatchId: matchId,
        winnerId,
        nextMatchId: match.nextMatchId,
        championId: null,
      };
    }

    // 3. Final round concluded -> Crown Champion & assign final ranks
    await tx.tournament.update({
      where: { id: tournamentId },
      data: {
        status: 'FINISHED',
        completedAt: new Date(),
        championId: winnerId,
      },
    });

    // Rank 1: Winner (Champion)
    await tx.tournamentParticipant.updateMany({
      where: { tournamentId, userId: winnerId },
      data: { finalRank: 1 },
    });

    // Rank 2: Runner-up (final loser)
    const runnerUpId =
      winnerId === match.player1Id ? match.player2Id : match.player1Id;
    if (runnerUpId) {
      await tx.tournamentParticipant.updateMany({
        where: { tournamentId, userId: runnerUpId },
        data: { finalRank: 2 },
      });
    }

    // Rank 3: Losing semifinalists (loss in round = match.round - 1)
    if (match.round > 1) {
      const semifinalRound = match.round - 1;
      const semifinalMatches = await tx.tournamentMatch.findMany({
        where: { tournamentId, round: semifinalRound },
      });

      for (const sf of semifinalMatches) {
        const loser =
          sf.winnerId === sf.player1Id ? sf.player2Id : sf.player1Id;
        if (loser) {
          await tx.tournamentParticipant.updateMany({
            where: { tournamentId, userId: loser },
            data: { finalRank: 3 },
          });
        }
      }
    }

    this.logger.log(
      `Tournament ${tournamentId} finished! Champion: ${winnerId}`,
    );

    return {
      completedMatchId: matchId,
      winnerId,
      nextMatchId: null,
      championId: winnerId,
    };
  }

  /**
   * Handles draw resolution in knockout match:
   * Core rule: Up to 2 replays with colors swapped.
   * If game 3 is also drawn, the higher seed (lower seed number) advances.
   */
  async handleMatchDraw(
    tx: Prisma.TransactionClient,
    tournamentId: string,
    matchId: string,
  ): Promise<MatchDrawResult> {
    const match = await tx.tournamentMatch.findUnique({
      where: { id: matchId },
    });

    if (!match || match.tournamentId !== tournamentId) {
      throw new NotFoundException(`Match ${matchId} not found in tournament.`);
    }

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

    // Maximum 2 replays reached (total 3 drawn games) -> Core tiebreak fallback:
    // Better seed (lower seed number) advances.
    const participants = await tx.tournamentParticipant.findMany({
      where: {
        tournamentId,
        userId: { in: [match.player1Id!, match.player2Id!] },
      },
      select: {
        userId: true,
        seed: true,
      },
    });

    const p1 = participants.find((p) => p.userId === match.player1Id);
    const p2 = participants.find((p) => p.userId === match.player2Id);

    const p1Seed = p1?.seed ?? 999;
    const p2Seed = p2?.seed ?? 999;

    const winnerId =
      p1Seed <= p2Seed ? match.player1Id! : match.player2Id!;

    this.logger.log(
      `Match ${matchId} drawn 3 times. Advance by better seed: #${p1Seed} vs #${p2Seed} -> Winner: ${winnerId}`,
    );

    const advanceResult = await this.advanceWinner(
      tx,
      tournamentId,
      matchId,
      winnerId,
    );

    return {
      action: 'ADVANCED_BY_SEED',
      replayCount: gamesCount,
      winnerId,
      advanceResult,
    };
  }

  /**
   * Handles player forfeit or disconnection walkover.
   * Opponent is declared winner and advanced with status = 'WALKOVER'.
   */
  async handleWalkover(
    tx: Prisma.TransactionClient,
    tournamentId: string,
    matchId: string,
    forfeitedUserId: string,
  ): Promise<AdvanceWinnerResult> {
    const match = await tx.tournamentMatch.findUnique({
      where: { id: matchId },
    });

    if (!match || match.tournamentId !== tournamentId) {
      throw new NotFoundException(`Match ${matchId} not found in tournament.`);
    }

    if (
      match.player1Id !== forfeitedUserId &&
      match.player2Id !== forfeitedUserId
    ) {
      throw new BadRequestException(
        `Player ${forfeitedUserId} is not part of match ${matchId}.`,
      );
    }

    const winnerId =
      forfeitedUserId === match.player1Id
        ? match.player2Id
        : match.player1Id;

    if (!winnerId) {
      throw new BadRequestException(
        `Cannot award walkover: opponent is not yet known in match ${matchId}.`,
      );
    }

    // Mark as WALKOVER
    await tx.tournamentMatch.update({
      where: { id: matchId },
      data: {
        status: 'WALKOVER',
        winnerId,
      },
    });

    // Advance winner through tournament tree
    if (match.nextMatchId) {
      const nextMatch = await tx.tournamentMatch.findUnique({
        where: { id: match.nextMatchId },
      });

      if (!nextMatch) {
        throw new NotFoundException(`Next match ${match.nextMatchId} not found.`);
      }

      const isPlayer1Slot = match.nextMatchSlot === 'player1';
      const slotUpdate = isPlayer1Slot
        ? { player1Id: winnerId }
        : { player2Id: winnerId };

      const opponentId = isPlayer1Slot
        ? nextMatch.player2Id
        : nextMatch.player1Id;

      await tx.tournamentMatch.update({
        where: { id: match.nextMatchId },
        data: {
          ...slotUpdate,
          status: opponentId ? 'SCHEDULED' : 'PENDING',
        },
      });

      return {
        completedMatchId: matchId,
        winnerId,
        nextMatchId: match.nextMatchId,
        championId: null,
      };
    }

    // Final match walkover -> Crown Champion
    await tx.tournament.update({
      where: { id: tournamentId },
      data: {
        status: 'FINISHED',
        completedAt: new Date(),
        championId: winnerId,
      },
    });

    await tx.tournamentParticipant.updateMany({
      where: { tournamentId, userId: winnerId },
      data: { finalRank: 1 },
    });

    await tx.tournamentParticipant.updateMany({
      where: { tournamentId, userId: forfeitedUserId },
      data: { finalRank: 2 },
    });

    return {
      completedMatchId: matchId,
      winnerId,
      nextMatchId: null,
      championId: winnerId,
    };
  }
}
