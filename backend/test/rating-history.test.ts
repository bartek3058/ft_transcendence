import 'reflect-metadata';
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { PATH_METADATA } from '@nestjs/common/constants';
import { AuthValidationPipe } from '../src/auth/validation/auth-validation.pipe';
import { ProfileController } from '../src/profile/profile.controller';
import { ProfileService } from '../src/profile/profile.service';
import { RatingHistoryQueryDto } from '../src/profile/dto/rating-history-query.dto';

// GET /api/profile/me/rating-history: query validation and the mapping to chart points.
// The real query (filters, ordering, snapshots written by RatingService) is in
// test/integration/rating-history-postgres.test.ts.
const ME = 'me-id';
const pipe = new AuthValidationPipe();
const query = (value: unknown) => pipe.transform(value, { type: 'query', metatype: RatingHistoryQueryDto });

// rows come back newest first, like the real orderBy
function fakePrisma(rows: any[], rating = 1234) {
  const calls: any[] = [];
  return {
    calls,
    user: { findUnique: async () => (rating === null ? null : { rating }) },
    game: {
      count: async (args: any) => { calls.push(['count', args]); return rows.length; },
      findMany: async (args: any) => { calls.push(['findMany', args]); return rows.slice(0, args.take); },
    },
  };
}

const row = (id: string, white: boolean, result: string, before: number, change: number, end: string) => ({
  id, whiteId: white ? ME : 'other', result,
  whiteRating: white ? before : 1500, blackRating: white ? 1500 : before,
  whiteRatingChange: white ? change : -change, blackRatingChange: white ? -change : change,
  gameStart: new Date(end), gameEnd: new Date(end),
  whitePlayer: { username: white ? 'me' : 'bob' }, blackPlayer: { username: white ? 'bob' : 'me' },
});

describe('rating history query', () => {
  it('defaults to 100 and accepts 1..500', async () => {
    assert.equal(((await query({})) as RatingHistoryQueryDto).limit, 100);
    assert.equal(((await query({ limit: '500' })) as RatingHistoryQueryDto).limit, 500);
    for (const limit of ['0', '501', '-1', '1.5', 'abc']) {
      await assert.rejects(query({ limit }), { status: 400 }, limit);
    }
    await assert.rejects(query({ limit: '10', userId: 'x' }), { status: 400 });
  });

  it('is served at profile/me/rating-history', () => {
    assert.equal(Reflect.getMetadata(PATH_METADATA, ProfileController), 'profile');
    assert.equal(Reflect.getMetadata(PATH_METADATA, ProfileController.prototype.myRatingHistory), 'me/rating-history');
  });
});

describe('ProfileService.getMyRatingHistory', () => {
  it('returns oldest first with before/after from the game snapshot', async () => {
    const prisma = fakePrisma([
      row('g3', true, 'DRAW', 1216, 0, '2026-11-03'),
      row('g2', false, 'WHITE_WON', 1232, -16, '2026-11-02'),
      row('g1', true, 'WHITE_WON', 1200, 16, '2026-11-01'),
    ], 1216);
    const history = await new ProfileService(prisma as any).getMyRatingHistory(ME, 100);

    assert.deepEqual(history.points.map((p) => p.gameId), ['g1', 'g2', 'g3']);
    assert.deepEqual(history.points.map((p) => [p.ratingBefore, p.change, p.ratingAfter]),
      [[1200, 16, 1216], [1232, -16, 1216], [1216, 0, 1216]]);
    assert.deepEqual(history.points.map((p) => p.outcome), ['WIN', 'LOSS', 'DRAW']);
    assert.deepEqual(history.points.map((p) => p.opponent), ['bob', 'bob', 'bob']);
    assert.deepEqual([history.currentRating, history.total, history.limit], [1216, 3, 100]);
  });

  it('asks only for rated finished games of this user and clamps the limit', async () => {
    const prisma = fakePrisma([]);
    const history = await new ProfileService(prisma as any).getMyRatingHistory(ME, 9999);
    assert.equal(history.limit, 500);
    assert.deepEqual(history.points, []);
    const [, findMany] = prisma.calls.find(([name]) => name === 'findMany');
    assert.equal(findMany.take, 500);
    assert.deepEqual(findMany.where.result, { in: ['WHITE_WON', 'BLACK_WON', 'DRAW'] });
    assert.deepEqual(findMany.where.OR, [
      { whiteId: ME, whiteRating: { not: null }, whiteRatingChange: { not: null } },
      { blackId: ME, blackRating: { not: null }, blackRatingChange: { not: null } },
    ]);
    // never the live users.rating for points
    assert.equal(findMany.select.whitePlayer.select.rating, undefined);
  });

  it('404 when the account is gone', async () => {
    await assert.rejects(new ProfileService(fakePrisma([], null as any) as any).getMyRatingHistory(ME), { status: 404 });
  });
});
