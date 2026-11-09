// The three difficulty presets a player can pick when starting a game vs the AI.
export type AiDifficulty = 'easy' | 'medium' | 'hard';

export const AI_DIFFICULTIES: readonly AiDifficulty[] = ['easy', 'medium', 'hard'];

/*
We drive strength with Stockfish's own "Skill Level" (0-20) rather than a fixed
search depth because it spans the whole range from "makes real blunders" to "full
strength" and already mixes in a bit of randomness, which reads as more
human-like than a perfectly deterministic shallow search.
*/
export interface EngineStrength {
  skillLevel: number;
  movetimeMs: number;
}

export interface UciSearchOptions {
  fen: string; //position to search
  movetimeMs?: number;
  depth?: number;
  skillLevel?: number;
}

export interface EngineEvaluation {
  scoreCp: number | null;
  mateIn: number | null;
  depth: number | null;
}

export interface EngineMove {
  bestMove: string | null;
  ponder: string | null;
  evaluation: EngineEvaluation;
}
