import {
  Injectable,
  Logger,
  BadRequestException,
  InternalServerErrorException,
} from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { PrismaService } from '../database/prisma.service';
import { GameService } from '../game/game.service';
import { PlayerColor, PublicGameState } from '../game/types/chess.types';
import { AiDifficulty, AI_DIFFICULTIES } from './ai.types';
import { AI_BOT_USER_ID, AI_BOT_DISPLAY_RATING } from './ai.constants';

export interface CreateAiGameParams {
  humanId: string;
  humanRating: number;
  difficulty: AiDifficulty;
  // Which colour the human plays; random when omitted.
  humanColor?: PlayerColor;
  timeControl?: string;
}

// AI-specific state we keep alongside the generic in-memory session owned by
// GameService. The move loop (next step) reads this to know whose turn the bot
// is and how strong to play.
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

/**
 * Creates and tracks human-vs-AI games. The game itself lives in GameService
 * like any other match (authoritative chess.js session + an IN_PROGRESS row in
 * `games`); this service only adds the AI bits on top. Games against the bot are
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

    const humanColor: PlayerColor = params.humanColor ?? (Math.random() < 0.5 ? 'w' : 'b');
    const botColor: PlayerColor = humanColor === 'w' ? 'b' : 'w';

    const whiteId = humanColor === 'w' ? params.humanId : AI_BOT_USER_ID;
    const blackId = humanColor === 'w' ? AI_BOT_USER_ID : params.humanId;
    const whiteRating = humanColor === 'w' ? params.humanRating : AI_BOT_DISPLAY_RATING;
    const blackRating = humanColor === 'w' ? AI_BOT_DISPLAY_RATING : params.humanRating;

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
