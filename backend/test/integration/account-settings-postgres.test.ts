import 'reflect-metadata';
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { PrismaService } from '../../src/database/prisma.service';
import { PrismaAuthRepository } from '../../src/auth/prisma-auth.repository';
import { AccountConflictError } from '../../src/auth/auth.repository';
import { displayNameKey } from '../../src/auth/validation/display-name';
import { LeaderboardService } from '../../src/public-api/leaderboard/leaderboard.service';
import { FriendsService } from '../../src/friends/friends.service';
import { ProfileService } from '../../src/profile/profile.service';
import { requireTestDatabaseUrl } from '../test-database-url';

// Display name and password change against real Postgres: the unique key, the CHECK
// constraints, the password transaction, and displayName in real responses.
const prisma = new PrismaService({
  datasources: { db: { url: requireTestDatabaseUrl(process.env.TEST_DATABASE_URL) } },
});
const repository = new PrismaAuthRepository(prisma);
const userIds: string[] = [];
const gameIds: string[] = [];
const HASH = '$argon2id$test-fixture-not-a-real-password';

const suffix = () => randomUUID().replace(/-/g, '').slice(0, 10);

async function createUser(username = `dn_${suffix()}`) {
  const user = await repository.createAccount({ email: `${username}@example.test`, username, passwordHash: HASH });
  userIds.push(user.id);
  return user;
}

const setName = (id: string, name: string | null) =>
  repository.updateDisplayName(id, name, name === null ? null : displayNameKey(name));

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

describe('display name and password change against PostgreSQL', () => {
  before(async () => { await prisma.$connect(); });
  after(async () => {
    try {
      await prisma.game.deleteMany({ where: { id: { in: gameIds } } });
      // sessions cascade with their user
      await prisma.user.deleteMany({ where: { id: { in: userIds } } });
    } finally {
      await prisma.$disconnect();
    }
  });

  it('new accounts have no display name; set and clear store the name and its key', async () => {
    const me = await createUser();
    assert.equal(me.displayName, null);
    const name = `Émile ♞ ${suffix().slice(0, 4)}`;
    assert.equal((await setName(me.id, name))?.displayName, name);
    let row = await prisma.user.findUniqueOrThrow({ where: { id: me.id } });
    assert.equal(row.displayNameKey, displayNameKey(name));
    assert.equal((await setName(me.id, null))?.displayName, null);
    row = await prisma.user.findUniqueOrThrow({ where: { id: me.id } });
    assert.deepEqual([row.displayName, row.displayNameKey], [null, null]);
    assert.equal(await setName(randomUUID(), 'Nobody Here'), null);
  });

  it('the key is unique: case and fullwidth variants of a taken name conflict', async () => {
    const [a, b] = [await createUser(), await createUser()];
    const tag = suffix().slice(0, 6);
    await setName(a.id, `Grand ${tag}`);
    for (const variant of [`grand ${tag}`, `GRAND ${tag.toUpperCase()}`, `Ｇｒａｎｄ ${tag}`]) {
      await assert.rejects(setName(b.id, variant), AccountConflictError, variant);
    }
    // the same name on yourself is fine
    assert.ok(await setName(a.id, `GRAND ${tag}`));
  });

  it('a display name matching another user\'s username conflicts, and the reverse on register', async () => {
    const [a, b] = [await createUser(), await createUser()];
    await assert.rejects(setName(a.id, b.username.toUpperCase()), AccountConflictError);
    assert.ok(await setName(a.id, a.username.toUpperCase())); // own username is fine

    const shown = `taken_${suffix()}`.slice(0, 16);
    await setName(a.id, shown);
    await assert.rejects(repository.createAccount({
      email: `reg_${suffix()}@example.test`, username: shown, passwordHash: HASH,
    }), AccountConflictError);
  });

  it('CHECK constraints guard the columns even if the app is bypassed', async () => {
    const me = await createUser();
    for (const data of [
      { displayName: 'ab', displayNameKey: 'ab' }, // too short
      { displayName: ' padded ', displayNameKey: 'padded' }, // not trimmed
      { displayName: 'tab\there', displayNameKey: 'tab\there' }, // control char
      { displayName: 'Only Name', displayNameKey: null }, // key missing
      { displayName: null, displayNameKey: 'orphan key' }, // name missing
    ]) {
      await assert.rejects(prisma.user.update({ where: { id: me.id }, data }), /users_display_name/, JSON.stringify(data));
    }
  });

  it('password change swaps the hash and replaces every session of that user only', async () => {
    const [me, other] = [await createUser(), await createUser()];
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

  it('a stale expected hash writes nothing; two concurrent changes: one wins', async () => {
    const me = await createUser();
    const existing = await addSession(me.id);
    assert.equal(await repository.changePassword(me.id, '$argon2id$stale', '$argon2id$x', newSession(me.id)), null);
    assert.ok(await prisma.session.findUnique({ where: { tokenHash: existing } }));

    const [a, b] = [newSession(me.id), newSession(me.id)];
    const results = await Promise.all([
      repository.changePassword(me.id, HASH, '$argon2id$hash-a', a),
      repository.changePassword(me.id, HASH, '$argon2id$hash-b', b),
    ]);
    assert.equal(results.filter((r) => r !== null).length, 1);
    const left = await prisma.session.findMany({ where: { userId: me.id }, select: { tokenHash: true } });
    assert.equal(left.length, 1);
  });

  it('displayName shows up in leaderboard, friends search and match history', async () => {
    const [me, opponent] = [await createUser(), await createUser()];
    const shown = `Shown ${suffix().slice(0, 6)}`;
    await setName(opponent.id, shown);

    const ranking = await new LeaderboardService(prisma).getPlayerRanking(opponent.username);
    assert.equal(ranking.displayName, shown);

    const search = await new FriendsService(prisma, {} as any).search(me.id, { q: opponent.username } as any);
    assert.equal(search.items.find((u: any) => u.id === opponent.id)?.displayName, shown);

    const gameId = randomUUID();
    gameIds.push(gameId);
    await prisma.game.create({ data: {
      id: gameId, whiteId: me.id, blackId: opponent.id, result: 'WHITE_WON',
      gameStart: new Date(Date.now() - 60_000), gameEnd: new Date(),
    } });
    const history = await new ProfileService(prisma).getMyGames(me.id);
    const item = history.items.find((g: any) => g.id === gameId);
    assert.deepEqual([item?.opponent, item?.opponentDisplayName], [opponent.username, shown]);
  });
});
