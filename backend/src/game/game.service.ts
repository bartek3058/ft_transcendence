import {
  Injectable,
  Logger,
  ConflictException,
  BadRequestException,
  NotFoundException,
  Optional,
  OnApplicationBootstrap,
  OnModuleDestroy,
  UnauthorizedException,
} from '@nestjs/common';
import { Chess } from 'chess.js';
import { AI_BOT_USER_ID } from '../ai/ai.constants';
import { SafeAccount } from '../auth/auth.repository';
import { MakeMoveDto } from './dto/make-move.dto';
import { SessionService } from '../auth/session.service';
import { PrismaService } from '../database/prisma.service';
import { RatingService } from '../rating/rating.service';
import {
  classifyPersistenceError,
  computeBackoffMs,
  DeadLetterMove,
  describeError,
  MOVE_PERSISTENCE_CONFIG,
  toGameMoveCreateInput,
} from './move-persistence';
import {
  CreateGameOptions,
  DatabaseGameResult,
  DatabaseMoveColor,
  DRAW_REASONS,
  GameConclusion,
  GameConclusionEvent,
  GameConclusionListener,
  GameOverReason,
  PersistedGameConclusion,
  GameSession,
  PendingMoveRecord,
  PublicGameState,
  MoveAuthorizationResult,
  MoveExecutionResult,
  PlayerColor,
  SERVER_RESTART_REASON,
} from './types/chess.types';

//Default time control: 10 minutes (600,000 ms) per player.
const DEFAULT_INITIAL_TIME_MS = 10 * 60 * 1000;

// games.id is a UUID column, check the format first so a bad id never hits Postgres (22P02)
const UUID_REGEX =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

@Injectable()
export class GameService implements OnApplicationBootstrap, OnModuleDestroy
{
    private readonly logger = new Logger(GameService.name);
    /*
    HOT PATH STORAGE: Active matches currently being played in server RAM.
    Key: gameId, Value: GameSession.
    */
    private readonly activeGames = new Map<string, GameSession>();
    /*
    COLD PATH BUFFER: Verified moves awaiting asynchronous database persistence.
    Once persisted by the background worker, items are shifted (deleted) from this array.
    */
    private readonly pendingMovesQueue: PendingMoveRecord[] = [];
    private isFlushingQueue = false;
    // guards against two removeGame() calls for the same game
    private readonly concludingGames = new Set<string>();
    // moves Postgres rejected for good, kept for debugging
    private readonly deadLetterMoves: DeadLetterMove[] = [];
    private flushPromise: Promise<void> | null = null;
    private flushTimer: NodeJS.Timeout | null = null;
    private retryTimer: NodeJS.Timeout | null = null;
    private consecutiveFailures = 0;
    private queueCapWarned = false;
    private missingPrismaWarned = false;
    private readonly conclusionListeners: GameConclusionListener[] = [];
    async getGamePlayerDetails(gameId: string) {
      const game = await this.prisma.game.findUnique({
        where: { id: gameId },
        select: {
          whiteRating: true,
          blackRating: true,
          whitePlayer: {
            select: { username: true },
          },
          blackPlayer: {
            select: { username: true },
          },
        },
      });

      return {
        whiteUsername: game?.whitePlayer?.username ?? null,
        blackUsername: game?.blackPlayer?.username ?? null,
        whiteRating: game?.whiteRating ?? null,
        blackRating: game?.blackRating ?? null,
      };
    }

    constructor(
      private readonly prisma: PrismaService,
      private readonly ratingService: RatingService,
      @Optional() private readonly sessionService?: SessionService,
    ) {}

  // Bring back games lost by a restart (#76). Never blocks the boot.
  public async onApplicationBootstrap(): Promise<void> {
    try {
      await this.recoverInterruptedGames();
    } catch (error) {
      this.logger.error(
        `Could not recover games interrupted by a restart: ${(error as Error).message}`,
      );
    }
  }

