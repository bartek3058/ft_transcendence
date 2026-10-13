export type EloResult = 'WHITE_WON' | 'BLACK_WON' | 'DRAW';

/** Actual score a player earns in a game: 1 win, 0.5 draw, 0 loss. */
export type Score = 0 | 0.5 | 1;

export interface EloInput {
  whiteRating: number;
  blackRating: number;
  result: EloResult;
  kFactor?: number;
}

export interface EloOutcome {
  whiteRating: number;
  blackRating: number;
  whiteRatingChange: number;
  blackRatingChange: number;
}

export const DEFAULT_K_FACTOR = 32;

/** Ratings are never allowed to drop below this floor. */
export const RATING_FLOOR = 100;

export function expectedScore(rating: number, opponentRating: number): number {
  return 1 / (1 + 10 ** ((opponentRating - rating) / 400));
}

function whiteScore(result: EloResult): Score {
  switch (result) {
    case 'WHITE_WON':
      return 1;
    case 'BLACK_WON':
      return 0;
    case 'DRAW':
      return 0.5;
  }
}

/**
 * Compute post-game ratings and deltas for both players.
 *
 * new = old + K * (actualScore - expectedScore), rounded to the nearest integer and
 * clamped at RATING_FLOOR. Deltas are reported relative to the (clamped) new rating so
 * that 'oldRating + change === newRating' always holds.
 */
export function computeElo(input: EloInput): EloOutcome {
  const { whiteRating, blackRating, result } = input;
  const k = input.kFactor ?? DEFAULT_K_FACTOR;

  if (!Number.isFinite(whiteRating) || !Number.isFinite(blackRating)) {
    throw new Error('computeElo: ratings must be finite numbers');
  }
  if (!Number.isFinite(k) || k <= 0) {
    throw new Error('computeElo: kFactor must be a positive finite number');
  }

  const sWhite = whiteScore(result);
  const sBlack = (1 - sWhite) as Score;

  const eWhite = expectedScore(whiteRating, blackRating);
  const eBlack = expectedScore(blackRating, whiteRating);

  const newWhite = clampFloor(Math.round(whiteRating + k * (sWhite - eWhite)));
  const newBlack = clampFloor(Math.round(blackRating + k * (sBlack - eBlack)));

  return {
    whiteRating: newWhite,
    blackRating: newBlack,
    whiteRatingChange: newWhite - whiteRating,
    blackRatingChange: newBlack - blackRating,
  };
}

function clampFloor(rating: number): number {
  return rating < RATING_FLOOR ? RATING_FLOOR : rating;
}
