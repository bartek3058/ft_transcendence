import 'reflect-metadata';
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { BadRequestException } from '@nestjs/common';
import { AuthValidationPipe } from '../src/auth/validation/auth-validation.pipe';
import { CreateInvitationDto, InvitationsQueryDto, RespondInvitationDto } from '../src/tournament/dto/invitation.dto';

// The real global pipe, exactly as configureApp() installs it.
const pipe = new AuthValidationPipe();
const ID = '3f2b8c1e-4d5a-4b6c-8d7e-9f0a1b2c3d4e';

const body = (metatype: unknown, value: unknown) =>
  pipe.transform(value, { type: 'body', metatype: metatype as never });
const query = (value: unknown) => pipe.transform(value, { type: 'query', metatype: InvitationsQueryDto });

async function rejects(promise: Promise<unknown>, label: string) {
  await assert.rejects(promise, (err: unknown) => err instanceof BadRequestException, label);
}

describe('CreateInvitationDto', () => {
  it('accepts one UUID and lowercases it', async () => {
    const dto = await body(CreateInvitationDto, { recipientId: ID.toUpperCase() }) as CreateInvitationDto;
    assert.equal(dto.recipientId, ID);
  });

  it('rejects missing, malformed, non-string and extra fields', async () => {
    for (const value of [{}, { recipientId: 'abc' }, { recipientId: 42 }, { recipientId: null },
      { recipientId: `${ID} ` }, { recipientId: ID, tournamentId: ID }]) {
      await rejects(body(CreateInvitationDto, value), JSON.stringify(value));
    }
  });
});

describe('RespondInvitationDto', () => {
  it('accepts ACCEPT and DECLINE only', async () => {
    await body(RespondInvitationDto, { response: 'ACCEPT' });
    await body(RespondInvitationDto, { response: 'DECLINE' });
    for (const response of ['accept', 'MAYBE', '', true, null]) {
      await rejects(body(RespondInvitationDto, { response }), JSON.stringify(response));
    }
    await rejects(body(RespondInvitationDto, {}), 'missing response');
  });
});

describe('InvitationsQueryDto', () => {
  it('accepts paging bounds and rejects malformed or unknown params', async () => {
    await query({});
    await query({ limit: '1', offset: '0' });
    await query({ limit: '50', offset: '9999' });
    for (const q of [{ limit: '0' }, { limit: '51' }, { offset: '-1' }, { status: 'open' }]) {
      await rejects(query(q), JSON.stringify(q));
    }
  });
});
