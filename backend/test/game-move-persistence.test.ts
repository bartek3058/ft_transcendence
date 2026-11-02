import 'reflect-metadata';
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { GameService } from '../src/game/game.service';
import {
  classifyPersistenceError,
  computeBackoffMs,
  MOVE_PERSISTENCE_CONFIG,
  toGameMoveCreateInput,
} from '../src/game/move-persistence';
import { PendingMoveRecord } from '../src/game/types/chess.types';

const GAME_A = '11111111-1111-4111-8111-111111111111';
const GAME_B = '22222222-2222-4222-8222-222222222222';
const WHITE = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const BLACK = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

function makeMove(gameId: string, ply: number): PendingMoveRecord {
  return {
    gameId,
    ply,
    moveNumber: Math.ceil(ply / 2),
    color: ply % 2 === 1 ? 'WHITE' : 'BLACK',
    playedById: ply % 2 === 1 ? WHITE : BLACK,
    san: 'e4',
    uci: 'e2e4',
    fenAfter: 'rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq - 0 1',
    timeSpentMs: 10,
    timeRemainingMs: 1000,
    createdAt: new Date(0),
  };
}

function prismaError(code: string): Error {
  return Object.assign(new Error(`Prisma error ${code}\nsecond line`), { code });
}

/**
 * Fake PrismaService that behaves like UNIQUE(game_id, ply) + skipDuplicates
 * and lets each test script failures per call.
 */
function makeFakePrisma(script: Array<(rows: any[]) => void> = []) {
  const stored = new Map<string, any>();
  const calls: any[][] = [];
  const prisma = {
    stored,
    calls,
    gameMove: {
      async createMany(args: { data: any[]; skipDuplicates?: boolean }) {
        calls.push(args.data);
        const step = script.shift();
        if (step) step(args.data); // may throw
        for (const row of args.data) {
          const key = `${row.gameId}#${row.ply}`;
          if (stored.has(key) && !args.skipDuplicates) throw prismaError('P2002');
          if (!stored.has(key)) stored.set(key, row);
        }
        return { count: args.data.length };
      },
    },
    // removeGame() closes the `games` row after the moves are stored (#143).
    game: {
      async updateMany() {
        return { count: 1 };
      },
    },
  };
  return prisma;
}

const tick = (ms: number) => new Promise((r) => setTimeout(r, ms));

// RatingService stub: the Elo update itself is covered by game-conclusion.test.ts.
const ratingStub = { applyGameResult: async () => undefined };

function makeService(prisma?: any) {
  return new GameService(prisma, ratingStub as any);
}

describe('move-persistence helpers', () => {
  it('classifies connectivity errors as transient', () => {
    for (const code of ['P1001', 'P1002', 'P1008', 'P1017', 'P2024', 'P2034', 'ECONNRESET']) {
      assert.equal(classifyPersistenceError(prismaError(code)), 'transient', code);
    }
    const init = Object.assign(new Error('x'), { name: 'PrismaClientInitializationError' });
    assert.equal(classifyPersistenceError(init), 'transient');
  });

  it('classifies data / constraint / unknown errors as permanent', () => {
    for (const code of ['P2000', 'P2002', 'P2003', 'P2023']) {
      assert.equal(classifyPersistenceError(prismaError(code)), 'permanent', code);
    }
    assert.equal(classifyPersistenceError(new TypeError('boom')), 'permanent');
    assert.equal(classifyPersistenceError('string'), 'permanent');
    assert.equal(classifyPersistenceError(null), 'permanent');
  });

  it('computes capped exponential backoff', () => {
    assert.equal(computeBackoffMs(1), 250);
    assert.equal(computeBackoffMs(2), 500);
    assert.equal(computeBackoffMs(3), 1000);
    assert.equal(computeBackoffMs(20), MOVE_PERSISTENCE_CONFIG.retryMaxMs);
    assert.equal(computeBackoffMs(10_000), MOVE_PERSISTENCE_CONFIG.retryMaxMs);
    assert.equal(computeBackoffMs(0), 250);
  });

  it('maps a record to exactly the persisted columns', () => {
    const record = { ...makeMove(GAME_A, 1), extra: 'leak' } as PendingMoveRecord;
    const input = toGameMoveCreateInput(record);
    assert.equal('extra' in input, false);
    assert.equal(input.gameId, GAME_A);
    assert.equal(input.ply, 1);
  });
});

