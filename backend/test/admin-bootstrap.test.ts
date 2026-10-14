import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isExistingAdmin, validateAdminPassword } from '../prisma/admin-bootstrap';
import { requireTestDatabaseUrl } from './test-database-url';

test('passwords retain whitespace and Unicode exactly', () => {
  const password = '  a sufficiently long password  ';
  assert.equal(validateAdminPassword(password), password);
  assert.equal(validateAdminPassword('😀'.repeat(128)), '😀'.repeat(128));
});

test('password policy rejects short, oversized and malformed passwords', () => {
  for (const password of ['short', 'a'.repeat(129), '😀'.repeat(129), 'a'.repeat(15) + '\ud800']) {
    assert.throws(() => validateAdminPassword(password), /ADMIN_PASSWORD/);
  }
});

test('bootstrap creates a missing admin and accepts only the exact existing admin', () => {
  assert.equal(isExistingAdmin([], 'admin@example.test', 'admin'), false);
  assert.equal(isExistingAdmin([{ email: 'admin@example.test', username: 'admin', role: 'admin' }],
    'admin@example.test', 'admin'), true);
});

test('bootstrap rejects ordinary users, partial identity matches and split matches', () => {
  const exact = { email: 'admin@example.test', username: 'admin', role: 'admin' };
  for (const users of [
    [{ ...exact, role: 'user' }],
    [{ ...exact, email: 'other@example.test' }],
    [{ ...exact, username: 'other' }],
    [{ ...exact, email: 'other@example.test' }, { ...exact, username: 'other' }],
  ]) assert.throws(() => isExistingAdmin(users, exact.email, exact.username), /conflicts/);
});

test('database suite requires an explicit dedicated PostgreSQL test database', () => {
  for (const value of [undefined, '', 'invalid', 'postgresql://localhost/chess', 'https://localhost/chess_test']) {
    assert.throws(() => requireTestDatabaseUrl(value), /TEST_DATABASE_URL/);
  }
  const url = 'postgresql://chess_app:secret@localhost/chess_test';
  assert.equal(requireTestDatabaseUrl(url), url);
});