  /* Tournament games are handled by TournamentRecoveryService, AI games get aborted,
  casual games are replayed from game_moves. Clock of the side to move restarts at boot.*/
  public async recoverInterruptedGames(): Promise<{ restored: number; aborted: number; concluded: number }> {
    const summary = { restored: 0, aborted: 0, concluded: 0 };
    if (!this.prisma) return summary;

    const { count } = await this.prisma.game.updateMany({
      where: {
        result: 'IN_PROGRESS',
        tournamentMatchId: null,
        OR: [{ whiteId: AI_BOT_USER_ID }, { blackId: AI_BOT_USER_ID }],
      },
      data: { result: 'ABORTED', endReason: SERVER_RESTART_REASON, gameEnd: new Date() },
    });
    if (count) this.logger.warn(`Aborted ${count} AI game(s) interrupted by a restart.`);
    summary.aborted += count;

    const games = await this.prisma.game.findMany({
      where: { result: 'IN_PROGRESS', tournamentMatchId: null },
      select: {
        id: true,
        whiteId: true,
        blackId: true,
        timeControl: true,
        gameStart: true,
        moves: {
          orderBy: { ply: 'asc' },
          select: { ply: true, color: true, uci: true, timeRemainingMs: true },
        },
      },
    });

    const now = Date.now();
    for (const game of games) {
      if (this.activeGames.has(game.id)) continue;
      const session = this.rebuildSession(game, now);
      if (!session) {
        if (await this.abortInterruptedGame(game.id)) summary.aborted++;
        continue;
      }
      this.activeGames.set(game.id, session);
      if (session.isFinished) {
        // last move was saved but the result wasn't
        if (await this.removeGame(game.id)) summary.concluded++;
        continue;
      }
      summary.restored++;
      this.logger.log(
        `Restored game session [${game.id}] after restart at ply ${session.plyCount}.`,
      );
    }
    return summary;
  }

  // null when the saved history doesn't replay cleanly
  private rebuildSession(
    game: {
      id: string;
      whiteId: string | null;
      blackId: string | null;
      timeControl: string | null;
      gameStart: Date;
      moves: { ply: number; color: string; uci: string; timeRemainingMs: number | null }[];
    },
    now: number,
  ): GameSession | null {
    if (!game.whiteId || !game.blackId || game.whiteId === game.blackId) {
      this.logger.warn(`Game [${game.id}] has no valid player pair; cannot restore it.`);
      return null;
    }
    const engine = new Chess();
    let whiteTimeRemainingMs = DEFAULT_INITIAL_TIME_MS;
    let blackTimeRemainingMs = DEFAULT_INITIAL_TIME_MS;

    for (const [index, move] of game.moves.entries()) {
      const expectedColor: DatabaseMoveColor = index % 2 === 0 ? 'WHITE' : 'BLACK';
      if (move.ply !== index + 1 || move.color !== expectedColor) {
        this.logger.warn(`Game [${game.id}] has a gap at ply ${index + 1}; cannot restore it.`);
        return null;
      }
      try {
        engine.move({
          from: move.uci.slice(0, 2),
          to: move.uci.slice(2, 4),
          ...(move.uci.length > 4 ? { promotion: move.uci.slice(4) } : {}),
        });
      } catch {
        this.logger.warn(`Game [${game.id}] has an unplayable move at ply ${move.ply}; cannot restore it.`);
        return null;
      }
      if (move.timeRemainingMs !== null) {
        if (expectedColor === 'WHITE') whiteTimeRemainingMs = move.timeRemainingMs;
        else blackTimeRemainingMs = move.timeRemainingMs;
      }
    }

    const session: GameSession = {
      gameId: game.id,
      engine,
      whitePlayerId: game.whiteId,
      blackPlayerId: game.blackId,
      whiteTimeRemainingMs,
      blackTimeRemainingMs,
      timeControl: game.timeControl,
      lastMoveTimestamp: now,
      plyCount: game.moves.length,
      isFinished: false,
      winnerColor: null,
      gameOverReason: null,
      createdAt: game.gameStart.getTime(),
    };
    if (session.plyCount > 0) {
      this.evaluateGameOverState(session, session.plyCount % 2 === 1 ? 'w' : 'b');
    }
    return session;
  }

  private async abortInterruptedGame(gameId: string): Promise<boolean> {
    const { count } = await this.prisma.game.updateMany({
      where: { id: gameId, result: 'IN_PROGRESS' },
      data: { result: 'ABORTED', endReason: SERVER_RESTART_REASON, gameEnd: new Date() },
    });
    if (count === 1) this.logger.warn(`Aborted game [${gameId}]: it could not be restored after a restart.`);
    return count === 1;
  }
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

    public findActiveGameForPlayer(userId: string): string | null {
      for (const session of this.activeGames.values()) {
        if (!session.isFinished &&
            (session.whitePlayerId === userId || session.blackPlayerId === userId)) {
          return session.gameId;
        }
      }
      return null;
    }
    // Called once per game after removeGame() saved the result.
    public onGameConcluded(listener: GameConclusionListener): void {
      this.conclusionListeners.push(listener);
    }