describe('GameService cold-path persistence', () => {
  it('persists enqueued plies in one batched, debounced write', async () => {
    const prisma = makeFakePrisma();
    const service = makeService(prisma);
    for (let ply = 1; ply <= 5; ply++) service.enqueueMoveForPersistence(makeMove(GAME_A, ply));

    // enqueue must not touch the database synchronously
    assert.equal(prisma.calls.length, 0);
    assert.equal(service.getPendingMovesCount(), 5);

    await tick(MOVE_PERSISTENCE_CONFIG.flushDelayMs + 50);
    assert.equal(prisma.calls.length, 1);
    assert.equal(prisma.calls[0].length, 5);
    assert.equal(prisma.stored.size, 5);
    assert.equal(service.getPendingMovesCount(), 0);
  });

  it('flushes immediately in batches once the batch size is reached', async () => {
    const prisma = makeFakePrisma();
    const service = makeService(prisma);
    const total = MOVE_PERSISTENCE_CONFIG.batchSize * 2 + 3;
    for (let ply = 1; ply <= total; ply++) service.enqueueMoveForPersistence(makeMove(GAME_A, ply));
    await service.flushPendingMoves();

    assert.equal(prisma.stored.size, total);
    assert.ok(prisma.calls.every((c) => c.length <= MOVE_PERSISTENCE_CONFIG.batchSize));
    assert.equal(service.getPendingMovesCount(), 0);
  });

  it('keeps records buffered on a transient failure and retries without duplicates', async () => {
    const prisma = makeFakePrisma([
      () => {
        throw prismaError('P1001');
      },
    ]);
    const service = makeService(prisma);
    service.enqueueMoveForPersistence(makeMove(GAME_A, 1));
    service.enqueueMoveForPersistence(makeMove(GAME_A, 2));

    await service.flushPendingMoves();
    assert.equal(service.getPendingMovesCount(), 2, 'nothing may be dropped');
    assert.equal(prisma.stored.size, 0);

    // removeGame-style forced retry succeeds
    await service.onModuleDestroy();
    assert.equal(prisma.stored.size, 2);
    assert.equal(service.getPendingMovesCount(), 0);
  });

  it('is idempotent when a retry repeats rows the database already stored', async () => {
    // Simulates a lost acknowledgement: rows are stored, but the caller sees an error.
    const prisma = makeFakePrisma([
      (rows) => {
        for (const row of rows) prisma.stored.set(`${row.gameId}#${row.ply}`, row);
        throw prismaError('P1017');
      },
    ]);
    const service = makeService(prisma);
    service.enqueueMoveForPersistence(makeMove(GAME_A, 1));
    await service.flushPendingMoves();
    assert.equal(service.getPendingMovesCount(), 1);

    await service.onModuleDestroy(); // retry hits the duplicate, skipDuplicates absorbs it
    assert.equal(service.getPendingMovesCount(), 0);
    assert.equal(prisma.stored.size, 1);
    assert.equal(service.getDeadLetterMoves().length, 0);
  });

  it('dead-letters a poison record without blocking the healthy ones', async () => {
    const prisma = makeFakePrisma();
    const original = prisma.gameMove.createMany.bind(prisma.gameMove);
    prisma.gameMove.createMany = async (args: any) => {
      if (args.data.some((r: any) => r.ply === 2)) throw prismaError('P2003'); // FK violation
      return original(args);
    };
    const service = makeService(prisma);
    service.enqueueMoveForPersistence(makeMove(GAME_A, 1));
    service.enqueueMoveForPersistence(makeMove(GAME_A, 2));
    service.enqueueMoveForPersistence(makeMove(GAME_A, 3));
    await service.flushPendingMoves();

    assert.equal(service.getPendingMovesCount(), 0);
    assert.deepEqual([...prisma.stored.keys()].sort(), [`${GAME_A}#1`, `${GAME_A}#3`]);
    const dead = service.getDeadLetterMoves();
    assert.equal(dead.length, 1);
    assert.equal(dead[0].record.ply, 2);
    assert.match(dead[0].reason, /^P2003/);
  });

  it('removeGame resolves only after every ply of that game is persisted', async () => {
    const prisma = makeFakePrisma();
    const service = makeService(prisma);
    service.createGame({ gameId: GAME_A, whitePlayerId: WHITE, blackPlayerId: BLACK });
    service.createGame({ gameId: GAME_B, whitePlayerId: WHITE, blackPlayerId: BLACK });
    service.enqueueMoveForPersistence(makeMove(GAME_A, 1));
    service.enqueueMoveForPersistence(makeMove(GAME_A, 2));
    service.enqueueMoveForPersistence(makeMove(GAME_B, 1));

    assert.equal(await service.removeGame(GAME_A), true);
    assert.ok(prisma.stored.has(`${GAME_A}#1`));
    assert.ok(prisma.stored.has(`${GAME_A}#2`));
    assert.equal(service.hasActiveGame(GAME_A), false);
    assert.equal(await service.removeGame('missing'), false);
  });

  it('removeGame waits for an in-flight flush instead of returning early', async () => {
    const prisma = makeFakePrisma([() => undefined]);
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const original = prisma.gameMove.createMany.bind(prisma.gameMove);
    prisma.gameMove.createMany = async (args: any) => {
      await gate;
      return original(args);
    };
    const service = makeService(prisma);
    service.createGame({ gameId: GAME_A, whitePlayerId: WHITE, blackPlayerId: BLACK });
    service.enqueueMoveForPersistence(makeMove(GAME_A, 1));
    void service.flushPendingMoves(); // flush now in flight, blocked on the gate

    let removed = false;
    const removal = service.removeGame(GAME_A).then(() => (removed = true));
    await tick(30);
    assert.equal(removed, false, 'must still be waiting for the database');

    release();
    await removal;
    assert.ok(prisma.stored.has(`${GAME_A}#1`));
  });

  it('removeGame gives up after the timeout but keeps the records buffered', async () => {
    const prisma = makeFakePrisma();
    prisma.gameMove.createMany = async () => {
      throw prismaError('P1001');
    };
    const service = makeService(prisma);
    service.createGame({ gameId: GAME_A, whitePlayerId: WHITE, blackPlayerId: BLACK });
    service.enqueueMoveForPersistence(makeMove(GAME_A, 1));

    const original = MOVE_PERSISTENCE_CONFIG.removeGameWaitMs;
    (MOVE_PERSISTENCE_CONFIG as any).removeGameWaitMs = 300;
    try {
      assert.equal(await service.removeGame(GAME_A), true);
    } finally {
      (MOVE_PERSISTENCE_CONFIG as any).removeGameWaitMs = original;
    }
    assert.equal(service.getPendingMovesCount(), 1, 'ply must stay buffered for retry');
  });

  it('keeps buffering (and never drops) when PrismaService is not injected', async () => {
    const service = makeService(undefined);
    service.createGame({ gameId: GAME_A, whitePlayerId: WHITE, blackPlayerId: BLACK });
    service.enqueueMoveForPersistence(makeMove(GAME_A, 1));
    assert.equal(await service.removeGame(GAME_A), true); // must not hang
    assert.equal(service.getPendingMovesCount(), 1);
  });

  it('persists the real executeMove output', async () => {
    const prisma = makeFakePrisma();
    const service = makeService(prisma);
    service.createGame({ gameId: GAME_A, whitePlayerId: WHITE, blackPlayerId: BLACK });
    const result = service.executeMove({ gameId: GAME_A, from: 'e2', to: 'e4' } as any, WHITE);
    assert.equal(result.success, true);
    await service.removeGame(GAME_A);

    const row = prisma.stored.get(`${GAME_A}#1`);
    assert.equal(row.color, 'WHITE');
    assert.equal(row.san, 'e4');
    assert.equal(row.uci, 'e2e4');
    assert.equal(row.playedById, WHITE);
  });
});
