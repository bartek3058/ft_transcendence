import 'reflect-metadata';
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { Logger } from '@nestjs/common';
import { PrismaService } from '../src/database/prisma.service';
import { TournamentHttpError } from '../src/tournament/http/tournament.errors';
import { TournamentDeadlineScheduler } from '../src/tournament/tournament-deadline.scheduler';
import { TournamentLifecycleService } from '../src/tournament/tournament-lifecycle.service';

// Decision logic only; the SQL and concurrency are covered by the PostgreSQL test.
Logger.overrideLogger(false);

function fakePrisma(expired: string[], stuck: string[]) {
  return {
    tournament: {
      findMany: async ({ where }: { where: { status: string } }) =>
        (where.status === 'OPEN_FOR_SIGNUP' ? expired : stuck).map((id) => ({ id })),
    },
  } as unknown as PrismaService;
}

class FakeLifecycle {
  readonly calls: string[] = [];
  constructor(private readonly failures: Record<string, Error> = {}, private readonly gate?: Promise<void>) {}
  async closeAndStart(id: string) { return this.call(`close:${id}`, id); }
  async startClosed(id: string) { return this.call(`start:${id}`, id); }
  private async call(label: string, id: string) {
    this.calls.push(label);
    if (this.gate) await this.gate;
    if (this.failures[id]) throw this.failures[id];
    return 'IN_PROGRESS' as const;
  }
}

function scheduler(prisma: PrismaService, lifecycle: FakeLifecycle) {
  return new TournamentDeadlineScheduler(prisma, lifecycle as unknown as TournamentLifecycleService);
}

describe('TournamentDeadlineScheduler', () => {
  it('closes expired registrations, then retries stuck REGISTRATION_CLOSED tournaments', async () => {
    const lifecycle = new FakeLifecycle();
    const result = await scheduler(fakePrisma(['a', 'b'], ['c']), lifecycle).tick();
    assert.deepEqual(lifecycle.calls, ['close:a', 'close:b', 'start:c']);
    assert.deepEqual(result, { skipped: false, closed: 2, restarted: 1, failed: 0 });
  });

  it('keeps going after a lost race (409/404) or an unexpected error', async () => {
    const lifecycle = new FakeLifecycle({
      a: new TournamentHttpError(409, 'REGISTRATION_CLOSED', 'closed'),
      b: new Error('database hiccup'),
      c: new TournamentHttpError(404, 'TOURNAMENT_NOT_FOUND', 'gone'),
    });
    const result = await scheduler(fakePrisma(['a', 'b', 'd'], ['c', 'e']), lifecycle).tick();
    assert.deepEqual(lifecycle.calls, ['close:a', 'close:b', 'close:d', 'start:c', 'start:e']);
    assert.deepEqual(result, { skipped: false, closed: 1, restarted: 1, failed: 3 });
  });

  it('skips a tick while the previous one is still executing', async () => {
    let release!: () => void;
    const lifecycle = new FakeLifecycle({}, new Promise<void>((resolve) => { release = resolve; }));
    const s = scheduler(fakePrisma(['a'], []), lifecycle);
    const first = s.tick();
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal((await s.tick()).skipped, true);
    release();
    assert.equal((await first).closed, 1);
    assert.equal((await s.tick()).skipped, false); // flag released
    assert.deepEqual(lifecycle.calls, ['close:a', 'close:a']);
  });

  it('survives a failing scan and releases the guard', async () => {
    const prisma = { tournament: { findMany: async () => { throw new Error('db down'); } } } as unknown as PrismaService;
    const s = scheduler(prisma, new FakeLifecycle());
    assert.deepEqual(await s.tick(), { skipped: false, closed: 0, restarted: 0, failed: 0 });
    assert.equal((await s.tick()).skipped, false);
  });

  it('starts an unref()d timer on init and clears it on destroy', () => {
    const s = scheduler(fakePrisma([], []), new FakeLifecycle());
    s.onModuleInit();
    const timer = (s as unknown as { timer?: NodeJS.Timeout }).timer;
    assert.ok(timer);
    assert.equal(timer.hasRef(), false);
    s.onModuleDestroy();
    assert.equal((s as unknown as { timer?: NodeJS.Timeout }).timer, undefined);
  });
});
