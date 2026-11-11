import 'reflect-metadata';
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { ConflictException, Logger } from '@nestjs/common';
import { PrismaService } from '../src/database/prisma.service';
import { TournamentEventsPublisher } from '../src/tournament/tournament-events.publisher';
import { TournamentGameService } from '../src/tournament/tournament-game.service';
import {
  MAX_RECOVERY_ATTEMPTS, SERVER_RESTART_REASON, StuckMatch, TournamentRecoveryService,
} from '../src/tournament/tournament-recovery.service';

/* Decision logic with fakes; SQL, locking and real bracket effects are covered by
tournament-recovery-postgres.test.ts. */
Logger.overrideLogger(false);

const stuck = (matchId: string, result: StuckMatch['result'], endReason: string | null = null): StuckMatch => ({
  match_id: matchId, tournament_id: 't1', game_id: `g-${matchId}`, result, end_reason: endReason,
  white_id: 'white', black_id: 'black',
});

function setup(rows: StuckMatch[], opts: { reopenCount?: number; failing?: Record<string, Error> } = {}) {
  const applied: unknown[] = [];
  const updates: unknown[] = [];
  const prisma = {
    $queryRaw: async () => rows,
    $executeRaw: async () => opts.reopenCount ?? 1,
    game: { updateMany: async (args: unknown) => { updates.push(args); return { count: 2 }; } },
  } as unknown as PrismaService;
  const games = {
    applyGameResult: async (tournamentId: string, matchId: string, event: unknown) => {
      if (opts.failing?.[matchId]) throw opts.failing[matchId];
      applied.push({ tournamentId, matchId, event });
    },
  } as unknown as TournamentGameService;
  const changed: string[][] = [];
  const events = { bracketChanged: (_t: string, ids: string[]) => { changed.push(ids); } } as unknown as TournamentEventsPublisher;
  return { service: new TournamentRecoveryService(prisma, games, events), applied, updates, changed };
}

describe('TournamentRecoveryService', () => {
  it('re-applies a finished game through the listener code, with the stored players and reason', async () => {
    const h = setup([stuck('m1', 'WHITE_WON'), stuck('m2', 'DRAW', 'ABANDONMENT')]);
    const result = await h.service.tick();
    assert.deepEqual(h.applied, [
      { tournamentId: 't1', matchId: 'm1', event: { gameId: 'g-m1', result: 'WHITE_WON', endReason: null, whitePlayerId: 'white', blackPlayerId: 'black' } },
      { tournamentId: 't1', matchId: 'm2', event: { gameId: 'g-m2', result: 'DRAW', endReason: 'ABANDONMENT', whitePlayerId: 'white', blackPlayerId: 'black' } },
    ]);
    assert.deepEqual([result.reapplied, result.reopened, result.failed], [2, 0, 0]);
  });

  it('reopens check-in for an aborted game and announces the match; no event if it was already resolved', async () => {
    const reopened = setup([stuck('m1', 'ABORTED', SERVER_RESTART_REASON)]);
    assert.equal((await reopened.service.tick()).reopened, 1);
    assert.deepEqual(reopened.changed, [['m1']]);
    assert.deepEqual(reopened.applied, []);

    const raced = setup([stuck('m1', 'ABORTED')], { reopenCount: 0 });
    assert.equal((await raced.service.tick()).alreadyResolved, 1);
    assert.deepEqual(raced.changed, []);
  });

  it(`stops retrying a match after ${MAX_RECOVERY_ATTEMPTS} failures in a row and keeps going with the others`, async () => {
    const h = setup([stuck('bad', 'BLACK_WON'), stuck('ok', 'ABORTED')],
      { failing: { bad: new ConflictException('slot not available') } });
    for (let i = 1; i <= MAX_RECOVERY_ATTEMPTS; i++) {
      const r = await h.service.tick();
      assert.deepEqual([r.failed, r.reopened, r.quarantined], [1, 1, i === MAX_RECOVERY_ATTEMPTS ? 1 : 0]);
    }
    const after = await h.service.tick();
    assert.deepEqual([after.failed, after.quarantined], [0, 1]);
  });

  it('a success resets the failure count', async () => {
    const failing: Record<string, Error> = { m: new Error('blip') };
    const h = setup([stuck('m', 'WHITE_WON')], { failing });
    for (let i = 1; i < MAX_RECOVERY_ATTEMPTS; i++) await h.service.tick();
    delete failing.m;
    await h.service.tick();
    failing.m = new Error('blip');
    for (let i = 1; i < MAX_RECOVERY_ATTEMPTS; i++) assert.equal((await h.service.tick()).quarantined, 0);
  });

  it('refuses to re-apply a game without player ids (counted as a failure)', async () => {
    const h = setup([{ ...stuck('m', 'WHITE_WON'), white_id: null }]);
    assert.equal((await h.service.tick()).failed, 1);
    assert.deepEqual(h.applied, []);
  });

  it('skips a tick while the previous one is running, and survives a failing scan', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const prisma = { $queryRaw: async () => { await gate; return []; } } as unknown as PrismaService;
    const service = new TournamentRecoveryService(prisma, {} as TournamentGameService, {} as TournamentEventsPublisher);
    const first = service.tick();
    assert.equal((await service.tick()).skipped, true);
    release();
    assert.equal((await first).skipped, false);

    const broken = new TournamentRecoveryService(
      { $queryRaw: async () => { throw new Error('db down'); } } as unknown as PrismaService,
      {} as TournamentGameService, {} as TournamentEventsPublisher);
    assert.equal((await broken.tick()).failed, 0);
    assert.equal((await broken.tick()).skipped, false);
  });

  it('bootstrap never aborts games owned by GameService recovery', async () => {
    const h = setup([]);
    await h.service.onApplicationBootstrap();
    assert.deepEqual(h.updates, []);
    const timer = (h.service as unknown as { timer?: NodeJS.Timeout }).timer;
    assert.ok(timer && !timer.hasRef());
    h.service.onModuleDestroy();
  });
});
