import {
  Injectable,
  Logger,
  BadRequestException,
  NotFoundException,
  ForbiddenException,
  InternalServerErrorException,
} from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { PrismaService } from '../database/prisma.service';
import { GameService } from '../game/game.service';
import { MakeMoveDto } from '../game/dto/make-move.dto';
import {
  PlayerColor,
  PromotionPiece,
  PublicGameState,
  MoveExecutionResult,
  GameOverReason,
} from '../game/types/chess.types';
import { StockfishService } from './stockfish.service';
import { AiDifficulty, AI_DIFFICULTIES, EngineEvaluation } from './ai.types';
import { AI_BOT_USER_ID, AI_BOT_DISPLAY_RATING } from './ai.constants';

export interface CreateAiGameParams {
  humanId: string;
  difficulty: AiDifficulty;
  // Which colour the human plays; random when omitted.
  humanColor?: PlayerColor;
  // The human's current ELO; looked up from the DB when omitted.
  humanRating?: number;
  timeControl?: string;
}

// AI-specific state we keep alongside the generic in-memory session owned by
// GameService. The move loop reads this to know whose turn the bot is and how
// strong it should play.
export interface AiGameState {
  gameId: string;
  humanId: string;
  humanColor: PlayerColor;
  botColor: PlayerColor;
  difficulty: AiDifficulty;
}

export interface AiGameCreated extends AiGameState {
  state: PublicGameState;
}

// The bot's move plus what the engine thought of the position it moved from.
export interface AiBotMove {
  result: MoveExecutionResult;
  uci: string;
  evaluation: EngineEvaluation;
}

export interface AiGameOver {
  winnerColor: PlayerColor | null;
  reason: GameOverReason | null;
}

// A suggested move for the human to play, plus the engine's take on the position.
export interface AiHint {
  uci: string;
  from: string;
  to: string;
  promotion: PromotionPiece | null;
  evaluation: EngineEvaluation;
}

// Result of one human move: the human's move, the bot's reply (if any), the
// resulting public state, and the game-over info when the game just ended.
export interface AiTurnResult {
  humanMove: MoveExecutionResult;
  botMove: MoveExecutionResult | null;
  state: PublicGameState;
  gameOver: AiGameOver | null;
}

/**
 * Creates and drives human-vs-AI games. The game itself lives in GameService
 * like any other match (authoritative chess.js session + an IN_PROGRESS row in
 * `games`); this service adds the AI opponent on top: it asks Stockfish for the
 * bot's moves, applies them through the same authoritative path a human move
 * takes, and closes the game out when it ends. Games against the bot are
 * persisted but unrated - RatingService skips them because the bot's role is "bot".
 */
@Injectable()
export class AiGameService {
  private readonly logger = new Logger(AiGameService.name);
  private readonly aiGames = new Map<string, AiGameState>();
  private botSeeded = false;

  constructor(
    private readonly prisma: PrismaService,
    private readonly game: GameService,
    private readonly stockfish: StockfishService,
  ) {}

  async createAiGame(params: CreateAiGameParams): Promise<AiGameCreated> {
    if (!AI_DIFFICULTIES.includes(params.difficulty)) {
      throw new BadRequestException(
        `Unknown AI difficulty "${params.difficulty}". Expected one of: ${AI_DIFFICULTIES.join(', ')}.`,
      );
    }
    if (!params.humanId || params.humanId === AI_BOT_USER_ID) {
      throw new BadRequestException('A valid human player id is required to start an AI game.');
    }

    await this.assertBotSeeded();
    const humanRating = params.humanRating ?? (await this.lookupRating(params.humanId));

    const humanColor: PlayerColor = params.humanColor ?? (Math.random() < 0.5 ? 'w' : 'b');
    const botColor: PlayerColor = humanColor === 'w' ? 'b' : 'w';

    const whiteId = humanColor === 'w' ? params.humanId : AI_BOT_USER_ID;
    const blackId = humanColor === 'w' ? AI_BOT_USER_ID : params.humanId;
    const whiteRating = humanColor === 'w' ? humanRating : AI_BOT_DISPLAY_RATING;
    const blackRating = humanColor === 'w' ? AI_BOT_DISPLAY_RATING : humanRating;

    const gameId = randomUUID();
    const timeControl = params.timeControl ?? null;

    // IN_PROGRESS row first (same id as the in-memory session), mirroring how
    // matchmaking creates a PvP game, so match history and the game-over pipeline
    // treat it like any other match.
    await this.prisma.game.create({
      data: {
        id: gameId,
        whiteId,
        blackId,
        whiteRating,
        blackRating,
        timeControl,
        result: 'IN_PROGRESS',
      },
    });

    const state = this.game.createGame({
      gameId,
      whitePlayerId: whiteId,
      blackPlayerId: blackId,
      timeControl: timeControl ?? undefined,
    });

    const aiGame: AiGameState = {
      gameId,
      humanId: params.humanId,
      humanColor,
      botColor,
      difficulty: params.difficulty,
    };
    this.aiGames.set(gameId, aiGame);

    this.logger.log(
      `Created AI game ${gameId}: human ${params.humanId} (${humanColor}) vs bot (${botColor}), difficulty ${params.difficulty}.`,
    );

    return { ...aiGame, state };
  }

