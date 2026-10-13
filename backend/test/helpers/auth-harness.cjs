require('reflect-metadata');
const { randomUUID } = require('node:crypto');
const { NestFactory } = require('@nestjs/core');
const { Module } = require('@nestjs/common');
const { AuthModule } = require('../../dist/auth/auth.module');
const { AuthRepository, AccountConflictError } = require('../../dist/auth/auth.repository');
const { AUTH_CONFIG, loadAuthConfig } = require('../../dist/auth/auth.config');
const { configureApp } = require('../../dist/configure-app');

// A test double ONLY. It does not establish PostgreSQL transaction correctness.
class MemoryAuthRepository {
  configured = true;
  accounts = new Map();
  sessions = new Map();
  failure = null;
  deletedBatches = [];
  check(operation) {
    if (this.failure === operation || this.failure === 'all') throw new Error('driver failure with PRIVATE_DETAILS');
  }
  async createAccount(input) {
    this.check('createAccount');
    for (const account of this.accounts.values()) {
      if (input.email === account.email || input.username === account.username) throw new AccountConflictError();
    }
    const account = { id: randomUUID(), createdAt: new Date(), ...input };
    this.accounts.set(account.id, account);
    return account;
  }
  async findAccountByEmail(email) {
    this.check('findAccount');
    return [...this.accounts.values()].find((account) => account.email === email) ?? null;
  }
  async replaceSession(previous, session) {
    this.check('replaceSession');
    if (!this.accounts.has(session.userId)) throw new Error('Missing account');
    if (this.sessions.has(session.tokenHash)) throw new Error('Duplicate session');
    if (previous) this.sessions.delete(previous);
    this.sessions.set(session.tokenHash, { ...session });
  }
  async findSession(hash) {
    this.check('findSession');
    const session = this.sessions.get(hash);
    return session ? { ...session, user: this.accounts.get(session.userId) } : null;
  }
  async deleteSession(hash) {
    this.check('deleteSession');
    this.sessions.delete(hash);
  }
  async deleteExpiredSessions(now, limit) {
    this.check('cleanup');
    this.deletedBatches.push({ now, limit });
    let deleted = 0;
    for (const [hash, session] of this.sessions) {
      if (deleted === limit) break;
      if (session.expiresAt <= now) { this.sessions.delete(hash); deleted++; }
    }
    return deleted;
  }
}

async function createHarness(repository = new MemoryAuthRepository(), config = loadAuthConfig({})) {
  class TestAuthModule {}
  // Preserve the real module's controller/providers; replace only the DB seam and config.
  const providers = Reflect.getMetadata('providers', AuthModule).map((provider) => {
    if (provider.provide === AuthRepository) return { provide: AuthRepository, useValue: repository };
    if (provider.provide === AUTH_CONFIG) return { provide: AUTH_CONFIG, useValue: config };
    return provider;
  });
  Module({ controllers: Reflect.getMetadata('controllers', AuthModule), providers })(TestAuthModule);
  const app = await NestFactory.create(TestAuthModule, { bodyParser: false, logger: false });
  configureApp(app);
  await app.listen(0, '127.0.0.1');
  const base = await app.getUrl();
  const request = (path, { method = 'GET', body, cookie, headers = {}, csrf = true } = {}) => {
    const defaults = method === 'GET' ? {} : {
      'Content-Type': 'application/json',
      ...(csrf ? { Origin: config.origin, 'X-CSRF-Protection': '1' } : {}),
    };
    return fetch(`${base}/api/auth/${path}`, { method,
      headers: { ...defaults, ...(cookie ? { Cookie: cookie } : {}), ...headers },
      ...(method !== 'GET' ? { body: JSON.stringify(body === undefined ? {} : body) } : {}),
    });
  };
  return { app, repository, request, config };
}

function sessionCookie(response) { return response.headers.get('set-cookie')?.split(';')[0]; }
const account = { email: 'Alice@Example.com', username: 'Chess_Fan', password: '  chess café password 😀  ' };
module.exports = { MemoryAuthRepository, createHarness, sessionCookie, account };