    /** Returns only the final result of a persisted game to one of its players. */
    public async getFinishedGameForPlayer(gameId: string, userId: string) {
      if (!UUID_REGEX.test(gameId)) return null;
      const record = await this.prisma.game.findFirst({
        where: {
          id: gameId,
          result: { not: 'IN_PROGRESS' },
          OR: [{ whiteId: userId }, { blackId: userId }],
        },
        select: { id: true, result: true, endReason: true },
      });
      if (!record) return null;
      return {
        gameId: record.id,
        winnerColor: record.result === 'WHITE_WON' ? 'w'
          : record.result === 'BLACK_WON' ? 'b' : null,
        reason: record.endReason,
        result: record.result,
      };
    }

    public getActiveGameIds(): string[] {
      return [...this.activeGames.keys()];
    }

    public getClockSnapshot(gameId: string, now = Date.now()) {
      const session = this.activeGames.get(gameId);
      if (!session) return null;
      const elapsed = session.isFinished || session.plyCount === 0
        ? 0 : Math.max(0, now - session.lastMoveTimestamp);
      return {
        gameId,
        whiteTimeRemainingMs: Math.max(0, session.whiteTimeRemainingMs - (session.engine.turn() === 'w' ? elapsed : 0)),
        blackTimeRemainingMs: Math.max(0, session.blackTimeRemainingMs - (session.engine.turn() === 'b' ? elapsed : 0)),
        turn: session.engine.turn(),
        plyCount: session.plyCount,
        isFinished: session.isFinished,
      };
    }

    public checkGameTimeout(gameId: string, now = Date.now()): boolean {
      const session = this.activeGames.get(gameId);
      if (!session || session.isFinished || session.plyCount === 0) return false;
      const turn = session.engine.turn();
      const remaining = turn === 'w' ? session.whiteTimeRemainingMs : session.blackTimeRemainingMs;
      if (remaining > Math.max(0, now - session.lastMoveTimestamp)) return false;
      if (turn === 'w') session.whiteTimeRemainingMs = 0;
      else session.blackTimeRemainingMs = 0;
      session.lastMoveTimestamp = now;
      session.isFinished = true;
      session.gameOverReason = 'TIMEOUT';
      session.winnerColor = turn === 'w' ? 'b' : 'w';
      this.logger.log(`Game [${gameId}] ended by TIMEOUT.`);
      return true;
    }

    //Internal lookup returning the mutable GameSession reference for engine tasks (#114-#118).
    public getGameSession(gameId: string): GameSession | undefined {
      return this.activeGames.get(gameId);
    }
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
  public enqueueMoveForPersistence(moveRecord: PendingMoveRecord): void {
    this.pendingMovesQueue.push(moveRecord);

    // never drop moves, just complain loudly
    if (this.pendingMovesQueue.length > MOVE_PERSISTENCE_CONFIG.maxQueueSize) {
      if (!this.queueCapWarned) {
        this.queueCapWarned = true;
        this.logger.error(
          `Pending move buffer exceeded ${MOVE_PERSISTENCE_CONFIG.maxQueueSize} records. Database persistence is falling behind or unavailable.`,
        );
      }
    } else {
      this.queueCapWarned = false;
    }

    // not awaited on purpose, sockets shouldn't wait for the DB
    this.scheduleFlush();
  }

  public getPendingMovesCount(): number {
    return this.pendingMovesQueue.length;
  }

  public getDeadLetterMoves(): readonly DeadLetterMove[] {
    return this.deadLetterMoves;
  }

  // debounced, so moves arriving together go in one INSERT
  private scheduleFlush(): void {
    if (!this.prisma) {
      if (!this.missingPrismaWarned) {
        this.missingPrismaWarned = true;
        this.logger.warn(
          'PrismaService is not injected: moves stay in the RAM buffer and are NOT persisted.',
        );
      }
      return;
    }
    // during backoff the retry timer decides when to flush
    if (this.retryTimer || this.flushPromise) {
      return;
    }
    if (this.pendingMovesQueue.length >= MOVE_PERSISTENCE_CONFIG.batchSize) {
      this.clearFlushTimer();
      void this.flushPendingMoves();
      return;
    }
    if (this.flushTimer) {
      return;
    }
    this.flushTimer = setTimeout(() => {
      this.flushTimer = null;
      void this.flushPendingMoves();
    }, MOVE_PERSISTENCE_CONFIG.flushDelayMs);
    this.flushTimer.unref();
  }

