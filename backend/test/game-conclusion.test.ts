import 'reflect-metadata'; // NestJS decorators (@Injectable) need this loaded before import
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { GameService } from '../src/game/game.service';

/* Unit tests for GameService.removeGame. They check the control flow only;
SQL validity is covered by test/integration/game-conclusion-postgres.test.ts. */

// Fake PrismaService emulating 'games' with the same conditional update the service uses.
function makeFakePrisma(rows: Record<string, { result: string }> = {}) {
  const updates: any[] = [];
  return {
    updates,
    rows,
    game: {
      async updateMany(args: any) {
        updates.push(args);
        const row = rows[args.where.id];
        if (!row || row.result !== args.where.result) return { count: 0 };
        Object.assign(row, args.data);
        return { count: 1 };
      },
    },
  };
}

function makeFakeRating(fail = false) {
  const calls: string[] = [];
  return {
    calls,
    async applyGameResult(gameId: string) {
      calls.push(gameId);
      if (fail) throw new Error('rating boom');
      return null;
    },
  };
}

function setup(opts: { initialFen?: string; rowExists?: boolean; ratingFails?: boolean } = {}) {
  const gameId = randomUUID();
  const prisma = makeFakePrisma(opts.rowExists === false ? {} : { [gameId]: { result: 'IN_PROGRESS' } });
  const rating = makeFakeRating(opts.ratingFails);
  const service = new GameService(prisma as any, rating as any);
  service.createGame({
    gameId,
    whitePlayerId: 'white-user',
    blackPlayerId: 'black-user',
    initialFen: opts.initialFen,
  });
  return { gameId, prisma, rating, service };
}

// Plays moves through the authoritative engine as the correct player.
function play(service: GameService, gameId: string, moves: [string, string][]) {
  moves.forEach(([from, to], i) => {
    const res = service.executeMove({ gameId, from, to } as any, i % 2 === 0 ? 'white-user' : 'black-user');
    assert.equal(res.success, true, `move ${from}${to} should be legal`);
  });
}

