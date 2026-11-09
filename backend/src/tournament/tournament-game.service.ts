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
import { AdvanceWinnerResult, TournamentBracketService } from './tournament-bracket.service';
import { TournamentEventsPublisher } from './tournament-events.publisher';

export interface TournamentGameCreated {
  gameId: string;
  tournamentId: string;
  tournamentMatchId: string;
  whitePlayerId: string;
  blackPlayerId: string;
}

// Connects finished games to the bracket (#68). ABANDONMENT is a forfeit, with no winner
// both players lose. Only depends on GameModule, never the other way round.
@Injectable()
export class TournamentGameService implements OnModuleInit {
  private readonly logger = new Logger(TournamentGameService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly gameService: GameService,
    private readonly bracket: TournamentBracketService,
    private readonly events: TournamentEventsPublisher,
  ) {}

  onModuleInit(): void {
    this.gameService.onGameConcluded((event) => this.handleGameConcluded(event));
  }

  // The check-in flow (#161) uses createMatchGame + startSession instead.
  async startMatchGame(
    tournamentId: string,
    matchId: string,
  ): Promise<TournamentGameCreated> {
    const created = await this.prisma.$transaction((tx) =>
      this.createMatchGame(tx, tournamentId, matchId),
    );
    this.startSession(created);
    this.events.bracketChanged(tournamentId, [matchId], false);
    return created;
  }

  // Runs in the caller's transaction. Call startSession() only after commit.
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

  // ConflictException = result already applied, so it's a no-op.
  // Any other failure is picked up later by TournamentRecoveryService.
  async handleGameConcluded(event: GameConclusionEvent): Promise<void> {
    const game = await this.prisma.game.findUnique({
      where: { id: event.gameId },
      select: { tournamentId: true, tournamentMatchId: true },
    });
    if (!game?.tournamentId || !game.tournamentMatchId) {
      return; // Not a tournament game.
    }
    const matchId = game.tournamentMatchId;

    if (event.result === 'ABORTED') {
      // recovery sends the match back to check-in
      this.logger.warn(
        `Tournament game ${event.gameId} (match ${matchId}) was aborted; recovery will reopen check-in.`,
      );
      return;
    }

    try {
      await this.applyGameResult(game.tournamentId, matchId, event);
    } catch (error) {
      if (error instanceof ConflictException) {
        this.logger.warn(
          `Tournament game ${event.gameId}: result not applied to match ${matchId} (${error.message}).`,
        );
        return;
      }
      throw error;
    }
  }

  // Also used by TournamentRecoveryService. Applying a game twice throws ConflictException.
  async applyGameResult(tournamentId: string, matchId: string, event: GameConclusionEvent): Promise<void> {
    const { replay, advanced } = await this.prisma.$transaction(async (tx): Promise<{
      replay: TournamentGameCreated | null; advanced: AdvanceWinnerResult | null;
    }> => {
      if (event.endReason === 'ABANDONMENT') {
        // no-show / abandonment is a forfeit
        if (event.result === 'DRAW') {
          // nobody showed up, nobody advances
          return { replay: null, advanced: await this.bracket.handleDoubleForfeit(tx, tournamentId, matchId) };
        }
        const forfeitedUserId =
          event.result === 'WHITE_WON' ? event.blackPlayerId : event.whitePlayerId;
        return {
          replay: null,
          advanced: await this.bracket.handleWalkover(tx, tournamentId, matchId, forfeitedUserId),
        };
      }

      if (event.result === 'DRAW') {
        const draw = await this.bracket.handleMatchDraw(tx, tournamentId, matchId);
        if (draw.action !== 'REPLAY') {
          return { replay: null, advanced: draw.advanceResult ?? null };
        }
        // replay with colours swapped
        return {
          replay: await this.createMatchGameRow(tx, tournamentId, matchId, {
            whitePlayerId: event.blackPlayerId,
            blackPlayerId: event.whitePlayerId,
            allowedStatuses: ['IN_PROGRESS'],
          }),
          advanced: null,
        };
      }

      const winnerId =
        event.result === 'WHITE_WON' ? event.whitePlayerId : event.blackPlayerId;
      return { replay: null, advanced: await this.bracket.advanceWinner(tx, tournamentId, matchId, winnerId) };
    });

    if (replay) {
      this.startSession(replay);
    }
    // emit only after commit
    this.events.bracketChanged(tournamentId, advanced?.changedMatchIds ?? [matchId],
      advanced?.tournamentFinished ?? false);
  }

  // The partial unique index games_tournament_match_active_key allows one live game per match.
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

  // call only after the transaction committed
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
