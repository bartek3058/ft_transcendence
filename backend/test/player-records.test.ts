import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { loadPlayerRecords } from '../src/rating/player-records';
import { AI_BOT_USER_ID } from '../src/ai/ai.constants';

// Fake Prisma that records the groupBy args so we can inspect the WHERE clauses.
function makePrisma() {
  const calls: any[] = [];
  const prisma = {
    game: {
      async groupBy(args: any) {
        calls.push(args);
        return [];
      },
    },
  };
  return { prisma, calls };
}

describe('loadPlayerRecords — AI games excluded from win/loss', () => {
  it('filters out the bot as the opponent in both queries', async () => {
    const { prisma, calls } = makePrisma();
    await loadPlayerRecords(prisma as any, ['u1']);

    assert.equal(calls.length, 2);
    const whiteQuery = calls.find((c) => c.by.includes('whiteId'));
    const blackQuery = calls.find((c) => c.by.includes('blackId'));

    // User as white -> opponent is black -> exclude black = bot.
    assert.deepEqual(whiteQuery.where.blackId, { not: AI_BOT_USER_ID });
    // User as black -> opponent is white -> exclude white = bot.
    assert.deepEqual(blackQuery.where.whiteId, { not: AI_BOT_USER_ID });
  });

  it('does not query when there are no users', async () => {
    const { prisma, calls } = makePrisma();
    const records = await loadPlayerRecords(prisma as any, []);
    assert.equal(calls.length, 0);
    assert.equal(records.size, 0);
  });
});
