import {
  Injectable,
  UnauthorizedException,
  NotFoundException,
  BadRequestException,
} from '@nestjs/common';
import { createHash, randomBytes } from 'node:crypto';
import { PrismaService } from '../../database/prisma.service';
import {
  ApiKeySummary,
  GeneratedApiKey,
  ValidatedApiKeyResult,
} from './api-key.types';

export const API_KEY_PREFIX = 'tr_live_';

export function hashApiKey(rawKey: string): string {
  return createHash('sha256').update(rawKey, 'utf8').digest('hex');
}

@Injectable()
export class ApiKeyService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Generates a new API key for a user.
   * Returns the rawKey ONCE. The rawKey is never persisted.
   */
  async createApiKey(
    userId: string,
    name: string,
    expiresAt?: Date | null,
  ): Promise<GeneratedApiKey> {
    const trimmedName = (name ?? '').trim();
    if (!trimmedName || trimmedName.length > 64) {
      throw new BadRequestException({
        error: {
          code: 'INVALID_API_KEY_NAME',
          message: 'Key name must be between 1 and 64 characters.',
        },
      });
    }

    if (expiresAt && expiresAt.getTime() <= Date.now()) {
      throw new BadRequestException({
        error: {
          code: 'INVALID_EXPIRATION',
          message: 'Expiration date must be in the future.',
        },
      });
    }

    // High entropy 32-byte secret encoded as hex: 64 hex chars
    const secretEntropy = randomBytes(32).toString('hex');
    const rawKey = `${API_KEY_PREFIX}${secretEntropy}`;
    const keyHash = hashApiKey(rawKey);
    const keyPrefix = rawKey.slice(0, 16);

    const record = await this.prisma.apiKey.create({
      data: {
        userId,
        name: trimmedName,
        keyPrefix,
        keyHash,
        expiresAt: expiresAt ?? null,
      },
    });

    return {
      id: record.id,
      name: record.name,
      keyPrefix: record.keyPrefix,
      rawKey,
      expiresAt: record.expiresAt,
      createdAt: record.createdAt,
    };
  }

  /**
   * Validates a raw API key from request headers.
   * Checks revocation, expiration, and updates lastUsedAt asynchronously.
   */
  async validateApiKey(rawKey: string | null | undefined): Promise<ValidatedApiKeyResult> {
    if (!rawKey || typeof rawKey !== 'string' || !rawKey.startsWith(API_KEY_PREFIX)) {
      throw new UnauthorizedException({
        error: {
          code: 'UNAUTHORIZED',
          message: 'Missing or malformed X-API-Key header.',
        },
      });
    }

    const keyHash = hashApiKey(rawKey);
    const record = await this.prisma.apiKey.findUnique({
      where: { keyHash },
      include: {
        user: {
          select: {
            id: true,
            username: true,
            email: true,
            role: true,
          },
        },
      },
    });

    if (!record || !record.user) {
      throw new UnauthorizedException({
        error: {
          code: 'INVALID_API_KEY',
          message: 'Invalid API key.',
        },
      });
    }

    if (record.revokedAt) {
      throw new UnauthorizedException({
        error: {
          code: 'API_KEY_REVOKED',
          message: 'This API key has been revoked.',
        },
      });
    }

    if (record.expiresAt && record.expiresAt.getTime() <= Date.now()) {
      throw new UnauthorizedException({
        error: {
          code: 'API_KEY_EXPIRED',
          message: 'This API key has expired.',
        },
      });
    }

    // Update lastUsedAt asynchronously without blocking request
    void this.prisma.apiKey
      .update({
        where: { id: record.id },
        data: { lastUsedAt: new Date() },
      })
      .catch(() => {});

    return {
      apiKeyId: record.id,
      user: record.user,
    };
  }

  /**
   * Lists all API keys belonging to a user (safe metadata only).
   */
  async listUserKeys(userId: string): Promise<ApiKeySummary[]> {
    return this.prisma.apiKey.findMany({
      where: { userId },
      select: {
        id: true,
        name: true,
        keyPrefix: true,
        lastUsedAt: true,
        expiresAt: true,
        revokedAt: true,
        createdAt: true,
      },
      orderBy: { createdAt: 'desc' },
    });
  }

  /**
   * Revokes an API key owned by a user.
   */
  async revokeApiKey(userId: string, keyId: string): Promise<void> {
    const key = await this.prisma.apiKey.findFirst({
      where: { id: keyId, userId },
    });

    if (!key) {
      throw new NotFoundException({
        error: {
          code: 'API_KEY_NOT_FOUND',
          message: 'API key not found.',
        },
      });
    }

    if (key.revokedAt) {
      return;
    }

    await this.prisma.apiKey.update({
      where: { id: keyId },
      data: { revokedAt: new Date() },
    });
  }
}
