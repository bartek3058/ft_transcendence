require('reflect-metadata');
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { AuthValidationPipe } = require('../dist/auth/validation/auth-validation.pipe');
const { RegisterDto } = require('../dist/auth/dto/register.dto');
const { LoginDto } = require('../dist/auth/dto/login.dto');
const pipe = new AuthValidationPipe();
const valid = { email: 'Alice+Chess@Example.com', username: 'Chess_Fan', password: '  long chess passphrase!  ' };
const validate = (body, type = RegisterDto) => pipe.transform(body, { type: 'body', metatype: type });

test('normalizes identity fields while preserving the exact password', async () => {
  const dto = await validate({ ...valid, email: ` ${valid.email} `, username: ' Chess_Fan ' });
  assert.ok(dto instanceof RegisterDto);
  assert.equal(dto.email, 'alice+chess@example.com');
  assert.equal(dto.username, 'chess_fan');
  assert.equal(dto.password, valid.password);
  const login = await validate({ email: ` ${valid.email} `, password: valid.password }, LoginDto);
  assert.equal(login.email, dto.email);
});

for (const body of [null, [], 123, true, 'text', undefined]) {
  test(`rejects non-object body ${JSON.stringify(body)}`, async () => {
    await assert.rejects(validate(body), { status: 400 });
  });
}

for (const field of ['email', 'username', 'password']) {
  test(`rejects missing and non-string ${field} without coercion`, async () => {
    for (const value of [undefined, null, 123, [], {}, true]) {
      await assert.rejects(validate({ ...valid, [field]: value }), { status: 400 });
    }
  });
}

test('rejects extra fields without reflecting attacker-controlled keys or values', async () => {
  const secret = 'sensitive-field-name';
  await assert.rejects(validate({ ...valid, [secret]: 'sensitive-value', role: 'admin' }), (error) => {
    const response = JSON.stringify(error.getResponse());
    assert.equal(error.status, 400);
    for (const value of [secret, 'sensitive-value', valid.password]) assert.ok(!response.includes(value));
    assert.ok(response.includes('UNEXPECTED_FIELD'));
    return true;
  });
});

test('email policy rejects non-ASCII, display names, whitespace and overlong addresses', async () => {
  for (const email of ['not-an-email', 'alice @example.com', 'Alice <alice@example.com>',
    'alïce@example.com', 'alice@éxample.com', 'a'.repeat(65) + '@example.com',
    'a'.repeat(64) + '@' + 'b'.repeat(63) + '.' + 'c'.repeat(63) + '.' + 'd'.repeat(63) + '.com']) {
    await assert.rejects(validate({ ...valid, email }), { status: 400 });
  }
});

test('username bounds and allowlist; Unicode cannot normalize into ASCII', async () => {
  for (const username of ['ab', 'a'.repeat(21), '<b>alice</b>', 'a b', 'Kelvin', 'chess-fan']) {
    await assert.rejects(validate({ ...valid, username }), { status: 400 });
  }
  for (const username of ['abc', 'a'.repeat(20)]) await validate({ ...valid, username });
});

test('password limits count Unicode code points and reject malformed surrogates', async () => {
  for (const password of ['a'.repeat(15), '😀'.repeat(15), '😀'.repeat(128), 'a'.repeat(128), "I'm playing chess!", ' '.repeat(15)]) {
    assert.equal((await validate({ ...valid, password })).password, password);
  }
  for (const password of ['', 'a'.repeat(14), '😀'.repeat(14), 'a'.repeat(129), '😀'.repeat(129),
    'a'.repeat(15) + '\ud800', '\udc00' + 'a'.repeat(15)]) {
    await assert.rejects(validate({ ...valid, password }), { status: 400 });
  }
});

test('login does not impose the registration minimum on existing passwords', async () => {
  await validate({ email: valid.email, password: 'short' }, LoginDto);
  await assert.rejects(validate({ ...valid, password: 'short' }), { status: 400 });
});

test('prototype-related fields are rejected before transformation can drop them', async () => {
  for (const key of ['__proto__', 'constructor', 'prototype']) {
    const body = JSON.parse(JSON.stringify(valid).slice(0, -1) + `,"${key}":{"role":"admin"}}`);
    await assert.rejects(validate(body), { status: 400 });
  }
});
