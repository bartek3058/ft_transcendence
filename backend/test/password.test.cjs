require('reflect-metadata');
const { test, before } = require('node:test');
const assert = require('node:assert/strict');
const { PasswordService } = require('../dist/auth/password.service');
const service = new PasswordService();
before(() => service.onModuleInit());

test('Argon2id generates salted hashes and verifies the exact password', async () => {
  const password = '  Chess café 😀 password!  ';
  const first = await service.hash(password);
  const second = await service.hash(password);
  assert.match(first, /^\$argon2id\$v=19\$m=65536,t=3,p=1\$/);
  assert.notEqual(first, second);
  assert.ok(!first.includes(password));
  assert.equal(await service.verify(password, first), true);
  for (const changed of [password.trim(), password.toLowerCase(), password.normalize('NFD'), 'wrong password']) {
    assert.equal(await service.verify(changed, first), false);
  }
});

test('missing account takes the dummy-hash path and never authenticates', async () => {
  assert.equal(await service.verify('valid length password', null), false);
});

test('hash refuses invalid input; verify handles existing short passwords', async () => {
  await assert.rejects(service.hash('short'), { status: 400 });
  await assert.rejects(service.hash('a'.repeat(15) + '\ud800'), { status: 400 });
  assert.equal(await service.verify('😀'.repeat(129), null), false);
  assert.equal(await service.verify('', null), false);
  const argon2 = require('argon2');
  const legacy = await argon2.hash('short');
  assert.equal(await service.verify('short', legacy), true);
});

test('hash capacity is bounded and is released after success or failure', async () => {
  const jobs = [service.hash('first long password'), service.hash('second long password')];
  await assert.rejects(service.hash('third long password'), { status: 503 });
  await Promise.all(jobs);
  await assert.rejects(service.verify('long chess password', 'broken-database-hash'));
  const hash = await service.hash('another long password');
  assert.equal(await service.verify('another long password', hash), true);
});