  /**
   * Applies a human move and, if the game is still on and it is now the bot's
   * turn, has the bot reply. Closes the game out when either move ends it.
   */
  async submitHumanMove(
    gameId: string,
    humanId: string,
    move: { from: string; to: string; promotion?: PromotionPiece },
  ): Promise<AiTurnResult> {
    this.requireHumanGame(gameId, humanId);

    const humanMove = this.game.executeMove(this.toMoveDto(gameId, move), humanId);

    // Rejected (illegal / not your turn / ...): no bot reply, client resyncs
    // from the authoritative FEN carried in the result.
    if (!humanMove.success) {
      if (humanMove.errorReason === 'GAME_NOT_FOUND') {
        this.forget(gameId);
        throw new NotFoundException(`Game ${gameId} is no longer active.`);
      }
      return { humanMove, botMove: null, state: this.game.getPublicGameState(gameId), gameOver: null };
    }

    if (humanMove.isGameOver) {
      const over = await this.conclude(gameId, humanMove);
      return { humanMove, botMove: null, state: over.state, gameOver: over.info };
    }

    const bot = await this.playBotMoveIfDue(gameId);
    const botMove = bot?.result ?? null;

    if (botMove?.isGameOver) {
      const over = await this.conclude(gameId, botMove);
      return { humanMove, botMove, state: over.state, gameOver: over.info };
    }

    return { humanMove, botMove, state: this.game.getPublicGameState(gameId), gameOver: null };
  }

  /**
   * If it is the bot's turn in a live AI game, asks Stockfish for a move and
   * applies it. Returns null when it is not the bot's turn (e.g. nothing to do).
   * Used both for the bot's in-game replies and for its opening move when it
   * plays white.
   */
  async playBotMoveIfDue(gameId: string): Promise<AiBotMove | null> {
    const meta = this.aiGames.get(gameId);
    if (!meta) {
      return null;
    }

    let state: PublicGameState;
    try {
      state = this.game.getPublicGameState(gameId);
    } catch {
      this.forget(gameId);
      return null;
    }
    if (state.isFinished || state.turn !== meta.botColor) {
      return null;
    }

    const engineMove = await this.stockfish.bestMove(state.fen, meta.difficulty);
    if (!engineMove.bestMove) {
      this.logger.warn(`Stockfish returned no move for game ${gameId} (fen: ${state.fen}).`);
      return null;
    }

    const result = this.game.executeMove(this.toMoveDto(gameId, parseUci(engineMove.bestMove)), AI_BOT_USER_ID);
    if (!result.success) {
      // Should never happen - the engine only ever suggests legal moves - but if
      // it does we log it loudly rather than silently stall the game.
      this.logger.error(
        `Bot move ${engineMove.bestMove} was rejected in game ${gameId}: ${result.errorReason}.`,
      );
    }
    return { result, uci: engineMove.bestMove, evaluation: engineMove.evaluation };
  }

