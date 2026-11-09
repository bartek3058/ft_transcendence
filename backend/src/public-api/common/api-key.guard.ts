import { CanActivate, ExecutionContext, Injectable, UnauthorizedException } from '@nestjs/common';
import { Request } from 'express';
import { ApiKeyService, hashApiKey, API_KEY_PREFIX } from '../api-key/api-key.service';
import { ApiKeyRateLimiter } from './api-key-rate-limiter';

export interface PublicApiRequest extends Request {
  apiKeyUser?: { id: string; username: string; email: string; role: string };
  apiKeyId?: string;
}

// tr_live_ + 64 hex chars
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

    // format check first, no I/O
    if (!apiKey.startsWith(API_KEY_PREFIX) || !API_KEY_REGEX.test(apiKey)) {
      throw new UnauthorizedException({
        error: {
          code: 'INVALID_API_KEY_FORMAT',
          message: 'Invalid API key format.',
        },
      });
    }

    // rate limit before touching the DB, so fake keys can't hammer it
    const keyHash = hashApiKey(apiKey);
    this.rateLimiter.consume(`pre:${keyHash}`, 60, 60000);

    const validation = await this.apiKeyService.validateApiKey(apiKey);

    // only after everything passed
    this.apiKeyService.touchLastUsed(validation.apiKeyId);

    request.apiKeyUser = validation.user;
    request.apiKeyId = validation.apiKeyId;

    return true;
  }
}
