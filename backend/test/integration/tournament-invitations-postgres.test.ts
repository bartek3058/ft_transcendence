import 'reflect-metadata';
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { Logger } from '@nestjs/common';
import { PrismaService } from '../../src/database/prisma.service';
import { TournamentHttpError } from '../../src/tournament/http/tournament.errors';
import { TournamentBracketService } from '../../src/tournament/tournament-bracket.service';
import {
  InvitationAnsweredEvent, InvitationReceivedEvent, TournamentEventsPublisher,
} from '../../src/tournament/tournament-events.publisher';
import { TournamentInvitationsService } from '../../src/tournament/tournament-invitations.service';
import { TournamentLifecycleService } from '../../src/tournament/tournament-lifecycle.service';
import { TournamentsService } from '../../src/tournament/tournaments.service';
import { requireTestDatabaseUrl } from '../test-database-url';

// Real PostgreSQL test for tournament invitations (#154): friendship and membership
// checks, the ON CONFLICT re-invite, accept through the shared conditional join,
// expiry on close/cancel, races, and events after commit only.
Logger.overrideLogger(['error']);

const prisma = new PrismaService({
  datasources: { db: { url: requireTestDatabaseUrl(process.env.TEST_DATABASE_URL) } },
});
const publisher = new TournamentEventsPublisher();
const lifecycle = new TournamentLifecycleService(prisma, new TournamentBracketService(prisma), publisher);
const tournaments = new TournamentsService(prisma, lifecycle, publisher);
const invitations = new TournamentInvitationsService(prisma, tournaments, publisher);

const userIds: string[] = [];
const tournamentIds: string[] = [];
const MINUTE = 60_000;

async function createUser() {
  const suffix = randomUUID().replace(/-/g, '').slice(0, 12);
  const user = await prisma.user.create({ data: {
    email: `t154_${suffix}@example.test`, username: `t154_${suffix}`,
    passwordHash: '$argon2id$test-fixture-not-a-real-password',
  } });
  userIds.push(user.id);
  return user;
}

async function befriend(a: string, b: string) {
  const [userLowId, userHighId] = [a, b].sort();
  await prisma.friendship.create({ data: {
    userLowId, userHighId, requestedById: a, status: 'ACCEPTED', acceptedAt: new Date(Date.now() + 1000),
  } });
}

async function createTournament(creatorId: string, maxParticipants = 8) {
  const t = await tournaments.create(creatorId, {
    title: `t154 ${randomUUID().slice(0, 8)}`, maxParticipants,
    registrationDeadline: new Date(Date.now() + 10 * MINUTE).toISOString(),
  });
  tournamentIds.push(t.id);
  return t;
}

/** Creator with `count` friends, plus a tournament. */
async function setup(count = 1, maxParticipants = 8) {
  const creator = await createUser();
  const friends = [];
  for (let i = 0; i < count; i++) {
    const f = await createUser();
    await befriend(creator.id, f.id);
    friends.push(f);
  }
  const t = await createTournament(creator.id, maxParticipants);
  return { creator, friends, tournamentId: t.id };
}

async function expectError(promise: Promise<unknown>, status: number, code: string) {
  await assert.rejects(promise, (err: unknown) => {
    assert.ok(err instanceof TournamentHttpError, `expected TournamentHttpError, got ${String(err)}`);
    assert.equal(err.getStatus(), status);
    assert.equal((err.getResponse() as { error: { code: string } }).error.code, code);
    return true;
  });
}

const codeOf = (r: PromiseSettledResult<unknown>) => r.status === 'fulfilled'
  ? undefined : ((r.reason as TournamentHttpError).getResponse() as { error: { code: string } }).error.code;
const invitationOf = (tournamentId: string, recipientId: string) =>
  prisma.tournamentInvitation.findUniqueOrThrow({ where: { tournamentId_recipientId: { tournamentId, recipientId } } });
const settle = () => new Promise((resolve) => setTimeout(resolve, 100));

