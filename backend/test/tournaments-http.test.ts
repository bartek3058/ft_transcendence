import 'reflect-metadata';
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { ArgumentsHost, ConflictException, ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { Prisma } from '@prisma/client';
import { AuthConfig } from '../src/auth/auth.config';
import { TournamentHttpError } from '../src/tournament/http/tournament.errors';
import { TournamentRateLimiter } from '../src/tournament/http/tournament-rate-limiter';
import {
  TOURNAMENT_LIMITS, TournamentBody, TournamentRequestGuard, TournamentsExceptionFilter,
  TournamentUserLimitGuard,
} from '../src/tournament/http/tournaments-http';

const ORIGIN = 'https://localhost';
const config = { origin: ORIGIN } as AuthConfig;
const VALID_ID = '3f2b8c1e-4d5a-4b6c-8d7e-9f0a1b2c3d4e';

class Handlers {
  @TournamentBody('title', 'description', 'maxParticipants', 'registrationDeadline')
  create() {}
  join() {}
}

/** Records every consume() call, then applies the real sliding-window logic. */
class SpyLimiter extends TournamentRateLimiter {
  readonly keys: string[] = [];
  override consume(key: string, limit: number, windowMs: number, now = Date.now()): void {
    this.keys.push(key);
    super.consume(key, limit, windowMs, now);
  }
}

interface FakeRequest {
  method: string;
  params: Record<string, string>;
  headers: Record<string, string | undefined>;
  ip: string;
  body?: unknown;
  json: boolean;
  account?: { id: string };
}

function fakeResponse() {
  return {
    headers: {} as Record<string, string>,
    statusCode: 200,
    body: undefined as unknown,
    setHeader(name: string, value: string) { this.headers[name.toLowerCase()] = String(value); },
    status(code: number) { this.statusCode = code; return this; },
    json(body: unknown) { this.body = body; return this; },
  };
}

function contextFor(req: FakeRequest, handler: () => void = Handlers.prototype.join) {
  const res = fakeResponse();
  const request = { ...req, is: (type: string) => (req.json && type === 'application/json' ? type : false) };
  const context = {
    switchToHttp: () => ({ getRequest: () => request, getResponse: () => res }),
    getHandler: () => handler,
  } as unknown as ExecutionContext;
  return { context, res };
}

function write(overrides: Partial<FakeRequest> = {}): FakeRequest {
  return {
    method: 'POST', params: {}, ip: '10.0.0.1', body: {}, json: true,
    headers: { origin: ORIGIN, 'x-csrf-protection': '1' }, ...overrides,
  };
}

function errorOf(fn: () => unknown): TournamentHttpError {
  try {
    fn();
  } catch (err) {
    assert.ok(err instanceof TournamentHttpError, `unexpected error type: ${String(err)}`);
    return err;
  }
  assert.fail('expected a TournamentHttpError');
}

function codeOf(err: TournamentHttpError): string {
  return (err.getResponse() as { error: { code: string } }).error.code;
}

function newGuard(limiter = new SpyLimiter()) {
  return { guard: new TournamentRequestGuard(config, limiter, new Reflector()), limiter };
}

describe('TournamentRequestGuard', () => {
  it('sets Cache-Control: no-store even when it rejects', () => {
    const { guard } = newGuard();
    const { context, res } = contextFor(write({ headers: {} }));
    errorOf(() => guard.canActivate(context));
    assert.equal(res.headers['cache-control'], 'no-store');
  });

  it('rejects a malformed id with 400 before any rate-limit bookkeeping', () => {
    const { guard, limiter } = newGuard();
    const { context } = contextFor({ ...write(), method: 'GET', params: { id: 'not-a-uuid' } });
    const err = errorOf(() => guard.canActivate(context));
    assert.equal(err.getStatus(), 400);
    assert.equal(codeOf(err), 'INVALID_ID');
    assert.deepEqual(limiter.keys, []);
  });

  it('admits a GET with a valid id and counts it per IP', () => {
    const { guard, limiter } = newGuard();
    const { context } = contextFor({ ...write(), method: 'GET', params: { id: VALID_ID } });
    assert.equal(guard.canActivate(context), true);
    assert.deepEqual(limiter.keys, ['tournaments:ip:10.0.0.1']);
  });

  it('rejects writes with a wrong origin or a missing CSRF header (403)', () => {
    const { guard } = newGuard();
    for (const headers of [{ origin: 'https://evil.test', 'x-csrf-protection': '1' }, { origin: ORIGIN }]) {
      const err = errorOf(() => guard.canActivate(contextFor(write({ headers })).context));
      assert.equal(err.getStatus(), 403);
      assert.equal(codeOf(err), 'REQUEST_ORIGIN_REJECTED');
    }
  });

  it('rejects non-JSON writes with 415', () => {
    const { guard } = newGuard();
    const err = errorOf(() => guard.canActivate(contextFor(write({ json: false })).context));
    assert.equal(err.getStatus(), 415);
  });

  it('rejects unknown keys, nested values, arrays and prototype keys (400)', () => {
    const { guard } = newGuard();
    const bodies: unknown[] = [
      { extra: 'x' },
      { title: { nested: true } },
      [],
      JSON.parse('{"__proto__": "x"}'),
      null,
    ];
    for (const body of bodies) {
      const err = errorOf(() => guard.canActivate(contextFor(write({ body }), Handlers.prototype.create).context));
      assert.equal(err.getStatus(), 400, `body ${JSON.stringify(body)}`);
    }
    // A handler without @TournamentBody accepts only {}.
    errorOf(() => guard.canActivate(contextFor(write({ body: { title: 'x' } })).context));
  });

  it('admits the keys declared with @TournamentBody', () => {
    const { guard } = newGuard();
    const body = { title: 'Cup', description: null, maxParticipants: 8, registrationDeadline: '2030-01-01T00:00:00Z' };
    assert.equal(guard.canActivate(contextFor(write({ body }), Handlers.prototype.create).context), true);
  });

  it('applies the per-IP sliding-window limit (429 with Retry-After)', () => {
    const { guard } = newGuard();
    for (let i = 0; i < TOURNAMENT_LIMITS.ip; i++) {
      guard.canActivate(contextFor({ ...write(), method: 'GET' }).context);
    }
    const err = errorOf(() => guard.canActivate(contextFor({ ...write(), method: 'GET' }).context));
    assert.equal(err.getStatus(), 429);
    assert.ok((err.retryAfter ?? 0) >= 1);
  });
});

describe('TournamentUserLimitGuard', () => {
  it('limits writes per user and keeps reads in a separate bucket', () => {
    const guard = new TournamentUserLimitGuard(new TournamentRateLimiter());
    const account = { id: 'user-1' };
    for (let i = 0; i < TOURNAMENT_LIMITS.userWrite; i++) {
      guard.canActivate(contextFor(write({ account })).context);
    }
    assert.equal(errorOf(() => guard.canActivate(contextFor(write({ account })).context)).getStatus(), 429);
    assert.equal(guard.canActivate(contextFor({ ...write({ account }), method: 'GET' }).context), true);
    // Another user is unaffected.
    assert.equal(guard.canActivate(contextFor(write({ account: { id: 'user-2' } })).context), true);
  });
});

describe('TournamentsExceptionFilter', () => {
  function run(error: unknown) {
    const res = fakeResponse();
    const host = { switchToHttp: () => ({ getResponse: () => res }) } as unknown as ArgumentsHost;
    new TournamentsExceptionFilter().catch(error, host);
    return res;
  }

  it('maps a plain engine ConflictException to a fixed 409 body without echoing its text', () => {
    const res = run(new ConflictException(`Tournament ${VALID_ID} cannot be started from status FINISHED.`));
    assert.equal(res.statusCode, 409);
    assert.deepEqual(res.body, { error: {
      code: 'TOURNAMENT_CONFLICT', message: 'Tournament state does not allow this action.',
    } });
    assert.equal(res.headers['cache-control'], 'no-store');
  });

  it('passes {error} bodies through and sets Retry-After when present', () => {
    const res = run(new TournamentHttpError(429, 'RATE_LIMITED', 'Too many tournament requests.', 7));
    assert.equal(res.statusCode, 429);
    assert.equal(res.headers['retry-after'], '7');
    assert.deepEqual(res.body, { error: { code: 'RATE_LIMITED', message: 'Too many tournament requests.' } });
  });

  it('maps a Prisma unique violation to 409', () => {
    const res = run(new Prisma.PrismaClientKnownRequestError('Unique constraint failed', {
      code: 'P2002', clientVersion: 'test',
    }));
    assert.equal(res.statusCode, 409);
  });

  it('maps unknown errors to 503 with Retry-After and no internal details', () => {
    const res = run(new Error('connection to 10.0.0.5:5432 refused, PRIVATE_DETAILS'));
    assert.equal(res.statusCode, 503);
    assert.equal(res.headers['retry-after'], '5');
    assert.equal(res.headers['cache-control'], 'no-store');
    assert.ok(!JSON.stringify(res.body).includes('PRIVATE_DETAILS'));
  });
});