describe('GameService.removeGame (#143)', () => {
  it('returns false and touches nothing for an unknown game', async () => {
    const { prisma, rating, service } = setup();
    assert.equal(await service.removeGame(randomUUID()), false);
    assert.equal(prisma.updates.length, 0);
    assert.equal(rating.calls.length, 0);
  });

  it('persists a checkmate as BLACK_WON and triggers the rating update', async () => {
    const { gameId, prisma, rating, service } = setup();
    // Fool's mate: black mates white.
    play(service, gameId, [['f2', 'f3'], ['e7', 'e5'], ['g2', 'g4'], ['d8', 'h4']]);

    assert.equal(await service.removeGame(gameId), true);

    assert.equal(prisma.updates.length, 1);
    const { where, data } = prisma.updates[0];
    assert.deepEqual(where, { id: gameId, result: 'IN_PROGRESS' });
    assert.equal(data.result, 'BLACK_WON');
    assert.equal(data.endReason, 'CHECKMATE');
    assert.ok(data.gameEnd instanceof Date);
    assert.deepEqual(rating.calls, [gameId]);
    assert.equal(service.hasActiveGame(gameId), false);
  });

  it('persists a checkmate by white as WHITE_WON', async () => {
    // White to play Qh5xf7#: scholar's mate position.
    const { gameId, prisma, service } = setup({
      initialFen: 'r1bqkb1r/pppp1ppp/2n2n2/4p2Q/2B1P3/8/PPPP1PPP/RNB1K1NR w KQkq - 4 4',
    });
    play(service, gameId, [['h5', 'f7']]);
    assert.equal(await service.removeGame(gameId), true);
    assert.equal(prisma.updates[0].data.result, 'WHITE_WON');
    assert.equal(prisma.updates[0].data.endReason, 'CHECKMATE');
  });

  it('detects stalemate as a DRAW', async () => {
    // Black to move, no legal moves, not in check.
    const { gameId, prisma, rating, service } = setup({ initialFen: '7k/5Q2/6K1/8/8/8/8/8 b - - 0 1' });
    assert.equal(await service.removeGame(gameId), true);
    assert.equal(prisma.updates[0].data.result, 'DRAW');
    assert.equal(prisma.updates[0].data.endReason, 'STALEMATE');
    assert.equal(rating.calls.length, 1);
  });

  it('detects insufficient material as a DRAW', async () => {
    const { gameId, prisma, service } = setup({ initialFen: '8/8/8/4k3/8/8/8/4K3 w - - 0 1' });
    assert.equal(await service.removeGame(gameId), true);
    assert.equal(prisma.updates[0].data.result, 'DRAW');
    assert.equal(prisma.updates[0].data.endReason, 'INSUFFICIENT_MATERIAL');
  });

  it('uses an explicit conclusion for endings the engine cannot see (resignation / timeout)', async () => {
    const a = setup();
    assert.equal(await a.service.removeGame(a.gameId, { winnerColor: 'w', gameOverReason: 'RESIGNATION' }), true);
    assert.equal(a.prisma.updates[0].data.result, 'WHITE_WON');
    assert.equal(a.prisma.updates[0].data.endReason, 'RESIGNATION');

    const b = setup();
    assert.equal(await b.service.removeGame(b.gameId, { winnerColor: 'b', gameOverReason: 'TIMEOUT' }), true);
    assert.equal(b.prisma.updates[0].data.result, 'BLACK_WON');
    assert.equal(b.prisma.updates[0].data.endReason, 'TIMEOUT');
  });

  it('never records a winner for a draw reason', async () => {
    const { gameId, prisma, service } = setup();
    await service.removeGame(gameId, { winnerColor: 'w', gameOverReason: 'THREEFOLD_REPETITION' });
    assert.equal(prisma.updates[0].data.result, 'DRAW');
  });

  it('uses the result already stored on a finished session', async () => {
    const { gameId, prisma, service } = setup();
    const session = service.getGameSession(gameId)!;
    session.isFinished = true;
    session.winnerColor = 'b';
    session.gameOverReason = 'ABANDONMENT';
    assert.equal(await service.removeGame(gameId), true);
    assert.equal(prisma.updates[0].data.result, 'BLACK_WON');
    assert.equal(prisma.updates[0].data.endReason, 'ABANDONMENT');
  });

  it('records an unfinished game as ABORTED (unrated: applyGameResult skips it)', async () => {
    const { gameId, prisma, service } = setup();
    assert.equal(await service.removeGame(gameId), true);
    assert.equal(prisma.updates[0].data.result, 'ABORTED');
    assert.equal(prisma.updates[0].data.endReason, null);
  });

  it('does not call the rating service when no IN_PROGRESS row exists', async () => {
    const { gameId, rating, service } = setup({ rowExists: false });
    assert.equal(await service.removeGame(gameId, { winnerColor: 'w', gameOverReason: 'RESIGNATION' }), true);
    assert.equal(rating.calls.length, 0);
    assert.equal(service.hasActiveGame(gameId), false);
  });

  it('skips the database entirely for a non-UUID game id (format check before I/O)', async () => {
    const prisma = makeFakePrisma();
    const rating = makeFakeRating();
    const service = new GameService(prisma as any, rating as any);
    service.createGame({ gameId: 'not-a-uuid', whitePlayerId: 'w', blackPlayerId: 'b' });
    assert.equal(await service.removeGame('not-a-uuid'), true);
    assert.equal(prisma.updates.length, 0);
    assert.equal(rating.calls.length, 0);
  });

  it('keeps the frozen session in RAM when the database write fails, so it can be retried', async () => {
    const { gameId, prisma, rating, service } = setup();
    const realUpdate = prisma.game.updateMany;
    prisma.game.updateMany = async () => { throw new Error('db down'); };

    assert.equal(await service.removeGame(gameId, { winnerColor: 'b', gameOverReason: 'RESIGNATION' }), false);
    assert.equal(service.hasActiveGame(gameId), true);
    assert.equal(rating.calls.length, 0);
    // Frozen: no more moves accepted.
    const move = service.executeMove({ gameId, from: 'e2', to: 'e4' } as any, 'white-user');
    assert.equal(move.errorReason, 'GAME_ALREADY_FINISHED');

    // Retry without passing the conclusion again: the frozen session still carries it.
    prisma.game.updateMany = realUpdate;
    assert.equal(await service.removeGame(gameId), true);
    assert.equal(prisma.rows[gameId].result, 'BLACK_WON');
    assert.deepEqual(rating.calls, [gameId]);
  });

  it('still purges the session if the rating update throws (result is already saved)', async () => {
    const { gameId, prisma, service } = setup({ ratingFails: true });
    assert.equal(await service.removeGame(gameId, { winnerColor: 'w', gameOverReason: 'TIMEOUT' }), true);
    assert.equal(prisma.rows[gameId].result, 'WHITE_WON');
    assert.equal(service.hasActiveGame(gameId), false);
  });

  it('concludes and rates a game only once under concurrent removeGame calls', async () => {
    const { gameId, prisma, rating, service } = setup();
    const results = await Promise.all([
      service.removeGame(gameId, { winnerColor: 'w', gameOverReason: 'RESIGNATION' }),
      service.removeGame(gameId, { winnerColor: 'b', gameOverReason: 'RESIGNATION' }),
    ]);
    assert.deepEqual(results.sort(), [false, true]);
    assert.equal(prisma.updates.length, 1);
    assert.deepEqual(rating.calls, [gameId]);
  });
});
