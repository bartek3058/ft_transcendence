import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { MatchesService } from '../src/public-api/matches/matches.service';
import { ApiKeyService, API_KEY_PREFIX, hashApiKey } from '../src/public-api/api-key/api-key.service';
import { PrismaService } from '../src/database/prisma.service';

function createMockPrisma(initialData?: { games?: any[]; apiKeys?: any[] }) {
  const gamesStore: any[] = initialData?.games ? [...initialData.games] : [];
  const apiKeysStore: Record<string, any> = {};

  if (initialData?.apiKeys) {
    for (const key of initialData.apiKeys) {
      apiKeysStore[key.keyHash] = { ...key };
    }
  }

  return {
    game: {
      count: async ({ where }: any) => {
        let list = gamesStore;
        if (where?.result) list = list.filter((g) => g.result === where.result);
        if (where?.OR) {
          const username = where.OR[0]?.whitePlayer?.username?.equals?.toLowerCase();
          list = list.filter(
            (g) =>
              g.whitePlayer?.username?.toLowerCase() === username ||
              g.blackPlayer?.username?.toLowerCase() === username,
          );
        }
        return list.length;
      },
      findMany: async ({ where, skip = 0, take = 10 }: any) => {
        let list = gamesStore;
        if (where?.result) list = list.filter((g) => g.result === where.result);
        if (where?.OR) {
          const username = where.OR[0]?.whitePlayer?.username?.equals?.toLowerCase();
          list = list.filter(
            (g) =>
              g.whitePlayer?.username?.toLowerCase() === username ||
              g.blackPlayer?.username?.toLowerCase() === username,
          );
        }
        return list.slice(skip, skip + take);
      },
      findUnique: async ({ where }: any) => {
        const found = gamesStore.find((g) => g.id === where.id);
        return found ? { ...found } : null;
      },
    },
    apiKey: {
      create: async ({ data }: any) => {
        const record = {
          id: data.id ?? `key-${Date.now()}-${Math.random()}`,
          userId: data.userId,
          name: data.name,
          keyPrefix: data.keyPrefix,
          keyHash: data.keyHash,
          expiresAt: data.expiresAt,
          revokedAt: null,
          lastUsedAt: null,
          createdAt: new Date(),
          updatedAt: new Date(),
        };
        apiKeysStore[record.keyHash] = record;
        return record;
      },
      findUnique: async ({ where }: any) => {
        if (where.id) {
          return Object.values(apiKeysStore).find((k) => k.id === where.id) ?? null;
        }
        return apiKeysStore[where.keyHash] ?? null;
      },
      findMany: async ({ where, select }: any) => {
        let list = Object.values(apiKeysStore);
        if (where?.userId) list = list.filter((k) => k.userId === where.userId);
        if (select) {
          list = list.map((item) => {
            const projected: any = {};
            for (const field of Object.keys(select)) {
              if (select[field]) projected[field] = item[field];
            }
            return projected;
          });
        }
        return list;
      },
      update: async ({ where, data }: any) => {
        const record = Object.values(apiKeysStore).find((k) => k.id === where.id);
        if (!record) throw new Error('Not found');
        Object.assign(record, data);
        return record;
      },
      delete: async ({ where }: any) => {
        const record = Object.values(apiKeysStore).find((k) => k.id === where.id);
        if (!record) throw new Error('Not found');
        delete apiKeysStore[record.keyHash];
        return record;
      },
    },
  } as unknown as PrismaService;
}

