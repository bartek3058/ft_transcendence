import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  computeElo,
  expectedScore,
  DEFAULT_K_FACTOR,
  RATING_FLOOR,
} from '../src/rating/elo';

describe('ELO rating engine (pure)', () => {
  describe('expectedScore', () => {
    it('returns 0.5 for equal ratings', () => {
      assert.equal(expectedScore(1500, 1500), 0.5);
    });

    it('is symmetric: expectations of both players sum to 1', () => {
      const e = expectedScore(1600, 1400);
      const opp = expectedScore(1400, 1600);
      assert.ok(Math.abs(e + opp - 1) < 1e-9);
    });

    it('gives the higher-rated player an expectation above 0.5', () => {
      assert.ok(expectedScore(1800, 1500) > 0.5);
      assert.ok(expectedScore(1500, 1800) < 0.5);
    });

    it('matches the known 400-point gap value (~0.909)', () => {
      assert.ok(Math.abs(expectedScore(1800, 1400) - 0.9090909) < 1e-6);
    });
  });

  describe('computeElo — equal ratings, default K', () => {
    it('winner gains K/2 and loser drops K/2', () => {
      const out = computeElo({ whiteRating: 1500, blackRating: 1500, result: 'WHITE_WON' });
      assert.equal(out.whiteRatingChange, DEFAULT_K_FACTOR / 2); // +16
      assert.equal(out.blackRatingChange, -DEFAULT_K_FACTOR / 2); // -16
      assert.equal(out.whiteRating, 1516);
      assert.equal(out.blackRating, 1484);
    });

    it('a draw between equals leaves both ratings unchanged', () => {
      const out = computeElo({ whiteRating: 1500, blackRating: 1500, result: 'DRAW' });
      assert.equal(out.whiteRatingChange, 0);
      assert.equal(out.blackRatingChange, 0);
    });

    it('is a zero-sum exchange when ratings are equal', () => {
      const out = computeElo({ whiteRating: 1500, blackRating: 1500, result: 'BLACK_WON' });
      assert.equal(out.whiteRatingChange + out.blackRatingChange, 0);
    });
  });

  describe('computeElo — upsets and expected results', () => {
    it('rewards the underdog more for winning than the favourite', () => {
      const underdogWins = computeElo({ whiteRating: 1400, blackRating: 1800, result: 'WHITE_WON' });
      const favouriteWins = computeElo({ whiteRating: 1800, blackRating: 1400, result: 'WHITE_WON' });
      assert.ok(underdogWins.whiteRatingChange > favouriteWins.whiteRatingChange);
    });

    it('keeps oldRating + change === newRating for both players', () => {
      const out = computeElo({ whiteRating: 1632, blackRating: 1455, result: 'DRAW' });
      assert.equal(1632 + out.whiteRatingChange, out.whiteRating);
      assert.equal(1455 + out.blackRatingChange, out.blackRating);
    });

    it('a strong favourite winning gains only a little', () => {
      const out = computeElo({ whiteRating: 2000, blackRating: 1200, result: 'WHITE_WON' });
      assert.ok(out.whiteRatingChange >= 0 && out.whiteRatingChange <= 2);
    });
  });

  describe('computeElo — K-factor', () => {
    it('a larger K moves ratings more', () => {
      const small = computeElo({ whiteRating: 1500, blackRating: 1500, result: 'WHITE_WON', kFactor: 10 });
      const large = computeElo({ whiteRating: 1500, blackRating: 1500, result: 'WHITE_WON', kFactor: 40 });
      assert.ok(large.whiteRatingChange > small.whiteRatingChange);
    });

    it('rejects a non-positive K-factor', () => {
      assert.throws(() => computeElo({ whiteRating: 1500, blackRating: 1500, result: 'DRAW', kFactor: 0 }));
    });
  });

  describe('computeElo — rating floor & validation', () => {
    it('never drops a rating below the floor', () => {
      const out = computeElo({ whiteRating: RATING_FLOOR, blackRating: 2000, result: 'BLACK_WON' });
      assert.ok(out.whiteRating >= RATING_FLOOR);
      assert.equal(out.whiteRating, RATING_FLOOR);
    });

    it('rejects non-finite ratings', () => {
      assert.throws(() => computeElo({ whiteRating: NaN, blackRating: 1500, result: 'DRAW' }));
    });
  });
});
