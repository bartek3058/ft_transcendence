import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { ArgumentsHost, BadRequestException, ConflictException, ParseUUIDPipe } from '@nestjs/common';
import { FriendsExceptionFilter } from '../src/friends/friends-http';
import { hasErrorEnvelope } from '../src/common/http-error-envelope';

function run(error: unknown) {
  const res = {
    headers: {} as Record<string, string>,
    statusCode: 200,
    body: undefined as unknown,
    setHeader(name: string, value: string) { this.headers[name.toLowerCase()] = String(value); },
    status(code: number) { this.statusCode = code; return this; },
    json(body: unknown) { this.body = body; return this; },
  };
  const host = { switchToHttp: () => ({ getResponse: () => res }) } as unknown as ArgumentsHost;
  new FriendsExceptionFilter().catch(error, host);
  return res;
}

describe('hasErrorEnvelope', () => {
  it('accepts only an object error with a string code', () => {
    assert.equal(hasErrorEnvelope({ error: { code: 'X', message: 'm' } }), true);
    assert.equal(hasErrorEnvelope({ message: 'm', error: 'Conflict', statusCode: 409 }), false);
    assert.equal(hasErrorEnvelope({ error: { message: 'no code' } }), false);
    assert.equal(hasErrorEnvelope({ error: null }), false);
    assert.equal(hasErrorEnvelope('plain string'), false);
    assert.equal(hasErrorEnvelope(null), false);
  });
});

describe('FriendsExceptionFilter', () => {
  it('rewrites a ParseUUIDPipe rejection into the shared envelope', async () => {
    const error = await new ParseUUIDPipe().transform('not-a-uuid', { type: 'param', data: 'id' })
      .then(() => assert.fail('expected ParseUUIDPipe to reject'), (err: unknown) => err);
    assert.ok(error instanceof BadRequestException);
    const res = run(error);
    assert.equal(res.statusCode, 400);
    assert.deepEqual(res.body, { error: { code: 'INVALID_INPUT', message: 'Request validation failed.' } });
    assert.equal(res.headers['cache-control'], 'no-store');
  });

  it('does not pass through Nest default bodies with a string error field', () => {
    const res = run(new ConflictException('internal detail'));
    assert.ok(!JSON.stringify(res.body).includes('internal detail'));
  });

  it('passes the shared envelope through unchanged', () => {
    const body = { error: { code: 'ALREADY_FRIENDS', message: 'Already friends.' } };
    const res = run(new ConflictException(body));
    assert.equal(res.statusCode, 409);
    assert.deepEqual(res.body, body);
  });
});
