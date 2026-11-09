import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { UciEngine } from './uci-engine';
import { AiDifficulty, EngineMove, EngineStrength } from './ai.types';

const DEFAULT_STOCKFISH_PATH = '/usr/games/stockfish';

const STRENGTH_BY_DIFFICULTY: Record<AiDifficulty, EngineStrength> = {
  easy: { skillLevel: 2, movetimeMs: 300 },
  medium: { skillLevel: 8, movetimeMs: 700 },
  hard: { skillLevel: 20, movetimeMs: 1200 },
};

/* Hints are always answered at full strength, regardless of the game's difficulty:
a hint that suggests a weak move would be worse than no hint at all.*/
const HINT_STRENGTH: EngineStrength = { skillLevel: 20, movetimeMs: 1000 };

@Injectable()
export class StockfishService implements OnModuleDestroy {
  private readonly logger = new Logger(StockfishService.name);
  private readonly engine: UciEngine;

  constructor() {
    const binaryPath = process.env.STOCKFISH_PATH?.trim() || DEFAULT_STOCKFISH_PATH;
    this.engine = new UciEngine(binaryPath);
    this.logger.log(`Stockfish service configured (binary: ${binaryPath}).`);
  }

  //The move the AI opponent should play in `fen`, at the given difficulty
  async bestMove(fen: string, difficulty: AiDifficulty): Promise<EngineMove> {
    const strength = STRENGTH_BY_DIFFICULTY[difficulty] ?? STRENGTH_BY_DIFFICULTY.medium;
    return this.engine.search({
      fen,
      skillLevel: strength.skillLevel,
      movetimeMs: strength.movetimeMs,
    });
  }

  //The strongest move we can find in `fen`, for suggesting to a human player.
  async hint(fen: string): Promise<EngineMove> {
    return this.engine.search({
      fen,
      skillLevel: HINT_STRENGTH.skillLevel,
      movetimeMs: HINT_STRENGTH.movetimeMs,
    });
  }

  async onModuleDestroy(): Promise<void> {
    await this.engine.quit();
  }
}
