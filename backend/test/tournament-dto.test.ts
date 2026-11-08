import 'reflect-metadata';
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { BadRequestException } from '@nestjs/common';
import { AuthValidationPipe } from '../src/auth/validation/auth-validation.pipe';
import { CreateTournamentDto } from '../src/tournament/dto/create-tournament.dto';
import { ListTournamentsQueryDto } from '../src/tournament/dto/list-tournaments-query.dto';
import { checkRegistrationDeadline, REGISTRATION_WINDOW } from '../src/tournament/tournament-rules';

// The real global pipe, exactly as configureApp() installs it.
const pipe = new AuthValidationPipe();

const valid = {
  title: 'Autumn Cup',
  maxParticipants: 8,
  registrationDeadline: '2030-01-01T12:00:00Z',
};

function body(value: unknown) {
  return pipe.transform(value, { type: 'body', metatype: CreateTournamentDto });
}

function query(value: unknown) {
  return pipe.transform(value, { type: 'query', metatype: ListTournamentsQueryDto });
}

async function accepts(promise: Promise<unknown>) {
  return promise;
}

async function rejects(promise: Promise<unknown>, label: string) {
  await assert.rejects(promise, (err: unknown) => err instanceof BadRequestException, label);
}

describe('CreateTournamentDto: title', () => {
  it('accepts 3 and 64 characters and trims surrounding whitespace', async () => {
    await accepts(body({ ...valid, title: 'abc' }));
    await accepts(body({ ...valid, title: 'a'.repeat(64) }));
    const dto = await body({ ...valid, title: '  Cup  ' }) as CreateTournamentDto;
    assert.equal(dto.title, 'Cup');
  });

  it('counts code points like PostgreSQL, not UTF-16 units', async () => {
    await accepts(body({ ...valid, title: '😀😀😀' }));
    // .length is 4, but PostgreSQL char_length is 2: must be rejected before the DB check.
    await rejects(body({ ...valid, title: '😀😀' }), 'two emoji');
  });

  it('rejects too short, too long, blank-padded, invalid and non-string titles', async () => {
    const titles: unknown[] = ['ab', 'a'.repeat(65), '  ab  ', 'ab\ud800', 'a\tb c', 'a\nbc', 123, null];
    for (const title of titles) await rejects(body({ ...valid, title }), `title ${JSON.stringify(title)}`);
    const { title: _omit, ...withoutTitle } = valid;
    await rejects(body(withoutTitle), 'missing title');
  });
});

describe('CreateTournamentDto: description', () => {
  it('accepts missing, null and 255 characters', async () => {
    await accepts(body(valid));
    await accepts(body({ ...valid, description: null }));
    await accepts(body({ ...valid, description: 'd'.repeat(255) }));
  });

  it('rejects 256 characters and control characters', async () => {
    await rejects(body({ ...valid, description: 'd'.repeat(256) }), '256 chars');
    await rejects(body({ ...valid, description: 'line\nbreak' }), 'newline');
    await rejects(body({ ...valid, description: 42 }), 'number');
  });
});

describe('CreateTournamentDto: maxParticipants', () => {
  it('accepts every bracket size', async () => {
    for (const size of [2, 4, 8, 16, 32]) await accepts(body({ ...valid, maxParticipants: size }));
  });

  it('rejects other sizes, strings and fractions', async () => {
    for (const size of [3, 64, 0, '8', 8.0000001, null]) {
      await rejects(body({ ...valid, maxParticipants: size }), `size ${JSON.stringify(size)}`);
    }
  });
});

describe('CreateTournamentDto: registrationDeadline', () => {
  it('accepts full date-times with Z or an explicit offset', async () => {
    await accepts(body({ ...valid, registrationDeadline: '2030-01-01T12:00:00Z' }));
    await accepts(body({ ...valid, registrationDeadline: '2030-01-01T12:00:00.250+02:00' }));
  });

  it('rejects bare dates, local times, impossible dates and non-strings', async () => {
    const deadlines: unknown[] = ['2030-01-01', '2030-01-01T12:00:00', '2030-02-30T12:00:00Z', 1893456000000];
    for (const deadline of deadlines) {
      await rejects(body({ ...valid, registrationDeadline: deadline }), `deadline ${JSON.stringify(deadline)}`);
    }
  });
});

describe('CreateTournamentDto: unknown fields', () => {
  it('rejects fields outside the DTO', async () => {
    await rejects(body({ ...valid, creatorId: '3f2b8c1e-4d5a-4b6c-8d7e-9f0a1b2c3d4e' }), 'creatorId');
  });
});

describe('ListTournamentsQueryDto', () => {
  it('accepts each tab and the limit bounds', async () => {
    await accepts(query({}));
    for (const status of ['open', 'live', 'past']) await accepts(query({ status }));
    await accepts(query({ limit: '1', offset: '0' }));
    await accepts(query({ limit: '50', offset: '9999' }));
  });

  it('rejects out-of-range or malformed values and repeated params', async () => {
    const queries: unknown[] = [
      { limit: '0' }, { limit: '51' }, { limit: '5.5' }, { offset: '-1' }, { offset: '10000' },
      { status: 'foo' }, { status: ['open', 'past'] }, { extra: '1' },
    ];
    for (const q of queries) await rejects(query(q), `query ${JSON.stringify(q)}`);
  });
});

describe('checkRegistrationDeadline', () => {
  const now = new Date('2030-01-01T00:00:00Z');
  const at = (ms: number) => new Date(now.getTime() + ms);

  it('enforces the 5 minute lead time and the 30 day horizon', () => {
    assert.equal(checkRegistrationDeadline(at(REGISTRATION_WINDOW.minLeadMs - 1000), now), 'TOO_SOON');
    assert.equal(checkRegistrationDeadline(at(-1), now), 'TOO_SOON');
    assert.equal(checkRegistrationDeadline(at(REGISTRATION_WINDOW.minLeadMs), now), null);
    assert.equal(checkRegistrationDeadline(at(REGISTRATION_WINDOW.maxHorizonMs), now), null);
    assert.equal(checkRegistrationDeadline(at(REGISTRATION_WINDOW.maxHorizonMs + 1), now), 'TOO_FAR');
  });
});
