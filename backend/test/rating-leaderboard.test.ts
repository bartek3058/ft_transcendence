import 'reflect-metadata'; // RatingService is @Injectable, so decorators need this
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { RatingService } from '../src/rating/rating.service';

// Fake PrismaService: hands back whatever rows we give it and records the findMany args.
function makeService(rows: any[]) {
  const calls: any[] = [];
  const prisma = {
    calls,
    user: {
      async findMany(args: any) {
        calls.push(args);
        return rows;
      },
    },
  };
  const service = new RatingService(prisma as any);
  return { service, prisma };
}

describe('RatingService.getLeaderboard', () => {
  it('numbers ranks from 1 at offset 0', async () => {
    const rows = [
      { id: 'a', username: 'alice', rating: 1700 },
      { id: 'b', username: 'bob', rating: 1500 },
      { id: 'c', username: 'cara', rating: 1400 },
    ];
    const { service } = makeService(rows);
    const result = await service.getLeaderboard(10, 0);
    assert.deepEqual(result.map((r) => r.rank), [1, 2, 3]);
    assert.equal(result[0].username, 'alice');
  });

  it('keeps counting ranks across pages via offset', async () => {
    const rows = [
      { id: 'k', username: 'kate', rating: 1200 },
      { id: 'l', username: 'leo', rating: 1180 },
    ];
    const { service } = makeService(rows);
    const result = await service.getLeaderboard(2, 10);
    assert.deepEqual(result.map((r) => r.rank), [11, 12]);
  });

  it('orders by rating desc and forwards the pagination args', async () => {
    const { service, prisma } = makeService([]);
    await service.getLeaderboard(5, 15);
    const args = prisma.calls[0];
    assert.deepEqual(args.orderBy, [{ rating: 'desc' }, { username: 'asc' }]);
    assert.equal(args.skip, 15);
    assert.equal(args.take, 5);
    assert.deepEqual(args.select, { id: true, username: true, rating: true });
  });

  it('falls back to default limit/offset when called with no args', async () => {
    const { service, prisma } = makeService([]);
    await service.getLeaderboard();
    assert.equal(prisma.calls[0].skip, 0);
    assert.equal(prisma.calls[0].take, 20);
  });
});
