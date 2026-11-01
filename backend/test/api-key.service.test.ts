import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { ApiKeyService, hashApiKey, API_KEY_PREFIX } from '../src/public-api/api-key/api-key.service';
import { PrismaService } from '../src/database/prisma.service';

function createMockPrisma() {
  const store: Record<string, any> = {};

  return {
    apiKey: {
      create: async ({ data }: any) => {
        const record = {
          id: 'test-uuid-1',
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
        store[record.keyHash] = record;
        return record;
      },
      findUnique: async ({ where }: any) => {
        const record = store[where.keyHash];
        if (!record) return null;
        return {
          ...record,
          user: {
            id: record.userId,
            username: 'testuser',
            email: 'test@example.com',
            role: 'user',
          },
        };
      },
      findFirst: async ({ where }: any) => {
        for (const record of Object.values(store)) {
          if (record.id === where.id && record.userId === where.userId) {
            return record;
          }
        }
        return null;
      },
      findMany: async ({ where }: any) => {
        return Object.values(store).filter((r: any) => r.userId === where.userId);
      },
      update: async ({ where, data }: any) => {
        for (const record of Object.values(store)) {
          if (record.id === where.id) {
            Object.assign(record, data);
            return record;
          }
        }
        throw new Error('Not found');
      },
    },
  } as unknown as PrismaService;
}

describe('ApiKeyService', () => {
  it('generates a valid API key with prefix and stores SHA-256 hash', async () => {
    const mockPrisma = createMockPrisma();
    const service = new ApiKeyService(mockPrisma);

    const generated = await service.createApiKey('user-123', 'My Test Key');

    assert.ok(generated.rawKey.startsWith(API_KEY_PREFIX));
    assert.equal(generated.name, 'My Test Key');
    assert.equal(generated.keyPrefix, generated.rawKey.slice(0, 16));
    assert.equal(generated.expiresAt, null);

    const expectedHash = hashApiKey(generated.rawKey);
    const validated = await service.validateApiKey(generated.rawKey);
    assert.equal(validated.apiKeyId, generated.id);
    assert.equal(validated.user.username, 'testuser');
  });

  it('rejects keys without proper prefix or invalid hash', async () => {
    const mockPrisma = createMockPrisma();
    const service = new ApiKeyService(mockPrisma);

    await assert.rejects(
      () => service.validateApiKey('invalid_key_format'),
      { name: 'UnauthorizedException' },
    );

    await assert.rejects(
      () => service.validateApiKey(`${API_KEY_PREFIX}nonexistent1234567890abcdef`),
      { name: 'UnauthorizedException' },
    );
  });

  it('rejects revoked keys', async () => {
    const mockPrisma = createMockPrisma();
    const service = new ApiKeyService(mockPrisma);

    const generated = await service.createApiKey('user-123', 'Revocable Key');
    await service.revokeApiKey('user-123', generated.id);

    await assert.rejects(
      () => service.validateApiKey(generated.rawKey),
      (err: any) => err.status === 401 && err.response?.error?.code === 'API_KEY_REVOKED',
    );
  });

  it('rejects expired keys', async () => {
    const mockPrisma = createMockPrisma();
    const service = new ApiKeyService(mockPrisma);

    // Create key expiring in the future, then artificially expire it in mock store
    const generated = await service.createApiKey('user-123', 'Expiring Key', new Date(Date.now() + 60000));
    (mockPrisma as any).apiKey.findUnique = async () => ({
      id: generated.id,
      userId: 'user-123',
      name: 'Expiring Key',
      keyPrefix: generated.keyPrefix,
      keyHash: hashApiKey(generated.rawKey),
      expiresAt: new Date(Date.now() - 1000), // in the past
      revokedAt: null,
      lastUsedAt: null,
      user: { id: 'user-123', username: 'testuser', email: 'test@example.com', role: 'user' },
    });

    await assert.rejects(
      () => service.validateApiKey(generated.rawKey),
      (err: any) => err.status === 401 && err.response?.error?.code === 'API_KEY_EXPIRED',
    );
  });

  it('validates key name constraints', async () => {
    const mockPrisma = createMockPrisma();
    const service = new ApiKeyService(mockPrisma);

    await assert.rejects(
      () => service.createApiKey('user-123', ''),
      { name: 'BadRequestException' },
    );

    await assert.rejects(
      () => service.createApiKey('user-123', 'a'.repeat(65)),
      { name: 'BadRequestException' },
    );
  });
});
