// The three difficulty presets a player can pick when starting a game vs the AI.
export type AiDifficulty = 'easy' | 'medium' | 'hard';

export const AI_DIFFICULTIES: readonly AiDifficulty[] = ['easy', 'medium', 'hard'];

/**
 * How we weaken (or not) the engine for a given difficulty.
 *
 * We drive strength with Stockfish's own "Skill Level" (0-20) rather than a fixed
 * search depth: it spans the whole range from "makes real blunders" to "full
 * strength" and already mixes in a bit of randomness, which reads as more
 * human-like than a perfectly deterministic shallow search. `movetimeMs` caps how
 * long the engine is allowed to think per move so a move never hangs the game.
 */
export interface EngineStrength {
  // Stockfish "Skill Level" option, 0 (weakest) .. 20 (full strength).
  skillLevel: number;
  // Hard cap on thinking time per move, in milliseconds.
  movetimeMs: number;
}

export interface UciSearchOptions {
  fen: string; //position to search
  movetimeMs?: number;
  depth?: number;
  skillLevel?: number;
}

/**
 * The outcome of a single search. `scoreCp` / `mateIn` are reported from the point
 * of view of the side to move in the searched position (positive = good for them),
 * which is how the UCI protocol gives them to us.
 */
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