  private clearFlushTimer(): void {
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
  }

  private clearRetryTimer(): void {
    if (this.retryTimer) {
      clearTimeout(this.retryTimer);
      this.retryTimer = null;
    }
  }

  // Concurrent callers share the same flush.
  public flushPendingMoves(): Promise<void> {
    if (!this.prisma || this.pendingMovesQueue.length === 0) {
      return this.flushPromise ?? Promise.resolve();
    }
    if (!this.flushPromise) {
      this.clearFlushTimer();
      this.flushPromise = this.drainQueue().finally(() => {
        this.flushPromise = null;
        // a move added while the flush was finishing
        if (this.pendingMovesQueue.length > 0 && !this.retryTimer) {
          this.scheduleFlush();
        }
      });
    }
    return this.flushPromise;
  }

  private async drainQueue(): Promise<void> {
    while (this.pendingMovesQueue.length > 0) {
      const batch = this.pendingMovesQueue.slice(0, MOVE_PERSISTENCE_CONFIG.batchSize);
      const completed = await this.persistBatch(batch);
      if (!completed) {
        this.scheduleRetry();
        return;
      }
      this.consecutiveFailures = 0;
    }
  }

  // false = transient error, records stay at the head of the queue for a retry.
  // Only removes from the head, so [0, n) is always the batch just written.
  private async persistBatch(batch: PendingMoveRecord[]): Promise<boolean> {
    try {
      await this.prisma!.gameMove.createMany({
        data: batch.map(toGameMoveCreateInput),
        // a retry after a lost ack must not fail on UNIQUE(game_id, ply)
        skipDuplicates: true,
      });
      this.pendingMovesQueue.splice(0, batch.length);
      return true;
    } catch (error) {
      if (classifyPersistenceError(error) === 'transient') {
        this.consecutiveFailures += 1;
        this.logger.error(
          `Transient failure persisting ${batch.length} move(s); retrying with backoff (attempt ${this.consecutiveFailures}): ${describeError(error)}`,
        );
        return false;
      }
      this.logger.warn(
        `Batch of ${batch.length} move(s) rejected permanently (${describeError(error)}). Isolating the bad record(s).`,
      );
      return this.persistRowByRow(batch);
    }
  }
  // one bad move shouldn't block the rest of the batch
  private async persistRowByRow(batch: PendingMoveRecord[]): Promise<boolean> {
    for (const record of batch) {
      try {
        await this.prisma!.gameMove.createMany({
          data: [toGameMoveCreateInput(record)],
          skipDuplicates: true,
        });
        this.pendingMovesQueue.shift();
      } catch (error) {
        if (classifyPersistenceError(error) === 'transient') {
          this.consecutiveFailures += 1;
          this.logger.error(
            `Transient failure while isolating move [${record.gameId}#${record.ply}]; retrying with backoff: ${describeError(error)}`,
          );
          return false;
        }
        this.deadLetter(record, error);
        this.pendingMovesQueue.shift();
      }
    }
    return true;
  }

  private deadLetter(record: PendingMoveRecord, error: unknown): void {
    this.logger.error(
      `Dead-lettered move [game ${record.gameId}, ply ${record.ply}, ${record.san}]: ${describeError(error)}`,
    );
    this.deadLetterMoves.push({
      record,
      reason: describeError(error),
      failedAt: new Date(),
    });
    if (this.deadLetterMoves.length > MOVE_PERSISTENCE_CONFIG.maxDeadLetters) {
      this.deadLetterMoves.shift();
    }
  }

