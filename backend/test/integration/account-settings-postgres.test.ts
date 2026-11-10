import 'reflect-metadata';
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { NotFoundException } from '@nestjs/common';
import { PrismaService } from '../../src/database/prisma.service';
import { PrismaAuthRepository } from '../../src/auth/prisma-auth.repository';
import { AccountConflictError } from '../../src/auth/auth.repository';
import { LeaderboardService } from '../../src/public-api/leaderboard/leaderboard.service';
import { FriendsService } from '../../src/friends/friends.service';
import { requireTestDatabaseUrl } from '../test-database-url';

// Mixed-case usernames, rename and password change against real Postgres:
// the lower(username) unique index, the CHECK constraint and the password transaction.
const prisma = new PrismaService({
  datasources: { db: { url: requireTestDatabaseUrl(process.env.TEST_DATABASE_URL) } },
});
const repository = new PrismaAuthRepository(prisma);
const userIds: string[] = [];
const HASH = '$argon2id$test-fixture-not-a-real-password';

const suffix = () => randomUUID().replace(/-/g, '').slice(0, 10);

async function createUser(username = `Ac_${suffix()}`, passwordHash = HASH) {
  const user = await repository.createAccount({ email: `${username.toLowerCase()}@example.test`, username, passwordHash });
  userIds.push(user.id);
  return user;
}

async function addSession(userId: string) {
  const tokenHash = randomBytes(32).toString('hex');
  const createdAt = new Date();
  await prisma.session.create({ data: { userId, tokenHash, createdAt, expiresAt: new Date(createdAt.getTime() + 60_000) } });
  return tokenHash;
}

const newSession = (userId: string) => {
  const createdAt = new Date();
  return { userId, tokenHash: randomBytes(32).toString('hex'), createdAt, expiresAt: new Date(createdAt.getTime() + 60_000) };
};

describe('account settings against PostgreSQL', () => {
  before(async () => { await prisma.$connect(); });
  after(async () => {
    try {
      // sessions cascade with their user
      await prisma.user.deleteMany({ where: { id: { in: userIds } } });
    } finally {
      await prisma.$disconnect();
    }
  });

  it('stores the name as typed and rejects a case variant of an existing one', async () => {
    const user = await createUser(`MiXed_${suffix()}`);
    assert.match(user.username, /^MiXed_/);
    const variant = user.username.toUpperCase();
    await assert.rejects(
      repository.createAccount({ email: `other_${suffix()}@example.test`, username: variant, passwordHash: HASH }),
      AccountConflictError,
    );
  });

  it('the CHECK constraint still rejects symbols and bad lengths', async () => {
    for (const username of ['Bad-Name', 'ab', 'x'.repeat(21), 'spa ce']) {
      await assert.rejects(prisma.user.create({ data: {
        email: `chk_${suffix()}@example.test`, username, passwordHash: HASH,
      } }), /users_username_check|too long/, username); // 21 chars hits VARCHAR(20) first
    }
  });

  it('rename: own case change is fine, another user\'s name in any case is a conflict', async () => {
    const me = await createUser();
    const other = await createUser();
    const recased = await repository.updateUsername(me.id, me.username.toUpperCase());
    assert.equal(recased?.username, me.username.toUpperCase());
    for (const name of [other.username, other.username.toLowerCase(), other.username.toUpperCase()]) {
      await assert.rejects(repository.updateUsername(me.id, name), AccountConflictError);
    }
    assert.equal(await repository.updateUsername(randomUUID(), `Gone_${suffix()}`), null);
    const stored = await prisma.user.findUniqueOrThrow({ where: { id: me.id } });
    assert.equal(stored.username, me.username.toUpperCase());
  });

  it('password change swaps the hash and replaces every session of that user only', async () => {
    const me = await createUser();
    const other = await createUser();
    const mine = [await addSession(me.id), await addSession(me.id)];
    const theirs = await addSession(other.id);
    const session = newSession(me.id);

    const dropped = await repository.changePassword(me.id, HASH, '$argon2id$new-hash', session);
    assert.deepEqual(dropped?.sort(), [...mine].sort());
    const left = await prisma.session.findMany({ where: { userId: me.id }, select: { tokenHash: true } });
    assert.deepEqual(left.map((s) => s.tokenHash), [session.tokenHash]);
    assert.ok(await prisma.session.findUnique({ where: { tokenHash: theirs } }));
    assert.equal((await prisma.user.findUniqueOrThrow({ where: { id: me.id } })).passwordHash, '$argon2id$new-hash');
  });

  it('a stale expected hash writes nothing', async () => {
    const me = await createUser();
    const existing = await addSession(me.id);
    const session = newSession(me.id);
    assert.equal(await repository.changePassword(me.id, '$argon2id$stale', '$argon2id$new-hash', session), null);
    assert.equal((await prisma.user.findUniqueOrThrow({ where: { id: me.id } })).passwordHash, HASH);
    assert.ok(await prisma.session.findUnique({ where: { tokenHash: existing } }));
    assert.equal(await prisma.session.findUnique({ where: { tokenHash: session.tokenHash } }), null);
  });

  it('two concurrent changes from the same old hash: exactly one wins', async () => {
    const me = await createUser();
    await addSession(me.id);
    const [a, b] = [newSession(me.id), newSession(me.id)];
    const results = await Promise.all([
      repository.changePassword(me.id, HASH, '$argon2id$hash-a', a),
      repository.changePassword(me.id, HASH, '$argon2id$hash-b', b),
    ]);
    assert.equal(results.filter((r) => r !== null).length, 1);
    const winner = results[0] !== null ? { hash: '$argon2id$hash-a', session: a } : { hash: '$argon2id$hash-b', session: b };
    assert.equal((await prisma.user.findUniqueOrThrow({ where: { id: me.id } })).passwordHash, winner.hash);
    const left = await prisma.session.findMany({ where: { userId: me.id }, select: { tokenHash: true } });
    assert.deepEqual(left.map((s) => s.tokenHash), [winner.session.tokenHash]);
  });

  it('public leaderboard lookup ignores case and treats _ literally', async () => {
    const user = await createUser(`Lb_${suffix()}`);
    const service = new LeaderboardService(prisma);
    for (const name of [user.username, user.username.toLowerCase(), user.username.toUpperCase()]) {
      assert.equal((await service.getPlayerRanking(name)).userId, user.id);
    }
    // same length, _ replaced: must not match like a LIKE wildcard
    await assert.rejects(service.getPlayerRanking(user.username.replace('_', 'x')), NotFoundException);
  });

  it('friend search matches any case', async () => {
    const me = await createUser();
    const target = await createUser(`FrIeNd_${suffix()}`);
    const friends = new FriendsService(prisma, {} as any);
    for (const q of [target.username.toLowerCase(), target.username.toUpperCase().slice(0, 9)]) {
      const page = await friends.search(me.id, { q } as any);
      assert.ok(page.items.some((u: any) => u.id === target.id), q);
    }
  });
});