function recordEvents(tournamentId: string) {
  const received: InvitationReceivedEvent[] = [];
  const answered: InvitationAnsweredEvent[] = [];
  const offA = publisher.onInvitationReceived((e) => { if (e.tournamentId === tournamentId) received.push(e); });
  const offB = publisher.onInvitationAnswered((e) => { if (e.tournamentId === tournamentId) answered.push(e); });
  return { received, answered, stop: () => { offA(); offB(); } };
}

describe('Tournament invitations against PostgreSQL (#154)', () => {
  before(async () => { await prisma.$connect(); });

  after(async () => {
    try {
      // Fixtures only (dedicated *_test database): tournaments cascade to invitations;
      // users cascade to friendships.
      await prisma.tournament.deleteMany({ where: { id: { in: tournamentIds } } });
      await prisma.user.deleteMany({ where: { id: { in: userIds } } });
    } finally {
      await prisma.$disconnect();
    }
  });

  describe('invite', () => {
    it('the creator invites a friend; expiry is the registration deadline; one event after commit', async () => {
      const { creator, friends: [friend], tournamentId } = await setup();
      const rec = recordEvents(tournamentId);
      try {
        const created = await invitations.invite(creator.id, tournamentId, friend.id);
        const t = await prisma.tournament.findUniqueOrThrow({ where: { id: tournamentId } });
        assert.deepEqual([created.status, created.recipientId, created.expiresAt.getTime()],
          ['PENDING', friend.id, t.registrationDeadline.getTime()]);
        await settle();
        assert.deepEqual(rec.received.map((e) => [e.invitationId, e.senderId, e.recipientId]),
          [[created.invitationId, creator.id, friend.id]]);
      } finally {
        rec.stop();
      }
    });

    it('a registered participant may invite their own friends; others get 403', async () => {
      const { creator, friends: [member], tournamentId } = await setup();
      await tournaments.join(member.id, tournamentId);
      const membersFriend = await createUser();
      await befriend(member.id, membersFriend.id);
      await invitations.invite(member.id, tournamentId, membersFriend.id);

      const outsider = await createUser();
      const outsidersFriend = await createUser();
      await befriend(outsider.id, outsidersFriend.id);
      await expectError(invitations.invite(outsider.id, tournamentId, outsidersFriend.id), 403, 'NOT_ALLOWED_TO_INVITE');
      // The creator does not need to be registered to invite.
      assert.equal(await prisma.tournamentParticipant.count({ where: { tournamentId, userId: creator.id } }), 0);
    });

    it('rejects self, non-friends (incl. pending friendships), joined players and live duplicates', async () => {
      const { creator, friends: [friend], tournamentId } = await setup();
      await expectError(invitations.invite(creator.id, tournamentId, creator.id), 400, 'SELF_INVITE');
      const stranger = await createUser();
      await expectError(invitations.invite(creator.id, tournamentId, stranger.id), 403, 'NOT_FRIEND');
      const pending = await createUser();
      const [userLowId, userHighId] = [creator.id, pending.id].sort();
      await prisma.friendship.create({ data: { userLowId, userHighId, requestedById: creator.id } });
      await expectError(invitations.invite(creator.id, tournamentId, pending.id), 403, 'NOT_FRIEND');
      await expectError(invitations.invite(creator.id, tournamentId, randomUUID()), 403, 'NOT_FRIEND');

      await invitations.invite(creator.id, tournamentId, friend.id);
      await expectError(invitations.invite(creator.id, tournamentId, friend.id), 409, 'ALREADY_INVITED');

      const joined = await createUser();
      await befriend(creator.id, joined.id);
      await tournaments.join(joined.id, tournamentId);
      await expectError(invitations.invite(creator.id, tournamentId, joined.id), 409, 'ALREADY_JOINED');
    });

    it('404 for an unknown tournament; 409 once registration is closed or past the deadline', async () => {
      const { creator, friends: [friend], tournamentId } = await setup();
      await expectError(invitations.invite(creator.id, randomUUID(), friend.id), 404, 'TOURNAMENT_NOT_FOUND');
      await prisma.tournament.update({ where: { id: tournamentId }, data: { registrationDeadline: new Date(Date.now() - MINUTE) } });
      await expectError(invitations.invite(creator.id, tournamentId, friend.id), 409, 'REGISTRATION_CLOSED');
      await prisma.tournament.update({ where: { id: tournamentId }, data: {
        registrationDeadline: new Date(Date.now() + 10 * MINUTE), status: 'CANCELLED',
      } });
      await expectError(invitations.invite(creator.id, tournamentId, friend.id), 409, 'REGISTRATION_CLOSED');
    });

    it('re-invites after a decline, after expiry and after accept-then-leave, keeping one row', async () => {
      const { creator, friends: [friend], tournamentId } = await setup();
      const first = await invitations.invite(creator.id, tournamentId, friend.id);
      await invitations.respond(friend.id, first.invitationId, 'DECLINE');
      const again = await invitations.invite(creator.id, tournamentId, friend.id);
      assert.equal(again.invitationId, first.invitationId);
      assert.equal((await invitationOf(tournamentId, friend.id)).status, 'PENDING');

      await prisma.tournamentInvitation.update({ where: { id: first.invitationId }, data: { expiresAt: new Date(Date.now() - 1000), createdAt: new Date(Date.now() - 2000) } });
      await invitations.invite(creator.id, tournamentId, friend.id); // pending but expired -> fresh
      assert.ok((await invitationOf(tournamentId, friend.id)).expiresAt.getTime() > Date.now());

      await invitations.respond(friend.id, first.invitationId, 'ACCEPT');
      await tournaments.leave(friend.id, tournamentId);
      await invitations.invite(creator.id, tournamentId, friend.id);
      assert.equal((await invitationOf(tournamentId, friend.id)).status, 'PENDING');
      assert.equal(await prisma.tournamentInvitation.count({ where: { tournamentId, recipientId: friend.id } }), 1);
    });

    it('two members inviting the same friend at once: one invitation, one ALREADY_INVITED', async () => {
      const { creator, friends: [member, target], tournamentId } = await setup(2);
      await befriend(member.id, target.id);
      await tournaments.join(member.id, tournamentId);
      const results = await Promise.allSettled([
        invitations.invite(creator.id, tournamentId, target.id),
        invitations.invite(member.id, tournamentId, target.id),
      ]);
      assert.deepEqual(results.map(codeOf).sort(), [undefined, 'ALREADY_INVITED'].sort());
      assert.equal(await prisma.tournamentInvitation.count({ where: { tournamentId, recipientId: target.id } }), 1);
    });
  });

  describe('my invitations', () => {
    it('lists only pending, unexpired invitations of open tournaments, soonest first, without private fields', async () => {
      const friend = await createUser();
      const ids: string[] = [];
      for (const minutes of [20, 8, 15]) {
        const creator = await createUser();
        await befriend(creator.id, friend.id);
        const t = await tournaments.create(creator.id, {
          title: `t154 ${randomUUID().slice(0, 8)}`, maxParticipants: 4,
          registrationDeadline: new Date(Date.now() + minutes * MINUTE).toISOString(),
        });
        tournamentIds.push(t.id);
        ids.push((await invitations.invite(creator.id, t.id, friend.id)).invitationId);
      }
      // Hidden: one declined, one whose tournament was cancelled (expired by cancel).
      for (const hidden of ['declined', 'cancelled']) {
        const { creator, tournamentId } = await setup(0);
        await befriend(creator.id, friend.id);
        const inv = await invitations.invite(creator.id, tournamentId, friend.id);
        if (hidden === 'declined') await invitations.respond(friend.id, inv.invitationId, 'DECLINE');
        else await lifecycle.cancel(tournamentId);
      }

      const page = await invitations.mine(friend.id, {});
      assert.deepEqual(page.items.map((i) => i.id), [ids[1], ids[2], ids[0]]);
      assert.deepEqual([page.total, page.limit, page.offset], [3, 20, 0]);
      const json = JSON.stringify(page);
      assert.ok(!json.includes('"rating"') && !json.includes('"email"'));
      assert.deepEqual((await invitations.mine(friend.id, { limit: '1', offset: '1' })).items.map((i) => i.id), [ids[2]]);
    });
  });

  describe('respond', () => {
    it('accept joins the tournament and marks the invitation; repeating it is idempotent', async () => {
      const { creator, friends: [friend], tournamentId } = await setup();
      const inv = await invitations.invite(creator.id, tournamentId, friend.id);
      const rec = recordEvents(tournamentId);
      try {
        const answer = await invitations.respond(friend.id, inv.invitationId, 'ACCEPT');
        assert.deepEqual(answer, { invitationId: inv.invitationId, tournamentId, status: 'ACCEPTED', currentParticipants: 1 });
        assert.equal(await prisma.tournamentParticipant.count({ where: { tournamentId, userId: friend.id } }), 1);
        assert.equal((await invitations.respond(friend.id, inv.invitationId, 'ACCEPT')).status, 'ACCEPTED');
        await expectError(invitations.respond(friend.id, inv.invitationId, 'DECLINE'), 409, 'INVITATION_ALREADY_ANSWERED');
        await settle();
        assert.deepEqual(rec.answered.map((e) => [e.status, e.senderId]), [['ACCEPTED', creator.id]]);
      } finally {
        rec.stop();
      }
    });

    it('accept on a full tournament: 409 TOURNAMENT_FULL, invitation stays PENDING, no event', async () => {
      const { creator, friends: [friend, other], tournamentId } = await setup(2, 2);
      const inv = await invitations.invite(creator.id, tournamentId, friend.id);
      await tournaments.join(creator.id, tournamentId);
      await tournaments.join(other.id, tournamentId);
      const rec = recordEvents(tournamentId);
      try {
        await expectError(invitations.respond(friend.id, inv.invitationId, 'ACCEPT'), 409, 'TOURNAMENT_FULL');
        await settle();
        assert.equal((await invitationOf(tournamentId, friend.id)).status, 'PENDING');
        assert.equal(rec.answered.length, 0);
      } finally {
        rec.stop();
      }
    });

    it('decline; then accept gives 409; someone else\'s invitation is 404; expired is 409', async () => {
      const { creator, friends: [friend, second], tournamentId } = await setup(2);
      const inv = await invitations.invite(creator.id, tournamentId, friend.id);
      await expectError(invitations.respond(creator.id, inv.invitationId, 'ACCEPT'), 404, 'INVITATION_NOT_FOUND');
      await expectError(invitations.respond(friend.id, randomUUID(), 'ACCEPT'), 404, 'INVITATION_NOT_FOUND');
      assert.equal((await invitations.respond(friend.id, inv.invitationId, 'DECLINE')).status, 'DECLINED');
      assert.equal((await invitations.respond(friend.id, inv.invitationId, 'DECLINE')).status, 'DECLINED');
      await expectError(invitations.respond(friend.id, inv.invitationId, 'ACCEPT'), 409, 'INVITATION_ALREADY_ANSWERED');

      const late = await invitations.invite(creator.id, tournamentId, second.id);
      await prisma.tournamentInvitation.update({ where: { id: late.invitationId }, data: {
        createdAt: new Date(Date.now() - 2000), expiresAt: new Date(Date.now() - 1000),
      } });
      await expectError(invitations.respond(second.id, late.invitationId, 'ACCEPT'), 409, 'INVITATION_EXPIRED');
      await expectError(invitations.respond(second.id, late.invitationId, 'DECLINE'), 409, 'INVITATION_EXPIRED');
    });

    it('a direct join marks the pending invitation ACCEPTED and announces it', async () => {
      const { creator, friends: [friend], tournamentId } = await setup();
      const inv = await invitations.invite(creator.id, tournamentId, friend.id);
      const rec = recordEvents(tournamentId);
      try {
        await tournaments.join(friend.id, tournamentId);
        await settle();
        assert.equal((await invitationOf(tournamentId, friend.id)).status, 'ACCEPTED');
        assert.deepEqual(rec.answered.map((e) => [e.invitationId, e.status]), [[inv.invitationId, 'ACCEPTED']]);
      } finally {
        rec.stop();
      }
    });

    it('accept racing direct joins for the last slot never overbooks', async () => {
      for (let round = 0; round < 5; round++) {
        const { creator, friends: [friend, a, b], tournamentId } = await setup(3, 2);
        await tournaments.join(creator.id, tournamentId);
        const inv = await invitations.invite(creator.id, tournamentId, friend.id);
        const results = await Promise.allSettled([
          invitations.respond(friend.id, inv.invitationId, 'ACCEPT'),
          tournaments.join(a.id, tournamentId),
          tournaments.join(b.id, tournamentId),
        ]);
        assert.equal(results.filter((r) => r.status === 'fulfilled').length, 1);
        const t = await prisma.tournament.findUniqueOrThrow({ where: { id: tournamentId } });
        const rows = await prisma.tournamentParticipant.count({ where: { tournamentId } });
        assert.deepEqual([t.currentParticipants, rows], [2, 2]);
        const status = (await invitationOf(tournamentId, friend.id)).status;
        assert.equal(status, results[0].status === 'fulfilled' ? 'ACCEPTED' : 'PENDING');
      }
    });
  });

  describe('end of registration', () => {
    it('close and cancel expire pending invitations; answered ones are kept', async () => {
      for (const end of ['close', 'cancel'] as const) {
        const { creator, friends: [pending, declined, member], tournamentId } = await setup(3);
        await tournaments.join(creator.id, tournamentId);
        await tournaments.join(member.id, tournamentId);
        await invitations.invite(creator.id, tournamentId, pending.id);
        const d = await invitations.invite(creator.id, tournamentId, declined.id);
        await invitations.respond(declined.id, d.invitationId, 'DECLINE');
        if (end === 'close') await tournaments.closeRegistration(creator.id, tournamentId);
        else await tournaments.cancel(creator.id, tournamentId);
        assert.equal((await invitationOf(tournamentId, pending.id)).status, 'EXPIRED', end);
        assert.equal((await invitationOf(tournamentId, declined.id)).status, 'DECLINED', end);
        await expectError(invitations.respond(pending.id, (await invitationOf(tournamentId, pending.id)).id, 'ACCEPT'),
          409, 'INVITATION_EXPIRED');
      }
    });

    it('an accept racing a close or cancel ends consistently and never deadlocks', async () => {
      for (let round = 0; round < 6; round++) {
        const { creator, friends: [friend, p1], tournamentId } = await setup(2);
        await tournaments.join(creator.id, tournamentId);
        await tournaments.join(p1.id, tournamentId);
        const inv = await invitations.invite(creator.id, tournamentId, friend.id);
        const [accept, end] = await Promise.allSettled([
          invitations.respond(friend.id, inv.invitationId, 'ACCEPT'),
          round % 2 ? tournaments.cancel(creator.id, tournamentId) : tournaments.closeRegistration(creator.id, tournamentId),
        ]);
        assert.equal(end.status, 'fulfilled', `round ${round}: ${String((end as PromiseRejectedResult).reason)}`);
        const status = (await invitationOf(tournamentId, friend.id)).status;
        const member = await prisma.tournamentParticipant.count({ where: { tournamentId, userId: friend.id } });
        if (accept.status === 'fulfilled') {
          assert.deepEqual([status, member], ['ACCEPTED', 1]);
        } else {
          assert.ok(['INVITATION_EXPIRED', 'REGISTRATION_CLOSED'].includes(codeOf(accept)!), codeOf(accept));
          assert.deepEqual([status, member], ['EXPIRED', 0]);
        }
      }
    });

    it('an invite racing a close ends consistently: never a PENDING invitation of a closed tournament', async () => {
      for (let round = 0; round < 5; round++) {
        const { creator, friends: [friend, p1], tournamentId } = await setup(2);
        await tournaments.join(creator.id, tournamentId);
        await tournaments.join(p1.id, tournamentId);
        await Promise.allSettled([
          invitations.invite(creator.id, tournamentId, friend.id),
          tournaments.closeRegistration(creator.id, tournamentId),
        ]);
        const inv = await prisma.tournamentInvitation.findFirst({ where: { tournamentId, recipientId: friend.id } });
        assert.ok(inv === null || inv.status === 'EXPIRED', `round ${round}: ${inv?.status}`);
      }
    });
  });
});
