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
import {
  CreateGameOptions,
  DatabaseGameResult,
  DatabaseMoveColor,
  GameSession,
  PendingMoveRecord,
  PublicGameState,
  MoveAuthorizationResult,
  MoveExecutionResult,
  PlayerColor,
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
    constructor(
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
      session.gameOverReason = 'THREEFOLD_REPETITATION';
      session.winnerColor = null;
    } else if (session.engine.isInsufficientMaterial()) {
      session.gameOverReason = 'INSUFFICIENT_MATERIAL';
      session.winnerColor = null;
    } else {
      // W chess.js jeżeli isGameOver() === true i nie jest to mat, pat,
      // 3-krotne powtórzenie ani brak materiału, oznacza to regułę 50 ruchów (50-move rule).
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



