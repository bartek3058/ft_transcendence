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

// the bot's move plus what the engine thought of the position it moved from.
export interface AiBotMove {
  result: MoveExecutionResult;
  uci: string;
  evaluation: EngineEvaluation;
}

export interface AiGameOver {
  winnerColor: PlayerColor | null;
  reason: GameOverReason | null;
}

// a suggested move for the human to play, plus the engine's take on the postiton.
export interface AiHint {
  uci: string;
  from: string;
  to: string;
  promotion: PromotionPiece | null;
  evaluation: EngineEvaluation;
}

/* Result of one human move: the human's move, the bot's reply (if any), the
resulting public state, and the game-over info when the game just ended.*/
export interface AiTurnResult {
  humanMove: MoveExecutionResult;
  botMove: MoveExecutionResult | null;
  state: PublicGameState;
  gameOver: AiGameOver | null;
  /* True when the human move was accepted but the engine failed to reply, so the
  caller can tell the client instead of leaving it silently stuck on bot's turn.
  */
  botError?: boolean;
}

/*
Games against the bot are persisted but unrated 
- RatingService skips them because the bot's role is only "bot".
*/
@Injectable()
export class AiGameService {
  private readonly logger = new Logger(AiGameService.name);
  private readonly aiGames = new Map<string, AiGameState>();
  private botSeeded = false;
  private readonly humanizeMovePace = process.env.AI_BOT_MOVE_DELAY !== 'off';

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

  /*
  Applies a human move and, if the game is still on and it is now the bot's
  turn, has the bot reply. Closes the game out when either move ends it.
  */
  async submitHumanMove(
    gameId: string,
    humanId: string,
    move: { from: string; to: string; promotion?: PromotionPiece },
  ): Promise<AiTurnResult> {
    this.requireHumanGame(gameId, humanId);

    const humanMove = this.game.executeMove(this.toMoveDto(gameId, move), humanId);

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

    /* The human move flipped the turn, so the bot is now to move. If the engine
    throws or can't produce a legal move, flag it rather than silently leaving
    the client stuck waiting for a reply that never comes.
    */
    let botMove: MoveExecutionResult | null = null;
    let botError = false;
    try {
      const bot = await this.playBotMoveIfDue(gameId);
      botMove = bot?.result ?? null;
      if (!botMove || !botMove.success) {
        botError = true;
      } else if (botMove.isGameOver) {
        const over = await this.conclude(gameId, botMove);
        return { humanMove, botMove, state: over.state, gameOver: over.info };
      }
    } catch (error) {
      this.logger.error(`Bot move failed in game ${gameId}: ${(error as Error).message}`);
      botError = true;
    }

    return { humanMove, botMove, state: this.game.getPublicGameState(gameId), gameOver: null, botError };
  }

  /*
  If it is the bot's turn in a live AI game, asks Stockfish for a move and
  applies it. Returns null when it is not the bot's turn (e.g. nothing to do).
  Used both for the bot's in-game replies and for its opening move when it
  plays white.
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

    const startedAt = Date.now();
    const engineMove = await this.stockfish.bestMove(state.fen, meta.difficulty);
    if (!engineMove.bestMove) {
      this.logger.warn(`Stockfish returned no move for game ${gameId} (fen: ${state.fen}).`);
      return null;
    }

    // pause so the move lands like a person taking a moment
    if (this.humanizeMovePace) {
      await sleep(humanThinkDelayMs(meta.difficulty, Date.now() - startedAt));
    }

    const result = this.game.executeMove(this.toMoveDto(gameId, parseUci(engineMove.bestMove)), AI_BOT_USER_ID);
    if (!result.success) {
      this.logger.error(
        `Bot move ${engineMove.bestMove} was rejected in game ${gameId}: ${result.errorReason}.`,
      );
    }
    return { result, uci: engineMove.bestMove, evaluation: engineMove.evaluation };
  }

  //The human resigns: hand the game to the bot and close it out.
  async resign(gameId: string, humanId: string): Promise<{ state: PublicGameState; gameOver: AiGameOver }> {
    this.requireHumanGame(gameId, humanId);
    const result = this.game.resignGame(gameId, humanId);
    if (!result.success) {
      throw new BadRequestException(result.errorReason ?? 'Could not resign this game.');
    }
    const over = await this.conclude(gameId, result);
    return { state: over.state, gameOver: over.info };
  }

  /*
  Suggests the strongest move for the human to play right now. Full engine
  strength regardless of the game's difficulty - a hint should be a good move.
  Only offered in AI games, and only when it is actually the human's turn.
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

  forget(gameId: string): void {
    this.aiGames.delete(gameId);
  }

  /*
  Abandons a live AI game (player left, disconnected, or started a new one):
  closes it out as ABORTED (no winner, never rated) and frees both the
  in-memory session and the AI metadata.
  */
  async abort(gameId: string): Promise<void> {
    if (!this.aiGames.has(gameId)) {
      return;
    }
    try {
      await this.game.removeGame(gameId);
    } catch (error) {
      this.logger.warn(`Failed to abort AI game ${gameId}: ${(error as Error).message}`);
    } finally {
      this.forget(gameId);
    }
  }

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

  // Fail loudly and clearly if the bot user was never seeded
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

/*
How long, in total, the bot should take over a move at each difficulty - stronger play thinks longer,
which also reads as more considered.
*/
export const BOT_THINK_PACING: Record<AiDifficulty, { minMs: number; maxMs: number }> = {
  easy: { minMs: 500, maxMs: 1400 },
  medium: { minMs: 800, maxMs: 2200 },
  hard: { minMs: 1200, maxMs: 3000 },
};

export function humanThinkDelayMs(
  difficulty: AiDifficulty,
  engineElapsedMs: number,
  random: () => number = Math.random,
): number {
  const pacing = BOT_THINK_PACING[difficulty] ?? BOT_THINK_PACING.medium;
  const target = pacing.minMs + random() * (pacing.maxMs - pacing.minMs);
  return Math.max(0, Math.round(target - Math.max(0, engineElapsedMs)));
}

//Resolves after `ms` milliseconds (no-op for 0 or less)
function sleep(ms: number): Promise<void> {
  if (ms <= 0) {
    return Promise.resolve();
  }
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function parseUci(uci: string): { from: string; to: string; promotion?: PromotionPiece } {
  return {
    from: uci.slice(0, 2),
    to: uci.slice(2, 4),
    ...(uci.length > 4 ? { promotion: uci.slice(4, 5) as PromotionPiece } : {}),
  };
}