describe('Public API Step 3: Match History & API Keys Full CRUD', () => {
  const match1Id = '11111111-1111-1111-1111-111111111111';
  const match2Id = '22222222-2222-2222-2222-222222222222';

  const mockGames = [
    {
      id: match1Id,
      result: 'WHITE_WON',
      endReason: 'CHECKMATE',
      timeControl: '10+0',
      whiteRatingChange: 16,
      blackRatingChange: -16,
      pgn: '1. e4 e5 2. Qh5 Nc6 3. Bc4 Nf6 4. Qxf7# 1-0',
      gameStart: new Date('2026-10-27T10:00:00Z'),
      gameEnd: new Date('2026-10-27T10:05:00Z'),
      whitePlayer: { id: 'user-1', username: 'magnus', rating: 2800 },
      blackPlayer: { id: 'user-2', username: 'hikaru', rating: 2780 },
      moves: [
        { ply: 1, moveNumber: 1, color: 'WHITE', san: 'e4', uci: 'e2e4', fenAfter: '...', timeSpentMs: 1200, timeRemainingMs: 598800 },
        { ply: 2, moveNumber: 1, color: 'BLACK', san: 'e5', uci: 'e7e5', fenAfter: '...', timeSpentMs: 900, timeRemainingMs: 599100 },
      ],
    },
    {
      id: match2Id,
      result: 'DRAW',
      endReason: 'STALEMATE',
      timeControl: '5+3',
      whiteRatingChange: 0,
      blackRatingChange: 0,
      pgn: '1. d4 d5 ... 1/2-1/2',
      gameStart: new Date('2026-10-27T11:00:00Z'),
      gameEnd: new Date('2026-10-27T11:15:00Z'),
      whitePlayer: { id: 'user-3', username: 'tomek', rating: 1550 },
      blackPlayer: { id: 'user-1', username: 'magnus', rating: 2800 },
      moves: [],
    },
  ];

  /* -------------------------------------------------------------------------
   * Suite 1: MatchesService (Issue #90)
   * ------------------------------------------------------------------------- */
  describe('Suite 1: Match History (Issue #90)', () => {
    it('returns paginated matches with default limit and pagination metadata', async () => {
      const mockPrisma = createMockPrisma({ games: mockGames });
      const service = new MatchesService(mockPrisma);

      const res = await service.findMatches({ page: 1, limit: 10 });
      assert.equal(res.total, 2);
      assert.equal(res.items.length, 2);
      assert.equal(res.page, 1);
      assert.equal(res.limit, 10);
      assert.equal(res.totalPages, 1);
      assert.equal(res.items[0].id, match1Id);
    });

    it('filters matches by player username regardless of playing white or black', async () => {
      const mockPrisma = createMockPrisma({ games: mockGames });
      const service = new MatchesService(mockPrisma);

      const res = await service.findMatches({ username: 'hikaru' });
      assert.equal(res.total, 1);
      assert.equal(res.items[0].id, match1Id);

      const resMagnus = await service.findMatches({ username: 'magnus' });
      assert.equal(resMagnus.total, 2);
    });

    it('filters matches by outcome result', async () => {
      const mockPrisma = createMockPrisma({ games: mockGames });
      const service = new MatchesService(mockPrisma);

      const res = await service.findMatches({ result: 'DRAW' as any });
      assert.equal(res.total, 1);
      assert.equal(res.items[0].id, match2Id);
    });

    it('findMatchById rejects invalid UUID format with 400 Bad Request', async () => {
      const mockPrisma = createMockPrisma({ games: mockGames });
      const service = new MatchesService(mockPrisma);

      await assert.rejects(
        () => service.findMatchById('invalid-uuid-123'),
        (err: any) => err.status === 400 && err.response?.error?.code === 'INVALID_MATCH_ID',
      );
    });

    it('findMatchById returns 404 for non-existent match', async () => {
      const mockPrisma = createMockPrisma({ games: mockGames });
      const service = new MatchesService(mockPrisma);

      await assert.rejects(
        () => service.findMatchById('99999999-9999-9999-9999-999999999999'),
        (err: any) => err.status === 404 && err.response?.error?.code === 'MATCH_NOT_FOUND',
      );
    });

    it('findMatchById returns full match details with ordered moves', async () => {
      const mockPrisma = createMockPrisma({ games: mockGames });
      const service = new MatchesService(mockPrisma);

      const match = await service.findMatchById(match1Id);
      assert.equal(match.id, match1Id);
      assert.equal(match.result, 'WHITE_WON');
      assert.equal(match.whitePlayer?.username, 'magnus');
      assert.equal(match.moves.length, 2);
      assert.equal(match.moves[0].san, 'e4');
      assert.equal(match.moves[1].san, 'e5');
    });
  });

  /* -------------------------------------------------------------------------
   * Suite 2: API Keys CRUD Lifecycle (GET, POST, PUT, DELETE)
   * ------------------------------------------------------------------------- */
  describe('Suite 2: API Keys Complete CRUD Lifecycle', () => {
    it('C: creates a key returning raw secret only once', async () => {
      const mockPrisma = createMockPrisma();
      const service = new ApiKeyService(mockPrisma);

      const created = await service.createApiKey('user-1', 'Bot Key');
      assert.ok(created.rawKey.startsWith(API_KEY_PREFIX));
      assert.equal(created.name, 'Bot Key');
      assert.equal(created.keyPrefix, created.rawKey.slice(0, 16));
    });

    it('R: lists keys with safe metadata (no raw key or hash leaked)', async () => {
      const mockPrisma = createMockPrisma();
      const service = new ApiKeyService(mockPrisma);

      await service.createApiKey('user-1', 'Key One');
      await service.createApiKey('user-1', 'Key Two');
      await service.createApiKey('user-2', 'Other User Key');

      const userKeys = await service.listUserKeys({ id: 'user-1', role: 'user' });
      assert.equal(userKeys.length, 2);
      assert.equal((userKeys[0] as any).rawKey, undefined);
      assert.equal((userKeys[0] as any).keyHash, undefined);

      // Admin sees all keys across users
      const allKeys = await service.listUserKeys({ id: 'admin-1', role: 'admin' });
      assert.equal(allKeys.length, 3);
    });

    it('R: gets single key by ID, enforcing ownership', async () => {
      const mockPrisma = createMockPrisma();
      const service = new ApiKeyService(mockPrisma);

      const created = await service.createApiKey('user-1', 'My Key');
      const retrieved = await service.getKeyById(created.id, { id: 'user-1', role: 'user' });
      assert.equal(retrieved.id, created.id);
      assert.equal(retrieved.name, 'My Key');

      // Another user cannot access it
      await assert.rejects(
        () => service.getKeyById(created.id, { id: 'user-2', role: 'user' }),
        (err: any) => err.status === 404,
      );

      // Admin can access any key
      const adminRetrieved = await service.getKeyById(created.id, { id: 'admin-1', role: 'admin' });
      assert.equal(adminRetrieved.id, created.id);
    });

    it('U: updates key name with validation and authorization', async () => {
      const mockPrisma = createMockPrisma();
      const service = new ApiKeyService(mockPrisma);

      const created = await service.createApiKey('user-1', 'Old Name');
      const updated = await service.updateApiKey(created.id, 'New Name', { id: 'user-1', role: 'user' });
      assert.equal(updated.name, 'New Name');

      // Rejects invalid names
      await assert.rejects(
        () => service.updateApiKey(created.id, '', { id: 'user-1', role: 'user' }),
        (err: any) => err.status === 400,
      );

      // Other user cannot update
      await assert.rejects(
        () => service.updateApiKey(created.id, 'Hacked', { id: 'user-2', role: 'user' }),
        (err: any) => err.status === 404,
      );
    });

    it('D: soft revokes key by default, maintaining audit trail', async () => {
      const mockPrisma = createMockPrisma();
      const service = new ApiKeyService(mockPrisma);

      const created = await service.createApiKey('user-1', 'To Revoke');
      const res = await service.deleteApiKey(created.id, false, { id: 'user-1', role: 'user' });
      assert.equal(res.message, 'API key revoked successfully.');

      const revoked = await service.getKeyById(created.id, { id: 'user-1', role: 'user' });
      assert.ok(revoked.revokedAt !== null, 'Key must have revokedAt timestamp');
    });

    it('D: permanently purges key when requested by admin', async () => {
      const mockPrisma = createMockPrisma();
      const service = new ApiKeyService(mockPrisma);

      const created = await service.createApiKey('user-1', 'To Purge');
      const res = await service.deleteApiKey(created.id, true, { id: 'admin-1', role: 'admin' });
      assert.equal(res.message, 'API key permanently deleted from database.');

      await assert.rejects(
        () => service.getKeyById(created.id, { id: 'admin-1', role: 'admin' }),
        (err: any) => err.status === 404,
      );
    });
  });
});
