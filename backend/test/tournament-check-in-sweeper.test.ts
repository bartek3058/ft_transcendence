import 'reflect-metadata';
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { ConflictException, Logger } from '@nestjs/common';
import { PrismaService } from '../src/database/prisma.service';
import { TournamentBracketService } from '../src/tournament/tournament-bracket.service';
import { MAX_SWEEP_ATTEMPTS, TournamentCheckInSweeper } from '../src/tournament/tournament-check-in.sweeper';
import { TournamentGameService } from '../src/tournament/tournament-game.service';

// Decision logic only; locking, rollback and races are covered by the PostgreSQL test.
Logger.overrideLogger(false);

const T = 'tournament-1';
const P1 = 'player-1';
const P2 = 'player-2';

interface Row { player1_id: string; player2_id: string; player1_checked_in_at: Date | null; player2_checked_in_at: Date | null }

/** `locked[matchId]` is what the FOR UPDATE select returns (undefined = already resolved). */
function setup(locked: Record<string, Row | undefined>, failing: Record<string, Error> = {}) {
  const calls: string[] = [];
  let current = '';
  const tx = { $queryRaw: async () => { const row = locked[current]; return row ? [row] : []; } };
  const prisma = {
    tournamentMatch: { findMany: async () => Object.keys(locked).map((id) => ({ id, tournamentId: T })) },
    $transaction: async (fn: (t: typeof tx) => Promise<unknown>) => fn(tx),
  } as unknown as PrismaService;
  const fail = (id: string) => { if (failing[id]) throw failing[id]; };
  const bracket = {
    handleWalkover: async (_tx: unknown, _t: string, id: string, absent: string) => { fail(id); calls.push(`walkover:${id}:${absent}`); },
    handleDoubleForfeit: async (_tx: unknown, _t: string, id: string) => { fail(id); calls.push(`double:${id}`); },
  } as unknown as TournamentBracketService;
  const games = {
    createMatchGame: async (_tx: unknown, _t: string, id: string) => { fail(id); calls.push(`create:${id}`); return { gameId: `g-${id}` }; },
    startSession: (created: { gameId: string }) => { calls.push(`session:${created.gameId}`); },
  } as unknown as TournamentGameService;
  const sweeper = new TournamentCheckInSweeper(prisma, bracket, games);
  // Route the fake $queryRaw to the match being resolved.
  const resolve = sweeper.resolve.bind(sweeper);
  sweeper.resolve = (t: string, id: string) => { current = id; return resolve(t, id); };
  return { sweeper, calls };
}

const row = (p1: boolean, p2: boolean): Row => ({
  player1_id: P1, player2_id: P2,
  player1_checked_in_at: p1 ? new Date(0) : null, player2_checked_in_at: p2 ? new Date(0) : null,
});

describe('TournamentCheckInSweeper', () => {
  it('walkover for the absent player, double forfeit for nobody, game start when both checked in', async () => {
    const { sweeper, calls } = setup({ a: row(true, false), b: row(false, true), c: row(false, false), d: row(true, true), e: undefined });
    const result = await sweeper.tick();
    assert.deepEqual(calls, [`walkover:a:${P2}`, `walkover:b:${P1}`, 'double:c', 'create:d', 'session:g-d']);
    assert.deepEqual(result, {
      skipped: false, started: 1, walkovers: 2, doubleForfeits: 1, alreadyResolved: 1, failed: 0, quarantined: 0,
    });
  });

  it('starts the in-memory session only after a successful transaction', async () => {
    const { sweeper, calls } = setup({ d: row(true, true) }, { d: new Error('insert failed') });
    await sweeper.tick();
    assert.ok(!calls.some((c) => c.startsWith('session:')));
  });

  it(`keeps going after a failure and stops retrying a match after ${MAX_SWEEP_ATTEMPTS} failures in a row`, async () => {
    const { sweeper, calls } = setup({ bad: row(true, false), ok: row(false, false) },
      { bad: new ConflictException('slot not available') });
    for (let i = 1; i <= MAX_SWEEP_ATTEMPTS; i++) {
      const result = await sweeper.tick();
      assert.equal(result.failed, 1);
      assert.equal(result.quarantined, i === MAX_SWEEP_ATTEMPTS ? 1 : 0);
    }
    const after = await sweeper.tick();
    assert.equal(after.failed, 0); // no longer retried
    assert.equal(after.quarantined, 1);
    assert.equal(calls.filter((c) => c === 'double:ok').length, MAX_SWEEP_ATTEMPTS + 1);
    assert.ok(!calls.some((c) => c.startsWith('walkover:bad')));
  });

  it('a success resets the failure count', async () => {
    const failing: Record<string, Error> = { m: new Error('blip') };
    const { sweeper } = setup({ m: row(true, false) }, failing);
    for (let i = 1; i < MAX_SWEEP_ATTEMPTS; i++) await sweeper.tick();
    delete failing.m;
    await sweeper.tick(); // success
    failing.m = new Error('blip');
    for (let i = 1; i < MAX_SWEEP_ATTEMPTS; i++) assert.equal((await sweeper.tick()).quarantined, 0);
  });

  it('skips a tick while the previous one is still executing, and survives a failing scan', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const prisma = {
      tournamentMatch: { findMany: async () => { await gate; return []; } },
    } as unknown as PrismaService;
    const sweeper = new TournamentCheckInSweeper(prisma, {} as TournamentBracketService, {} as TournamentGameService);
    const first = sweeper.tick();
    assert.equal((await sweeper.tick()).skipped, true);
    release();
    assert.equal((await first).skipped, false);

    const broken = new TournamentCheckInSweeper(
      { tournamentMatch: { findMany: async () => { throw new Error('db down'); } } } as unknown as PrismaService,
      {} as TournamentBracketService, {} as TournamentGameService);
    assert.equal((await broken.tick()).failed, 0);
    assert.equal((await broken.tick()).skipped, false); // guard released
  });

  it('starts an unref()d timer on init and clears it on destroy', () => {
    const sweeper = setup({}).sweeper;
    sweeper.onModuleInit();
    const timer = (sweeper as unknown as { timer?: NodeJS.Timeout }).timer;
    assert.ok(timer);
    assert.equal(timer.hasRef(), false);
    sweeper.onModuleDestroy();
    assert.equal((sweeper as unknown as { timer?: NodeJS.Timeout }).timer, undefined);
  });
});
