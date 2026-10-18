import {
  Injectable,
  Logger,
  ConflictException,
  BadRequestException,
  NotFoundException,
} from '@nestjs/common';
import { Chess } from 'chess.js';
import {
  CreateGameOptions,
  GameSession,
  PendingMoveRecord,
  PublicGameState,
} from './types/chess.types';

//Default time control: 10 minutes (600,000 ms) per player.
const DEFAULT_INITIAL_TIME_MS = 10 * 60 * 1000;

@Injectable()
export class GameService
{
    private readonly logger = new Logger(GameService.name);
    /**
   * HOT PATH STORAGE: Active matches currently being played in server RAM.
   * Key: gameId, Value: GameSession.
   */
    private readonly activeGames = new Map<string, GameSession>();
    /**
   * COLD PATH BUFFER: Verified moves awaiting asynchronous database persistence.
   * Once persisted by the background worker, items are shifted (deleted) from this array.
   */
    private readonly pendingMovesQueue: PendingMoveRecord[] = [];
    private isFlushingQueue = false;
    public createGame(options: CreateGameOptions): PublicGameState {
    const {
      gameId,
      whitePlayerId,
      blackPlayerId,
      initialTimeMs = DEFAULT_INITIAL_TIME_MS,
      timeControl = null,
      initialFen,
    } = options;

    if (!gameId || !whitePlayerId || !blackPlayerId)
    {
      throw new BadRequestException(
        'gameId, whitePlayerId, and blackPlayerId are strictly required.',
      );
    }
    if (whitePlayerId === blackPlayerId) {
      throw new BadRequestException(
        'White and Black player IDs cannot be identical in an authoritative match.',
      );
    }
    if (this.activeGames.has(gameId)) {
      throw new ConflictException(
        `Game session with ID "${gameId}" already exists in memory.`,
      );
    }
    // Initialize chess.js engine (throws if custom initialFen is invalid)
    let engine: Chess;
    try {
      engine = initialFen ? new Chess(initialFen) : new Chess();
    } catch (error) {
      throw new BadRequestException(
        `Invalid initial FEN string provided: ${(error as Error).message}`,
      );
    }
    const now = Date.now();
    const session: GameSession = {
      gameId,
      engine,
      whitePlayerId,
      blackPlayerId,
      whiteTimeRemainingMs: initialTimeMs,
      blackTimeRemainingMs: initialTimeMs,
      timeControl,
      lastMoveTimestamp: now,
      plyCount: 0,
      isFinished: false,
      winnerColor: null,
      gameOverReason: null,
      createdAt: now,
    };
    this.activeGames.set(gameId, session);
    this.logger.log(
      `Created in-memory game session [${gameId}]: White(${whitePlayerId}) vs Black(${blackPlayerId})`,
    );

    return this.toPublicState(session);
    }
    //Internal lookup returning the mutable GameSession reference for engine tasks (#114-#118).
    public getGameSession(gameId: string): GameSession | undefined {
      return this.activeGames.get(gameId);
    }
    //INTEGRATION - EXPOSED API for @piomam21 (Online Gameplay #92 / Room & Reconnection #121)
    public getPublicGameState(gameId: string): PublicGameState {
    const session = this.activeGames.get(gameId);
    if (!session) {
      throw new NotFoundException(
        `Active game session "${gameId}" not found in memory.`,
      );
    }
    return this.toPublicState(session);
  }
  public hasActiveGame(gameId: string): boolean {
    return this.activeGames.has(gameId);
  }
  public getActiveGamesCount(): number {
    return this.activeGames.size;
  }
  //Enqueues a verified move into the Cold-Path buffer and triggers non-blocking persistence.
  public enqueueMoveForPersistence(moveRecord: PendingMoveRecord): void {
    this.pendingMovesQueue.push(moveRecord);
  // Fire-and-forget asynchronous flush: does NOT block the WebSocket event loop
  void this.flushPendingMoves();
  }
  //Asynchronous Cold-Path worker that drains the pendingMovesQueue,
  //writes records to PostgreSQL, and deletes them from RAM.
  public async flushPendingMoves(): Promise<void> {
    if (this.isFlushingQueue || this.pendingMovesQueue.length === 0) {
      return;
    }

    this.isFlushingQueue = true;

    try {
      while (this.pendingMovesQueue.length > 0) {
        // Peek at the oldest move in the buffer
        const nextMove = this.pendingMovesQueue[0];

        // [INTEGRATION - HOOK for @tszyman (Database #64 / Move History #88)]
        // TODO: Inject PrismaService / MatchHistoryService and persist `nextMove` here.
        // Example: await this.prismaService.move.create({ data: nextMove });
        await this.persistSingleMoveStub(nextMove);

        // Remove the move from RAM immediately after successful DB confirmation
        this.pendingMovesQueue.shift();
      }
    } catch (error) {
      this.logger.error(
        `Failed to flush pending move to database. Record retained in buffer for retry: ${(error as Error).message}`,
      );
    } finally {
      this.isFlushingQueue = false;
    }
  }
  //INTEGRATION - EXPOSED API for @piomam21 (#92) & Internal Game Over Pipeline (#117/#118)
  public async removeGame(gameId: string): Promise<boolean> {
    const session = this.activeGames.get(gameId);
    if (!session) {
      return false;
    }
  // Ensure any queued moves are flushed before freeing the session memory
  await this.flushPendingMoves();
  //INTEGRATION - HOOK for @tszyman (Saving played matches #87) & @Alaxea (Ranking #99)
  const deleted = this.activeGames.delete(gameId);
    if (deleted) {
      this.logger.log(`Purged game session [${gameId}] from server RAM.`);
    }
    return deleted;
  }
  //Maps internal mutable GameSession to a clean, read-only PublicGameState object.
  private toPublicState(session: GameSession): PublicGameState {
    return {
      gameId: session.gameId,
      fen: session.engine.fen(),
      turn: session.engine.turn(),
      whitePlayerId: session.whitePlayerId,
      blackPlayerId: session.blackPlayerId,
      whiteTimeRemainingMs: session.whiteTimeRemainingMs,
      blackTimeRemainingMs: session.blackTimeRemainingMs,
      timeControl: session.timeControl,
      plyCount: session.plyCount,
      moveNumber: Math.floor(session.plyCount / 2) + 1,
      isCheck: session.engine.inCheck(),
      isFinished: session.isFinished,
      winnerColor: session.winnerColor,
      gameOverReason: session.gameOverReason,
    };
  }
  //INTEGRATION - HOOK for @tszyman (Database #64 / Move History #88)]
  //Temporary asynchronous stub simulating database write until Prisma schema for moves is merged.
  private async persistSingleMoveStub(_move: PendingMoveRecord): Promise<void> {
    return Promise.resolve();
  }
}

