import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  QueueEntry,
  toleranceFor,
  areCompatible,
  selectPair,
  DEFAULT_MATCHMAKING_CONFIG,
} from '../src/matchmaking/pairing';

const cfg = DEFAULT_MATCHMAKING_CONFIG; // base 100, +10/s, cap 1000
const T0 = 1_000_000; // arbitrary epoch ms baseline for deterministic tests

function entry(userId: string, rating: number, joinedAt = T0, timeControl?: string): QueueEntry {
  return { userId, rating, joinedAt, timeControl };
}

describe('Matchmaking pairing (pure)', () => {
  describe('toleranceFor', () => {
    it('equals baseTolerance the instant a player joins', () => {
      assert.equal(toleranceFor(entry('a', 1500), T0, cfg), 100);
    });

    it('widens with time spent waiting', () => {
      assert.equal(toleranceFor(entry('a', 1500, T0), T0 + 5_000, cfg), 150); // 100 + 5*10
    });

    it('is capped at maxTolerance', () => {
      assert.equal(toleranceFor(entry('a', 1500, T0), T0 + 10_000_000, cfg), 1000);
    });
  });

  describe('areCompatible', () => {
    it('never matches a player with themselves', () => {
      assert.equal(areCompatible(entry('a', 1500), entry('a', 1500), T0, cfg), false);
    });

    it('matches equal ratings immediately', () => {
      assert.equal(areCompatible(entry('a', 1500), entry('b', 1500), T0, cfg), true);
    });

    it('rejects a gap wider than the base tolerance at join time', () => {
      // gap 300 > 100 base
      assert.equal(areCompatible(entry('a', 1500), entry('b', 1800), T0, cfg), false);
    });

    it('accepts that same gap once a player has waited long enough', () => {
      // after 20s one side tolerates 100 + 20*10 = 300 >= gap 300
      const a = entry('a', 1500, T0);
      const b = entry('b', 1800, T0);
      assert.equal(areCompatible(a, b, T0 + 20_000, cfg), true);
    });

    it('never matches across different time controls', () => {
      const a = entry('a', 1500, T0, 'blitz_5_0');
      const b = entry('b', 1500, T0, 'rapid_10_0');
      assert.equal(areCompatible(a, b, T0, cfg), false);
    });
  });

  describe('selectPair', () => {
    it('returns null with fewer than two players', () => {
      assert.equal(selectPair([], T0, cfg), null);
      assert.equal(selectPair([entry('a', 1500)], T0, cfg), null);
    });

    it('returns null when nobody is compatible', () => {
      const pair = selectPair([entry('a', 1200), entry('b', 2000)], T0, cfg);
      assert.equal(pair, null);
    });

    it('pairs two compatible players', () => {
      const pair = selectPair([entry('a', 1500), entry('b', 1550)], T0, cfg);
      assert.ok(pair);
      assert.deepEqual(new Set(pair!.map((e) => e.userId)), new Set(['a', 'b']));
    });

    it('picks the closest-rated opponent when several are compatible', () => {
      const pair = selectPair(
        [entry('a', 1500), entry('b', 1590), entry('c', 1510)],
        T0,
        cfg,
      );
      assert.ok(pair);
      // a(1500) and c(1510) are the closest pair (gap 10)
      assert.deepEqual(new Set(pair!.map((e) => e.userId)), new Set(['a', 'c']));
    });

    it('only pairs within the same time control', () => {
      const pair = selectPair(
        [entry('a', 1500, T0, 'blitz_5_0'), entry('b', 1500, T0, 'rapid_10_0')],
        T0,
        cfg,
      );
      assert.equal(pair, null);
    });

    it('lets a long-waiting player match a wider gap over time', () => {
      const entries = [entry('a', 1500, T0), entry('b', 1800, T0)];
      assert.equal(selectPair(entries, T0, cfg), null); // gap 300 too wide at join
      const later = selectPair(entries, T0 + 30_000, cfg); // tolerance now 400 >= 300
      assert.ok(later);
    });
  });
});