  private scheduleRetry(): void {
    if (this.retryTimer) {
      return;
    }
    const delay = computeBackoffMs(this.consecutiveFailures);
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      void this.flushPendingMoves();
    }, delay);
    this.retryTimer.unref();
  }

  private hasPendingMovesFor(gameId: string): boolean {
    return this.pendingMovesQueue.some((m) => m.gameId === gameId);
  }

  // Returns false on timeout, the moves stay buffered and keep retrying.
  private async waitForPersistence(
    timeoutMs: number,
    gameId?: string,
  ): Promise<boolean> {
    if (!this.prisma) {
      return false;
    }
    const pending = () =>
      gameId ? this.hasPendingMovesFor(gameId) : this.pendingMovesQueue.length > 0;
    const deadline = Date.now() + timeoutMs;
    while (pending()) {
      this.clearRetryTimer();
      await this.flushPendingMoves();
      if (!pending()) {
        break;
      }
      if (Date.now() >= deadline) {
        return false;
      }
      this.clearRetryTimer(); // drainQueue armed one; this loop drives retries now
      await new Promise<void>((resolve) => setTimeout(resolve, 200));
    }
    return true;
  }

  // Saves the result, rates the game and drops the session (#143).
  // If the save fails, the frozen session stays and it returns false, so the caller can retry.
  public async removeGame(
    gameId: string,
    conclusion?: GameConclusion,
  ): Promise<boolean> {
    const session = this.activeGames.get(gameId);
    if (!session) {
      return false;
    }
    if (this.concludingGames.has(gameId)) {
      this.logger.warn(`removeGame: game [${gameId}] is already being concluded, ignoring duplicate call.`);
      return false;
    }
    this.concludingGames.add(gameId);

    try {
      const final = this.resolveConclusion(session, conclusion);
      // freeze first so no more moves get in
      session.isFinished = true;
      session.winnerColor = final.winnerColor;
      session.gameOverReason = final.endReason;

      // all moves must be saved before the game is closed and rated
      const movesPersisted = await this.waitForPersistence(
        MOVE_PERSISTENCE_CONFIG.removeGameWaitMs,
        gameId,
      );
      if (!movesPersisted && this.prisma) {
        this.logger.error(
          `Game [${gameId}] concluded while some moves are still unpersisted; they remain buffered for retry.`,
        );
      }

      // save the result (#87), rating runs after (#99)
      const concluded = await this.persistGameConclusion(gameId, final);
      if (!concluded) {
        this.logger.error(`Could not persist conclusion of game [${gameId}]; retaining session for retry.`);
        return false;
      }
      await this.triggerRatingUpdate(gameId);
	  await this.notifyConclusionListeners({
		gameId,
		result: final.result,
		endReason: final.endReason,
		whitePlayerId: session.whitePlayerId,
		blackPlayerId: session.blackPlayerId,
    	});
      const deleted = this.activeGames.delete(gameId);
      if (deleted) {
        this.logger.log(`Purged game session [${gameId}] from server RAM.`);
      }
      return deleted;
    } catch (error) {
      this.logger.error(
        `Failed to persist conclusion of game [${gameId}]. Session kept in RAM for retry: ${(error as Error).message}`,
      );
      return false;
    } finally {
      // release only after the purge, so a duplicate call can't slip in
      this.concludingGames.delete(gameId);
    }
  }

  // explicit conclusion > finished session > board position > ABORTED
  private resolveConclusion(
    session: GameSession,
    conclusion?: GameConclusion,
  ): PersistedGameConclusion {
    if (conclusion) {
      return this.toPersistedConclusion(conclusion.winnerColor, conclusion.gameOverReason);
    }
    if (session.isFinished && session.gameOverReason) {
      return this.toPersistedConclusion(session.winnerColor, session.gameOverReason);
    }

    const engine = session.engine;
    if (engine.isCheckmate()) {
      // side to move is the one mated
      return this.toPersistedConclusion(engine.turn() === 'w' ? 'b' : 'w', 'CHECKMATE');
    }
    const drawReason = this.detectDrawReason(engine);
    if (drawReason) {
      return this.toPersistedConclusion(null, drawReason);
    }

    return { result: 'ABORTED', endReason: null, winnerColor: null };
  }

  private detectDrawReason(engine: Chess): GameOverReason | null {
    if (engine.isStalemate()) return 'STALEMATE';
    if (engine.isInsufficientMaterial()) return 'INSUFFICIENT_MATERIAL';
    if (engine.isThreefoldRepetition()) return 'THREEFOLD_REPETITION';
    if (engine.isDraw()) return 'FIFTY_MOVE_RULE'; // remaining isDraw() case in chess.js
    return null;
  }

  private toPersistedConclusion(
    winnerColor: PlayerColor | null,
    reason: GameOverReason,
  ): PersistedGameConclusion {
    // draws never have a winner
    const winner = DRAW_REASONS.includes(reason) ? null : winnerColor;
    if (winner === 'w') return { result: 'WHITE_WON', endReason: reason, winnerColor: 'w' };
    if (winner === 'b') return { result: 'BLACK_WON', endReason: reason, winnerColor: 'b' };
    return { result: 'DRAW', endReason: reason, winnerColor: null };
  }

  // Only touches an IN_PROGRESS row, so the rating can't fire twice for one game.
  private async persistGameConclusion(
    gameId: string,
    final: PersistedGameConclusion,
  ): Promise<boolean> {
    if (!UUID_REGEX.test(gameId)) {
      this.logger.warn(`Game [${gameId}] has no UUID id, so it has no \`games\` row. Result not persisted.`);
      return false;
    }
    if (!this.prisma) {
      this.logger.warn(`PrismaService is not injected: result of game [${gameId}] not persisted.`);
      return false;
    }

    const { count } = await this.prisma.game.updateMany({
      where: { id: gameId, result: 'IN_PROGRESS' },
      data: {
        result: final.result,
        endReason: final.endReason,
        gameEnd: new Date(),
      },
    });

    if (count !== 1) {
      this.logger.warn(
        `Game [${gameId}] has no IN_PROGRESS row in \`games\` (missing or already concluded). Result not persisted.`,
      );
      return false;
    }
    this.logger.log(
      `Persisted conclusion of game [${gameId}]: ${final.result} (${final.endReason ?? 'no reason'}).`,
    );
    return true;
  }

  // Result is already saved and applyGameResult skips rated games, so just log a failure.
  private async triggerRatingUpdate(gameId: string): Promise<void> {
    try {
      await this.ratingService.applyGameResult(gameId);
    } catch (error) {
      this.logger.error(
        `Rating update failed for game [${gameId}] (result is saved, rating can be re-applied): ${(error as Error).message}`,
      );
    }
  }

  private async notifyConclusionListeners(event: GameConclusionEvent): Promise<void> {
    for (const listener of this.conclusionListeners) {
      try {
        await listener(event);
      } catch (error) {
        this.logger.error(
          `Game conclusion listener failed for game [${event.gameId}]: ${(error as Error).message}`,
        );
      }
    }
  }

  // flush what's left on shutdown
  public async onModuleDestroy(): Promise<void> {
    this.clearFlushTimer();
    this.clearRetryTimer();
    const drained = await this.waitForPersistence(MOVE_PERSISTENCE_CONFIG.shutdownWaitMs);
    if (!drained && this.prisma) {
      this.logger.error(
        `Shutdown with ${this.pendingMovesQueue.length} unpersisted move(s) still in the buffer.`,
      );
    }
    this.clearRetryTimer();
  }

  public verifyAndResyncState(
    gameId: string,
    clientFen?: string,
  ): { synchronized: boolean; state: PublicGameState } {
    const session = this.activeGames.get(gameId);
    if (!session) {
      throw new NotFoundException(
        `Active game session "${gameId}" not found in memory.`,
      );
    }

    const authoritativeFen = session.engine.fen();
    const synchronized =
      typeof clientFen === 'string' && clientFen.trim() === authoritativeFen;

    if (clientFen !== undefined && !synchronized) {
      this.logger.warn(
        `Client desynchronization detected in game [${gameId}]. Client FEN: "${clientFen}" vs Server FEN: "${authoritativeFen}". Sending correction.`,
      );
    }

    return {
      synchronized,
      state: this.toPublicState(session),
    };
  }

  private toDatabaseColor(color: PlayerColor): DatabaseMoveColor {
    return color === 'w' ? 'WHITE' : 'BLACK';
  }

  private evaluateGameOverState(
    session: GameSession,
    lastMoverColor: PlayerColor,
  ): void {
    if (!session.engine.isGameOver()) {
      return;
    }

    session.isFinished = true;

    if (session.engine.isCheckmate()) {
      session.gameOverReason = 'CHECKMATE';
      session.winnerColor = lastMoverColor;
    } else if (session.engine.isStalemate()) {
      session.gameOverReason = 'STALEMATE';
      session.winnerColor = null;
    } else if (session.engine.isThreefoldRepetition()) {
      session.gameOverReason = 'THREEFOLD_REPETITION';
      session.winnerColor = null;
    } else if (session.engine.isInsufficientMaterial()) {
      session.gameOverReason = 'INSUFFICIENT_MATERIAL';
      session.winnerColor = null;
    } else {
      session.gameOverReason = 'FIFTY_MOVE_RULE';
      session.winnerColor = null;
    }

    this.logger.log(
      `Game [${session.gameId}] finished on board. Reason: ${session.gameOverReason}, Winner: ${session.winnerColor ?? 'DRAW'}`,
    );
  }

  public resolveDatabaseGameResult(session: GameSession): DatabaseGameResult {
    if (!session.isFinished) {
      return 'IN_PROGRESS';
    }
    if (session.winnerColor === 'w') {
      return 'WHITE_WON';
    }
    if (session.winnerColor === 'b') {
      return 'BLACK_WON';
    }
    return 'DRAW';
  }

  //Maps internal mutable GameSession to a clean, read-only PublicGameState object.
  private toPublicState(session: GameSession): PublicGameState {
    return {
      gameId: session.gameId,
      fen: session.engine.fen(),
      moves: session.engine.history(),
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
  public authorizeMove(
    gameId: string,
    caller: SafeAccount | string | null | undefined,
  ): MoveAuthorizationResult {
    const session = this.activeGames.get(gameId);

    //verify the match exists in Hot-path RAM
    if (!session){
      this.logger.warn(
        `Move authorization failed: Game [${gameId}] not found in RAM.`,
      );
      return {
        authorized: false,
        rejectionResult: {
          success: false,
          currentFen: '',
          errorReason: 'GAME_NOT_FOUND',
        },
      };
    }
    const currentFen = session.engine.fen();

    const authenticatedUserId =
      typeof caller === 'string' ? caller.trim() : caller?.id; // if given string take string if not takie caller.id from SafeAccount

    if (!authenticatedUserId) {
      this.logger.warn(`Move authorization failed: Unauthenticated caller in game [${gameId}].`);
      return {
        authorized: false,
        rejectionResult: {
          success: false,
          currentFen,
          errorReason: 'UNAUTHENTICATED',
        },
      };
    }

    //verify the match has not already concluded
    if (session.isFinished){
      this.logger.warn(
        `Move authorization failed: Game [${gameId}] is already finished (User: ${authenticatedUserId}).`,
      );
      return {
        authorized: false,
        rejectionResult: {
          success: false,
          currentFen,
          errorReason: 'GAME_ALREADY_FINISHED',
          isGameOver: true,
          gameOverReason: session.gameOverReason,
          winnerColor: session.winnerColor,
        },
      };
    }

    //verify the user is actually one of the two seated players (not a spectator)
    const playerColor = this.getPlayerColor(session, authenticatedUserId);
    if (!playerColor) {
      this.logger.warn(
        `Move authorization failed: User [${authenticatedUserId}] is not a participant in game [${gameId}].`,
      );
      return {
        authorized: false,
        rejectionResult: {
          success: false,
          currentFen,
          errorReason: 'UNAUTHORIZED_PLAYER',
        },
      };
    }

    //Verify it is currently this player's turn to move
    const activeTurnColor = session.engine.turn();
    if (playerColor !== activeTurnColor) {
      this.logger.debug(
        `Move authorization failed: User [${authenticatedUserId}] (${playerColor}) attempted to move on ${activeTurnColor}'s turn in game [${gameId}].`,
      );
      return {
        authorized: false,
        rejectionResult: {
          success: false,
          currentFen,
          errorReason: 'NOT_YOUR_TURN',
        },
      };
    }

    return {
      authorized: true,
      session,
      playerColor,
      playerId: authenticatedUserId,
    };
  }

  public async authorizeMoveBySessionToken(
    gameId: string,
    sessionToken: string | null,
  ): Promise<MoveAuthorizationResult> {
    const session = this.activeGames.get(gameId);
    const fallbackFen = session ? session.engine.fen() : '';

    if (!this.sessionService) {
      throw new Error(
        'SessionService is not injected. Ensure AuthModule is imported in GameModule.',
      );
    }

    try {
      const account = await this.sessionService.authenticate(sessionToken);
      return this.authorizeMove(gameId, account);
    } catch (error) {
      if (error instanceof UnauthorizedException) {
        return {
          authorized: false,
          rejectionResult: {
            success: false,
            currentFen: fallbackFen,
            errorReason: 'UNAUTHENTICATED',
          },
        };
      }
      throw error;
    }
  }

  public executeMove(
    dto: MakeMoveDto,
    caller: SafeAccount | string | null | undefined,
  ): MoveExecutionResult{
    //Hot-Path Authorization (#114)
    const auth = this.authorizeMove(dto.gameId, caller);
    if (!auth.authorized || !auth.session || !auth.playerColor || !auth.playerId){
      return auth.rejectionResult!;
    }

    const { session, playerColor, playerId } = auth;
    const fenBeforeMove = session.engine.fen();
    // Check the server deadline BEFORE applying the move.
    if (this.checkGameTimeout(dto.gameId)) {
      return { success: false, currentFen: fenBeforeMove, errorReason: 'TIMEOUT',
        isGameOver: true, gameOverReason: 'TIMEOUT', winnerColor: session.winnerColor };
    }
    let moveObj: ReturnType<Chess['move']>;
    try {
      moveObj = session.engine.move({
        from: dto.from,
        to: dto.to,
        ...(dto.promotion ? { promotion: dto.promotion } : {}),
      });
    } catch (error) {
      this.logger.debug(
        `Illegal move rejected in game [${dto.gameId}] by user [${playerId}]: ${dto.from}->${dto.to} (${(error as Error).message})`,
      );
      return {
        success: false,
        currentFen: fenBeforeMove,
        errorReason: 'ILLEGAL_MOVE',
      };
    }
    if (!moveObj) {
      return {
        success: false,
        currentFen: fenBeforeMove,
        errorReason: 'ILLEGAL_MOVE',
      };
    }
    const now = Date.now();
    const timeSpentMs = session.plyCount === 0
      ? 0
      : Math.max(0, now - session.lastMoveTimestamp);
    if (playerColor === 'w') {
      session.whiteTimeRemainingMs = Math.max(0, session.whiteTimeRemainingMs - timeSpentMs);
    } else {
      session.blackTimeRemainingMs = Math.max(0, session.blackTimeRemainingMs - timeSpentMs);
    }
    session.lastMoveTimestamp = now;
    session.plyCount += 1;
    this.evaluateGameOverState(session, playerColor); // chceck that this move is game over

    const currentFen = session.engine.fen();
    const moveNumber = Math.ceil(session.plyCount / 2);
    const uci = `${moveObj.from}${moveObj.to}${moveObj.promotion ?? ''}`;
    const timeRemainingMs =
      playerColor === 'w'
        ? session.whiteTimeRemainingMs
        : session.blackTimeRemainingMs;
      
    const moveRecord: PendingMoveRecord = {
      gameId: session.gameId,
      ply: session.plyCount,
      moveNumber,
      color: this.toDatabaseColor(playerColor),
      playedById: playerId,
      san: moveObj.san,
      uci,
      fenAfter: currentFen,
      timeSpentMs,
      timeRemainingMs,
      createdAt: new Date(now),
    };
    this.enqueueMoveForPersistence(moveRecord);

    return {
      success: true,
      currentFen,
      san: moveObj.san,
      uci,
      plyCount: session.plyCount,
      moveNumber,
      isCheck: session.engine.inCheck(),
      isGameOver: session.engine.isGameOver(),
      gameOverReason: session.gameOverReason,
      winnerColor: session.winnerColor,
    };
  }
  public resignGame(
    gameId: string,
    caller: SafeAccount | string | null | undefined,
  ): MoveExecutionResult {
    const session = this.activeGames.get(gameId);
    if (!session) {
      return {
        success: false,
        currentFen: '',
        errorReason: 'GAME_NOT_FOUND',
      };
    }

    const currentFen = session.engine.fen();
    const authenticatedUserId =
      typeof caller === 'string' ? caller.trim() : caller?.id;

    if (!authenticatedUserId) {
      return {
        success: false,
        currentFen,
        errorReason: 'UNAUTHENTICATED',
      };
    }

    if (session.isFinished) {
      return {
        success: false,
        currentFen,
        errorReason: 'GAME_ALREADY_FINISHED',
        isGameOver: true,
        gameOverReason: session.gameOverReason,
        winnerColor: session.winnerColor,
      };
    }

    const resigningColor = this.getPlayerColor(session, authenticatedUserId);
    if (!resigningColor) {
      return {
        success: false,
        currentFen,
        errorReason: 'UNAUTHORIZED_PLAYER',
      };
    }

    session.isFinished = true;
    session.gameOverReason = 'RESIGNATION';
    session.winnerColor = resigningColor === 'w' ? 'b' : 'w';

    this.logger.log(
      `Game [${gameId}] ended by RESIGNATION. Winner: ${session.winnerColor} (User [${authenticatedUserId}] resigned).`,
    );

    return {
      success: true,
      currentFen,
      plyCount: session.plyCount,
      moveNumber: Math.ceil(session.plyCount / 2),
      isCheck: session.engine.inCheck(),
      isGameOver: true,
      gameOverReason: session.gameOverReason,
      winnerColor: session.winnerColor,
    };
  }

  public getPlayerColor(
    session: GameSession,
    userId: string,
  ): PlayerColor | null {
    if (!userId) {
      return null;
    }
    if (session.whitePlayerId === userId) {
      return 'w';
    }
    if (session.blackPlayerId === userId) {
      return 'b';
    }
    return null;
  }
}



