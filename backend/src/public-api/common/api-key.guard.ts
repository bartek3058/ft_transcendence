import { CanActivate, ExecutionContext, Injectable, UnauthorizedException } from '@nestjs/common';
import { Request } from 'express';
import { ApiKeyService, hashApiKey, API_KEY_PREFIX } from '../api-key/api-key.service';
import { ApiKeyRateLimiter } from './api-key-rate-limiter';

export interface PublicApiRequest extends Request {
  apiKeyUser?: { id: string; username: string; email: string; role: string };
  apiKeyId?: string;
}

// Format: tr_live_ followed by 64 hex characters = 72 characters total
const API_KEY_REGEX = /^tr_live_[0-9a-f]{64}$/;

@Injectable()
export class ApiKeyGuard implements CanActivate {
  constructor(
    private readonly apiKeyService: ApiKeyService,
    private readonly rateLimiter: ApiKeyRateLimiter,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<PublicApiRequest>();
    const rawHeader = request.headers['x-api-key'];

    const apiKey = (Array.isArray(rawHeader) ? rawHeader[0] : rawHeader)?.trim();
    if (!apiKey) {
      throw new UnauthorizedException({
        error: {
          code: 'MISSING_API_KEY',
          message: 'API key is required in the X-API-Key header.',
        },
      });
    }

    // Stage 1: Format regex — zero I/O, rejects junk and injection payloads
    if (!apiKey.startsWith(API_KEY_PREFIX) || !API_KEY_REGEX.test(apiKey)) {
      throw new UnauthorizedException({
        error: {
          code: 'INVALID_API_KEY_FORMAT',
          message: 'Invalid API key format.',
        },
      });
    }

    // Stage 2: Pre-auth rate limit — keyed on the SHA-256 hash of the raw key
    // This runs BEFORE any database query to prevent DB exhaustion from fake keys
    const keyHash = hashApiKey(apiKey);
    this.rateLimiter.consume(`pre:${keyHash}`, 60, 60000);

    // Stage 3: Database authentication — verify hash, check revocation/expiration
    const validation = await this.apiKeyService.validateApiKey(apiKey);

    // Stage 4: Post-admission — update lastUsedAt only after all checks pass
    this.apiKeyService.touchLastUsed(validation.apiKeyId);

    // Attach verified caller identity and key ID to request context
    request.apiKeyUser = validation.user;
    request.apiKeyId = validation.apiKeyId;

    return true;
  }
}