  /** The human resigns: hand the game to the bot and close it out. */
  async resign(gameId: string, humanId: string): Promise<{ state: PublicGameState; gameOver: AiGameOver }> {
    this.requireHumanGame(gameId, humanId);
    const result = this.game.resignGame(gameId, humanId);
    if (!result.success) {
      throw new BadRequestException(result.errorReason ?? 'Could not resign this game.');
    }
    const over = await this.conclude(gameId, result);
    return { state: over.state, gameOver: over.info };
  }

  /**
   * Suggests the strongest move for the human to play right now. Full engine
   * strength regardless of the game's difficulty - a hint should be a good move.
   * Only offered in AI games, and only when it is actually the human's turn.
   */
  async hint(gameId: string, humanId: string): Promise<AiHint> {
    const meta = this.requireHumanGame(gameId, humanId);
    const state = this.game.getPublicGameState(gameId);
    if (state.isFinished) {
      throw new BadRequestException('This game is already over.');
    }
    if (state.turn !== meta.humanColor) {
      throw new BadRequestException('You can only ask for a hint on your own turn.');
    }

    const move = await this.stockfish.hint(state.fen);
    if (!move.bestMove) {
      throw new BadRequestException('No move is available in this position.');
    }
    const parsed = parseUci(move.bestMove);
    return {
      uci: move.bestMove,
      from: parsed.from,
      to: parsed.to,
      promotion: parsed.promotion ?? null,
      evaluation: move.evaluation,
    };
  }

  getAiGame(gameId: string): AiGameState | undefined {
    return this.aiGames.get(gameId);
  }

  isAiGame(gameId: string): boolean {
    return this.aiGames.has(gameId);
  }

  // Drop the AI metadata once a game is over (GameService purges its own session).
  forget(gameId: string): void {
    this.aiGames.delete(gameId);
  }

  // Persists the conclusion (rating is skipped because the bot's role is "bot")
  // and drops the AI metadata. The final state is captured before removeGame
  // purges the in-memory session.
  private async conclude(
    gameId: string,
    result: MoveExecutionResult,
  ): Promise<{ state: PublicGameState; info: AiGameOver }> {
    const state = this.game.getPublicGameState(gameId);
    await this.game.removeGame(gameId);
    this.forget(gameId);
    return {
      state,
      info: {
        winnerColor: result.winnerColor ?? state.winnerColor ?? null,
        reason: result.gameOverReason ?? state.gameOverReason ?? null,
      },
    };
  }

  // Looks up the AI game and asserts the caller is its human player.
  private requireHumanGame(gameId: string, humanId: string): AiGameState {
    const meta = this.aiGames.get(gameId);
    if (!meta) {
      throw new NotFoundException(`Game ${gameId} is not an active AI game.`);
    }
    if (meta.humanId !== humanId) {
      throw new ForbiddenException('You are not the human player in this AI game.');
    }
    return meta;
  }

  private toMoveDto(
    gameId: string,
    move: { from: string; to: string; promotion?: PromotionPiece },
  ): MakeMoveDto {
    return {
      gameId,
      from: move.from,
      to: move.to,
      ...(move.promotion ? { promotion: move.promotion } : {}),
    } as MakeMoveDto;
  }

  private async lookupRating(userId: string): Promise<number> {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { rating: true },
    });
    return user?.rating ?? AI_BOT_DISPLAY_RATING;
  }

  // Fail loudly and clearly if the bot user was never seeded, instead of letting
  // the game insert blow up on a foreign-key violation. Cached once it's found.
  private async assertBotSeeded(): Promise<void> {
    if (this.botSeeded) {
      return;
    }
    const bot = await this.prisma.user.findUnique({
      where: { id: AI_BOT_USER_ID },
      select: { id: true },
    });
    if (!bot) {
      throw new InternalServerErrorException(
        'AI bot user is not seeded. Run the database seed (prisma db seed) and retry.',
      );
    }
    this.botSeeded = true;
  }
}

/** Splits a UCI move ("e2e4", "e7e8q") into from/to/promotion. */
function parseUci(uci: string): { from: string; to: string; promotion?: PromotionPiece } {
  return {
    from: uci.slice(0, 2),
    to: uci.slice(2, 4),
    ...(uci.length > 4 ? { promotion: uci.slice(4, 5) as PromotionPiece } : {}),
  };
}
