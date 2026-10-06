require('reflect-metadata');
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { NestFactory } = require('@nestjs/core');
const { AppModule } = require('../dist/app.module');
const { configureApp } = require('../dist/configure-app');
const { AuthRateLimiter } = require('../dist/auth/auth-rate-limiter');
const { loadAuthConfig } = require('../dist/auth/auth.config');
const { LogoutDto } = require('../dist/auth/dto/logout.dto');
const { AuthValidationPipe } = require('../dist/auth/validation/auth-validation.pipe');

test('config rejects unsafe origins, invalid TTL and broad proxy trust', () => {
  assert.equal(loadAuthConfig({}).sessionTtlSeconds, 604800);
  assert.equal(loadAuthConfig({ TRUSTED_PROXY_IP: '127.0.0.1' }).trustedProxyIp, '127.0.0.1');
  for (const APP_ORIGIN of ['http://localhost', 'https://localhost/', 'https://user:pass@localhost', 'garbage']) {
    assert.throws(() => loadAuthConfig({ APP_ORIGIN }));
  }
  for (const SESSION_TTL_SECONDS of ['0', 'Infinity', '604801', '60.5', '1e3']) {
    assert.throws(() => loadAuthConfig({ SESSION_TTL_SECONDS }));
  }
  for (const TRUSTED_PROXY_IP of ['true', '*', '172.16.0.0/12']) {
    assert.throws(() => loadAuthConfig({ TRUSTED_PROXY_IP }));
  }
});

test('rate limiter expires windows and fails closed at bounded capacity', () => {
  const limiter = new AuthRateLimiter();
  limiter.consume('key', 1, 1000, 0);
  assert.throws(() => limiter.consume('key', 1, 1000, 500), { status: 429 });
  limiter.consume('key', 1, 1000, 1000);
  for (let i = 0; i < 9999; i++) limiter.consume(`other:${i}`, 1, 1000, 1000);
  assert.throws(() => limiter.consume('over-capacity', 1, 1000, 1000), { status: 503 });
  limiter.consume('after-expiry', 1, 1000, 2000);
});

test('logout accepts only an empty object', async () => {
  const pipe = new AuthValidationPipe();
  const metadata = { type: 'body', metatype: LogoutDto };
  assert.ok(await pipe.transform({}, metadata) instanceof LogoutDto);
  for (const body of [null, [], 'text', { password: 'secret' }]) {
    await assert.rejects(pipe.transform(body, metadata), { status: 400 });
  }
});

test('real application fails closed without database adapter while health remains live', async (t) => {
  const app = await NestFactory.create(AppModule, { bodyParser: false, logger: false });
  configureApp(app);
  await app.listen(0, '127.0.0.1');
  t.after(() => app.close());
  const base = await app.getUrl();
  const config = app.get(require('../dist/auth/auth.config').AUTH_CONFIG);
  const response = await fetch(`${base}/api/auth/register`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', Origin: config.origin, 'X-CSRF-Protection': '1' },
    body: JSON.stringify({ email: 'user@example.com', username: 'test_user', password: 'a long chess password' }),
  });
  assert.equal(response.status, 503);
  assert.equal((await response.json()).error.code, 'AUTH_STORAGE_UNAVAILABLE');
  assert.equal(response.headers.get('set-cookie'), null);
  assert.equal((await fetch(`${base}/api/health`)).status, 200);
});
