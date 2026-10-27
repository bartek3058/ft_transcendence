import {
  CanActivate,
  ExecutionContext,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { Request } from 'express';
import { ApiKeyService, API_KEY_PREFIX } from '../api-key/api-key.service';
import { ApiKeyRateLimiter } from './api-key-rate-limiter';
import { ValidatedApiKeyResult } from '../api-key/api-key.types';

export interface PublicApiRequest extends Request {
  apiKeyUser?: ValidatedApiKeyResult['user'];
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

    // Validate key structure before database hit to prevent query load on garbage input
    if (!apiKey.startsWith(API_KEY_PREFIX) || !API_KEY_REGEX.test(apiKey)) {
      throw new UnauthorizedException({
        error: {
          code: 'INVALID_API_KEY_FORMAT',
          message: 'Invalid API key format.',
        },
      });
    }

    // 1. Validate key cryptographic hash against database, check revocation and expiration
    const validation = await this.apiKeyService.validateApiKey(apiKey);

    // 2. Consume rate limit quota for this authenticated key (default 60 requests/minute)
    this.rateLimiter.consume(validation.apiKeyId, 60, 60000);

    // 3. Attach verified caller identity and key ID to request context
    request.apiKeyUser = validation.user;
    request.apiKeyId = validation.apiKeyId;

    return true;
  }
}
