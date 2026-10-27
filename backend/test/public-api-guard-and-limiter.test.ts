import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { ExecutionContext, UnauthorizedException } from '@nestjs/common';
import { ApiKeyGuard } from '../src/public-api/common/api-key.guard';
import { ApiKeyRateLimiter } from '../src/public-api/common/api-key-rate-limiter';
import { PublicApiExceptionFilter } from '../src/public-api/common/public-api-exception.filter';
import { PublicApiRetryException } from '../src/public-api/common/public-api.errors';

function createMockContext(headers: Record<string, string | string[] | undefined>) {
  const req: any = { headers };
  const res: any = {
    headers: {} as Record<string, string>,
    statusCode: 200,
    setHeader(name: string, val: string | number) {
      this.headers[name.toLowerCase()] = String(val);
    },
    hasHeader(name: string) {
      return name.toLowerCase() in this.headers;
    },
    status(code: number) {
      this.statusCode = code;
      return this;
    },
    json(body: any) {
      this.body = body;
      return this;
    },
  };

  const context: ExecutionContext = {
    switchToHttp: () => ({
      getRequest: () => req,
      getResponse: () => res,
      getNext: () => () => {},
    }),
  } as any;

  return { context, req, res };
}

describe('Public API Security: ApiKeyGuard & ApiKeyRateLimiter', () => {
  const validHex = 'a'.repeat(64);
  const validRawKey = `tr_live_${validHex}`;

  function createMockApiKeyService() {
    return {
      validateApiKey: async (key: string) => {
        if (key === validRawKey) {
          return {
            apiKeyId: 'key-uuid-1',
            user: { id: 'user-uuid-1', username: 'evaluator', email: 'eval@test.local', role: 'user' },
          };
        }
        if (key === `tr_live_${'b'.repeat(64)}`) {
          throw new UnauthorizedException({ error: { code: 'API_KEY_REVOKED', message: 'This API key has been revoked.' } });
        }
        if (key === `tr_live_${'c'.repeat(64)}`) {
          throw new UnauthorizedException({ error: { code: 'API_KEY_EXPIRED', message: 'This API key has expired.' } });
        }
        throw new UnauthorizedException({ error: { code: 'INVALID_API_KEY', message: 'Invalid API key.' } });
      },
    } as any;
  }

  /* -------------------------------------------------------------------------
   * Suite 1: Input Validation & Injection Resistance
   * ------------------------------------------------------------------------- */
  describe('Suite 1: Header Parsing & Key Format Validation', () => {
    it('rejects missing X-API-Key header with 401 MISSING_API_KEY', async () => {
      const guard = new ApiKeyGuard(createMockApiKeyService(), new ApiKeyRateLimiter());
      const { context } = createMockContext({});

      await assert.rejects(
        () => guard.canActivate(context),
        (err: any) => err.status === 401 && err.response?.error?.code === 'MISSING_API_KEY',
      );
    });

    it('rejects empty or whitespace-only header with 401 MISSING_API_KEY', async () => {
      const guard = new ApiKeyGuard(createMockApiKeyService(), new ApiKeyRateLimiter());
      const { context } = createMockContext({ 'x-api-key': '   ' });

      await assert.rejects(
        () => guard.canActivate(context),
        (err: any) => err.status === 401 && err.response?.error?.code === 'MISSING_API_KEY',
      );
    });

    it('rejects malformed prefixes and SQL injection attempts without hitting service', async () => {
      const mockService = createMockApiKeyService();
      let serviceCalled = false;
      mockService.validateApiKey = async () => {
        serviceCalled = true;
        throw new Error('Should not reach service');
      };

      const guard = new ApiKeyGuard(mockService, new ApiKeyRateLimiter());

      const malformedKeys = [
        'invalid_prefix_123',
        'tr_live_short',
        "tr_live_' OR '1'='1",
        'tr_live_<script>alert(1)</script>',
        `tr_live_${'g'.repeat(64)}`, // 'g' is not valid hex
        `tr_live_${'a'.repeat(65)}`, // too long
      ];

      for (const badKey of malformedKeys) {
        const { context } = createMockContext({ 'x-api-key': badKey });
        await assert.rejects(
          () => guard.canActivate(context),
          (err: any) => err.status === 401 && err.response?.error?.code === 'INVALID_API_KEY_FORMAT',
        );
      }

      assert.equal(serviceCalled, false, 'Service must never be called on malformed key format');
    });

    it('handles header array safely by picking the first element', async () => {
      const guard = new ApiKeyGuard(createMockApiKeyService(), new ApiKeyRateLimiter());
      const { context, req } = createMockContext({ 'x-api-key': [validRawKey, 'spoofed_key'] });

      const allowed = await guard.canActivate(context);
      assert.equal(allowed, true);
      assert.equal(req.apiKeyId, 'key-uuid-1');
      assert.equal(req.apiKeyUser?.username, 'evaluator');
    });
  });

  /* -------------------------------------------------------------------------
   * Suite 2: Authentication Lifecycles
   * ------------------------------------------------------------------------- */
  describe('Suite 2: Authentication Lifecycles', () => {
    it('authenticates valid key and attaches user and key ID to request', async () => {
      const guard = new ApiKeyGuard(createMockApiKeyService(), new ApiKeyRateLimiter());
      const { context, req } = createMockContext({ 'x-api-key': validRawKey });

      const result = await guard.canActivate(context);
      assert.equal(result, true);
      assert.equal(req.apiKeyId, 'key-uuid-1');
      assert.equal(req.apiKeyUser?.username, 'evaluator');
      assert.equal(req.apiKeyUser?.email, 'eval@test.local');
    });

    it('rejects revoked keys with 401 API_KEY_REVOKED', async () => {
      const guard = new ApiKeyGuard(createMockApiKeyService(), new ApiKeyRateLimiter());
      const { context } = createMockContext({ 'x-api-key': `tr_live_${'b'.repeat(64)}` });

      await assert.rejects(
        () => guard.canActivate(context),
        (err: any) => err.status === 401 && err.response?.error?.code === 'API_KEY_REVOKED',
      );
    });

    it('rejects expired keys with 401 API_KEY_EXPIRED', async () => {
      const guard = new ApiKeyGuard(createMockApiKeyService(), new ApiKeyRateLimiter());
      const { context } = createMockContext({ 'x-api-key': `tr_live_${'c'.repeat(64)}` });

      await assert.rejects(
        () => guard.canActivate(context),
        (err: any) => err.status === 401 && err.response?.error?.code === 'API_KEY_EXPIRED',
      );
    });
  });

  /* -------------------------------------------------------------------------
   * Suite 3: Rate Limiting & DoS Protection
   * ------------------------------------------------------------------------- */
  describe('Suite 3: Rate Limiting & DoS Protection', () => {
    it('allows requests up to the defined limit within the time window', () => {
      const limiter = new ApiKeyRateLimiter();
      const keyId = 'test-rate-key-1';

      // 5 requests allowed with limit 5
      for (let i = 0; i < 5; i++) {
        assert.doesNotThrow(() => limiter.consume(keyId, 5, 10000));
      }
    });

    it('throws 429 RATE_LIMITED on the request exceeding the limit', () => {
      const limiter = new ApiKeyRateLimiter();
      const keyId = 'test-rate-key-2';

      for (let i = 0; i < 10; i++) {
        limiter.consume(keyId, 10, 60000);
      }

      assert.throws(
        () => limiter.consume(keyId, 10, 60000),
        (err: any) => {
          assert.equal(err.status, 429);
          assert.equal(err.response?.error?.code, 'RATE_LIMITED');
          assert.ok(err.retryAfter > 0 && err.retryAfter <= 60);
          return true;
        },
      );
    });

    it('resets window after expiration timestamp', () => {
      const limiter = new ApiKeyRateLimiter();
      const keyId = 'test-rate-key-3';
      const startTime = 1000000;

      limiter.consume(keyId, 1, 1000, startTime);

      // Same window: rejected
      assert.throws(() => limiter.consume(keyId, 1, 1000, startTime + 500));

      // After window expired (1001ms later): succeeds
      assert.doesNotThrow(() => limiter.consume(keyId, 1, 1000, startTime + 1001));
    });
  });

  /* -------------------------------------------------------------------------
   * Suite 4: PublicApiExceptionFilter Headers & Information Disclosure
   * ------------------------------------------------------------------------- */
  describe('Suite 4: PublicApiExceptionFilter Defense', () => {
    it('sets Retry-After and Cache-Control: no-store on rate-limited responses', () => {
      const filter = new PublicApiExceptionFilter();
      const { context, res } = createMockContext({});
      const exception = new PublicApiRetryException(429, 'RATE_LIMITED', 'Slow down', 45);

      filter.catch(exception, context);

      assert.equal(res.statusCode, 429);
      assert.equal(res.headers['retry-after'], '45');
      assert.equal(res.headers['cache-control'], 'no-store');
      assert.deepEqual(res.body, { error: { code: 'RATE_LIMITED', message: 'Slow down' } });
    });

    it('sanitizes unexpected internal errors to avoid information leakage', () => {
      const filter = new PublicApiExceptionFilter();
      const { context, res } = createMockContext({});
      const dangerousDbError = new Error('FATAL: password authentication failed for user "postgres"');

      filter.catch(dangerousDbError, context);

      assert.equal(res.statusCode, 500);
      assert.equal(res.headers['cache-control'], 'no-store');
      assert.deepEqual(res.body, {
        error: { code: 'INTERNAL_SERVER_ERROR', message: 'An internal server error occurred.' },
      });
      // Ensure raw error message was not leaked
      assert.ok(!JSON.stringify(res.body).includes('password'));
    });
  });
});
