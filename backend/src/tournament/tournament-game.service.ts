import {
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
  OnModuleInit,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { randomUUID } from 'crypto';
import { PrismaService } from '../database/prisma.service';
import { GameService } from '../game/game.service';
import { GameConclusionEvent } from '../game/types/chess.types';
import { TournamentBracketService } from './tournament-bracket.service';

export interface TournamentGameCreated {
  gameId: string;
  tournamentId: string;
  tournamentMatchId: string;
  whitePlayerId: string;
  blackPlayerId: string;
}

/**
 * Glue between live chess games and the tournament bracket (#68).
 *
 * - Registers itself as a GameService conclusion listener, so a finished
 *   tournament game advances the bracket (win) or triggers a replay with
 *   swapped colors / the seed tiebreak (draw).
 * - An ABANDONMENT ending is a forfeit: with a winner it is a WALKOVER for the
 *   absent player; without a winner (removeGame(id, { winnerColor: null,
 *   gameOverReason: 'ABANDONMENT' })) both players lose and nobody advances.
 * - Creates tournament games (`games` row + in-memory session) for a match.
 *
 * Dependency direction is one-way: TournamentModule -> GameModule.
 */
@Injectable()
export class TournamentGameService implements OnModuleInit {
  private readonly logger = new Logger(TournamentGameService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly gameService: GameService,
    private readonly bracket: TournamentBracketService,
  ) {}

  onModuleInit(): void {
    this.gameService.onGameConcluded((event) => this.handleGameConcluded(event));
  }

  /**
   * Starts the first game of a SCHEDULED match in its own transaction.
   * The check-in flow (#161) uses createMatchGame + startSession instead.
   */
  async startMatchGame(
    tournamentId: string,
    matchId: string,
  ): Promise<TournamentGameCreated> {
    const created = await this.prisma.$transaction((tx) =>
      this.createMatchGame(tx, tournamentId, matchId),
    );
    this.startSession(created);
    return created;
  }

  /**
   * Inside the caller's transaction: creates game 1 of a SCHEDULED match,
   * player1 (better seed in Round 1) plays White, and moves the match to
   * IN_PROGRESS. Call startSession(result) only after the transaction commits.
   */
  async createMatchGame(
    tx: Prisma.TransactionClient,
    tournamentId: string,
    matchId: string,
  ): Promise<TournamentGameCreated> {
    const match = await tx.tournamentMatch.findUnique({ where: { id: matchId } });
    if (!match || match.tournamentId !== tournamentId) {
      throw new NotFoundException(
        `Match ${matchId} not found in tournament ${tournamentId}.`,
      );
    }
    if (!match.player1Id || !match.player2Id) {
      throw new ConflictException(
        `Match ${matchId} does not have both players assigned yet.`,
      );
    }
    return this.createMatchGameRow(tx, tournamentId, matchId, {
      whitePlayerId: match.player1Id,
      blackPlayerId: match.player2Id,
      allowedStatuses: ['SCHEDULED'],
    });
  }

  /**
   * Conclusion listener. Errors are logged by GameService; ConflictException
   * means the result was already applied (or the match is no longer open)
   * and is logged here as a no-op.
   */
  async handleGameConcluded(event: GameConclusionEvent): Promise<void> {
    const game = await this.prisma.game.findUnique({
      where: { id: event.gameId },
      select: { tournamentId: true, tournamentMatchId: true },
    });
    if (!game?.tournamentId || !game.tournamentMatchId) {
      return; // Not a tournament game.
    }
    const tournamentId = game.tournamentId;
    const matchId = game.tournamentMatchId;

    if (event.result === 'ABORTED') {
      this.logger.warn(
        `Tournament game ${event.gameId} (match ${matchId}) was aborted; bracket unchanged.`,
      );
      return;
    }

    let replay: TournamentGameCreated | null = null;
    try {
      replay = await this.prisma.$transaction(async (tx) => {
        if (event.endReason === 'ABANDONMENT') {
          // No-show / abandonment is a forfeit, not a played result.
          if (event.result === 'DRAW') {
            // Nobody showed up: both lose, nobody advances.
            await this.bracket.handleDoubleForfeit(tx, tournamentId, matchId);
          } else {
            const forfeitedUserId =
              event.result === 'WHITE_WON' ? event.blackPlayerId : event.whitePlayerId;
            await this.bracket.handleWalkover(tx, tournamentId, matchId, forfeitedUserId);
          }
          return null;
        }

        if (event.result === 'DRAW') {
          const draw = await this.bracket.handleMatchDraw(tx, tournamentId, matchId);
          if (draw.action !== 'REPLAY') {
            return null;
          }
          // Replay with colors swapped relative to the game that just ended.
          return this.createMatchGameRow(tx, tournamentId, matchId, {
            whitePlayerId: event.blackPlayerId,
            blackPlayerId: event.whitePlayerId,
            allowedStatuses: ['IN_PROGRESS'],
          });
        }

        const winnerId =
          event.result === 'WHITE_WON' ? event.whitePlayerId : event.blackPlayerId;
        await this.bracket.advanceWinner(tx, tournamentId, matchId, winnerId);
        return null;
      });
    } catch (error) {
      if (error instanceof ConflictException) {
        this.logger.warn(
          `Tournament game ${event.gameId}: result not applied to match ${matchId} (${error.message}).`,
        );
        return;
      }
      throw error;
    }

    if (replay) {
      this.startSession(replay);
    }
  }

  /**
   * Inserts an IN_PROGRESS `games` row linked to the match and moves the match
   * to IN_PROGRESS. The partial unique index `games_tournament_match_active_key`
   * guarantees at most one live game per match.
   */
  private async createMatchGameRow(
    tx: Prisma.TransactionClient,
    tournamentId: string,
    matchId: string,
    opts: {
      whitePlayerId: string;
      blackPlayerId: string;
      allowedStatuses: string[];
    },
  ): Promise<TournamentGameCreated> {
    const moved = await tx.tournamentMatch.updateMany({
      where: {
        id: matchId,
        tournamentId,
        status: { in: opts.allowedStatuses },
      },
      data: { status: 'IN_PROGRESS' },
    });
    if (moved.count !== 1) {
      throw new ConflictException(
        `Match ${matchId} cannot start a game from its current status.`,
      );
    }

    const [white, black] = await Promise.all([
      tx.user.findUnique({ where: { id: opts.whitePlayerId }, select: { rating: true } }),
      tx.user.findUnique({ where: { id: opts.blackPlayerId }, select: { rating: true } }),
    ]);
    if (!white || !black) {
      throw new NotFoundException(`Player row missing for match ${matchId}.`);
    }

    const gameId = randomUUID();
    try {
      await tx.game.create({
        data: {
          id: gameId,
          whiteId: opts.whitePlayerId,
          blackId: opts.blackPlayerId,
          whiteRating: white.rating,
          blackRating: black.rating,
          result: 'IN_PROGRESS',
          tournamentId,
          tournamentMatchId: matchId,
        },
      });
    } catch (error) {
      if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === 'P2002'
      ) {
        throw new ConflictException(`Match ${matchId} already has a live game.`);
      }
      throw error;
    }

    return {
      gameId,
      tournamentId,
      tournamentMatchId: matchId,
      whitePlayerId: opts.whitePlayerId,
      blackPlayerId: opts.blackPlayerId,
    };
  }

  /** Creates the in-memory session; call only after the DB transaction committed. */
  startSession(created: TournamentGameCreated): void {
    this.gameService.createGame({
      gameId: created.gameId,
      whitePlayerId: created.whitePlayerId,
      blackPlayerId: created.blackPlayerId,
    });
    this.logger.log(
      `Started tournament game ${created.gameId} for match ${created.tournamentMatchId}: ` +
        `White(${created.whitePlayerId}) vs Black(${created.blackPlayerId})`,
    );
  }
}
