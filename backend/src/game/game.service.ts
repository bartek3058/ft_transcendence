import {
  Injectable,
  Logger,
  ConflictException,
  BadRequestException,
  NotFoundException,
  Optional,
  UnauthorizedException,
} from '@nestjs/common';
import { Chess } from 'chess.js';
import { SafeAccount } from '../auth/auth.repository';
import { MakeMoveDto } from './dto/make-move.dto';
import { SessionService } from '../auth/session.service';
import { PrismaService } from '../database/prisma.service';
import { RatingService } from '../rating/rating.service';
import {
  CreateGameOptions,
  DatabaseMoveColor,
  DRAW_REASONS,
  GameConclusion,
  GameOverReason,
  PersistedGameConclusion,
  GameSession,
  PendingMoveRecord,
  PublicGameState,
  MoveAuthorizationResult,
  MoveExecutionResult,
  PlayerColor,
} from './types/chess.types';

//Default time control: 10 minutes (600,000 ms) per player.
const DEFAULT_INITIAL_TIME_MS = 10 * 60 * 1000;

// `games.id` is a PostgreSQL UUID column: check the format before any I/O so a malformed
// id never reaches the database (would otherwise raise 22P02 invalid_text_representation).
const UUID_REGEX =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

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
    // Game ids whose conclusion is currently being persisted (guards concurrent removeGame calls).
    private readonly concludingGames = new Set<string>();
    constructor(
      private readonly prisma: PrismaService,
      private readonly ratingService: RatingService,
      @Optional() private readonly sessionService?: SessionService,
    ) {}
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
  /**
   * [INTEGRATION - EXPOSED API for @piomam21 (#92) & Internal Game Over Pipeline (#117/#118)]
   * Concludes a match and frees its in-memory session (#143):
   *  1. Resolves the final result (explicit conclusion > session state > engine state > ABORTED).
   *  2. Freezes the session so no further moves are accepted.
   *  3. Flushes pending moves, then writes result / end_reason / game_end to `games`.
   *  4. Triggers RatingService.applyGameResult (atomic Elo update) for rated results.
   *  5. Purges the session from RAM.
   * If the result cannot be written, the session is KEPT (frozen) and `false` is returned,
   * so the caller can retry without losing the outcome.
   */
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
      // Freeze the session first: authorizeMove() rejects every move from now on.
      session.isFinished = true;
      session.winnerColor = final.winnerColor;
      session.gameOverReason = final.endReason;

      // Ensure any queued moves are flushed before the game row is closed
      await this.flushPendingMoves();

      //INTEGRATION - HOOK for @tszyman (Saving played matches #87) & @Alaxea (Ranking #99)
      const persisted = await this.persistGameConclusion(gameId, final);
      if (persisted) {
        await this.triggerRatingUpdate(gameId);
      }
    } catch (error) {
      this.logger.error(
        `Failed to persist conclusion of game [${gameId}]. Session kept in RAM for retry: ${(error as Error).message}`,
      );
      return false;
    } finally {
      this.concludingGames.delete(gameId);
    }

    const deleted = this.activeGames.delete(gameId);
    if (deleted) {
      this.logger.log(`Purged game session [${gameId}] from server RAM.`);
    }
    return deleted;
  }

  /**
   * Determines the final result of a session. Priority:
   * explicit conclusion (TIMEOUT / RESIGNATION / ABANDONMENT...) > already-finished session
   * > position detected by chess.js > ABORTED (removed before any conclusion, never rated).
   */
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
      // The side to move is the one that has been mated.
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
    // Draw reasons can never have a winner, whatever the caller passed.
    const winner = DRAW_REASONS.includes(reason) ? null : winnerColor;
    if (winner === 'w') return { result: 'WHITE_WON', endReason: reason, winnerColor: 'w' };
    if (winner === 'b') return { result: 'BLACK_WON', endReason: reason, winnerColor: 'b' };
    return { result: 'DRAW', endReason: reason, winnerColor: null };
  }

  /**
   * Writes the final result to `games`. Only an IN_PROGRESS row is updated, so a finished
   * game is never overwritten and the rating trigger can fire at most once per game.
   * Returns true when exactly this call closed the row.
   */
  private async persistGameConclusion(
    gameId: string,
    final: PersistedGameConclusion,
  ): Promise<boolean> {
    if (!UUID_REGEX.test(gameId)) {
      this.logger.warn(`Game [${gameId}] has no UUID id, so it has no \`games\` row. Result not persisted.`);
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

  // The result is already stored at this point and applyGameResult skips already-rated
  // games, so a rating failure is logged (and can be re-run) without blocking the purge.
  private async triggerRatingUpdate(gameId: string): Promise<void> {
    try {
      await this.ratingService.applyGameResult(gameId);
    } catch (error) {
      this.logger.error(
        `Rating update failed for game [${gameId}] (result is saved, rating can be re-applied): ${(error as Error).message}`,
      );
    }
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
  public authorizeMove(
    gameId: string,
    caller: SafeAccount | string | null | undefined,
  ): MoveAuthorizationResult {
    const session = this.activeGames.get(gameId);

    //verify the match exists in Hot-path RAM
    if (!session){
      this.logger.warn(
        'Move authorization failed: Game [${gameId}] not found in RAM (User: ${authenticatedUserId}).',
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
      this.logger.warn('Move authorization failed: Unauthenticated caller in game [${gameId}].');
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
    const timeSpentMs = Math.max(0, now - session.lastMoveTimestamp);
    session.lastMoveTimestamp = now;
    session.plyCount += 1;

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



