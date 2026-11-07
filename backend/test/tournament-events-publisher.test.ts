import 'reflect-metadata';
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { Logger } from '@nestjs/common';
import { RegistrationClosedEvent, TournamentEventsPublisher } from '../src/tournament/tournament-events.publisher';

const event: RegistrationClosedEvent = {
  tournamentId: '3f2b8c1e-4d5a-4b6c-8d7e-9f0a1b2c3d4e', outcome: 'IN_PROGRESS', reason: 'MANUAL', at: new Date(0),
};
const tick = () => new Promise((resolve) => setImmediate(resolve));

// Silence the expected listener-failure logs.
Logger.overrideLogger(false);

describe('TournamentEventsPublisher', () => {
  it('delivers after registrationClosed() has returned (non-blocking)', async () => {
    const publisher = new TournamentEventsPublisher();
    const received: RegistrationClosedEvent[] = [];
    publisher.onRegistrationClosed((e) => { received.push(e); });
    publisher.registrationClosed(event);
    assert.equal(received.length, 0);
    await tick();
    assert.deepEqual(received, [event]);
  });

  it('isolates listeners that throw or reject', async () => {
    const publisher = new TournamentEventsPublisher();
    const received: string[] = [];
    publisher.onRegistrationClosed(() => { throw new Error('sync failure'); });
    publisher.onRegistrationClosed(async () => { throw new Error('async failure'); });
    publisher.onRegistrationClosed((e) => { received.push(e.tournamentId); });
    assert.doesNotThrow(() => publisher.registrationClosed(event));
    await tick();
    await tick();
    assert.deepEqual(received, [event.tournamentId]);
  });

  it('stops delivery after unsubscribe and on module destroy', async () => {
    const publisher = new TournamentEventsPublisher();
    let a = 0;
    let b = 0;
    const unsubscribe = publisher.onRegistrationClosed(() => { a++; });
    publisher.onRegistrationClosed(() => { b++; });
    unsubscribe();
    publisher.registrationClosed(event);
    await tick();
    assert.equal(a, 0);
    assert.equal(b, 1);
    publisher.onModuleDestroy();
    publisher.registrationClosed(event);
    await tick();
    assert.equal(b, 1);
  });
});
