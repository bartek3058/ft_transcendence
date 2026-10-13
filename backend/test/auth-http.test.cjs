require('reflect-metadata');
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { NestFactory } = require('@nestjs/core');
const { Module, Controller, Post, Body } = require('@nestjs/common');
const { configureApp } = require('../dist/configure-app');
const { RegisterDto } = require('../dist/auth/dto/register.dto');
const { HealthModule } = require('../dist/health/health.module');
const { AUTH_CONFIG, loadAuthConfig } = require('../dist/auth/auth.config');

// Test-only route: exercises the real Express parser and global validation pipe.
// It is never registered in the production application.
class InputProbe {
  register(dto) { return { email: dto.email, username: dto.username }; }
}
Controller('auth')(InputProbe);
Post('register')(InputProbe.prototype, 'register', Object.getOwnPropertyDescriptor(InputProbe.prototype, 'register'));
Body()(InputProbe.prototype, 'register', 0);
Reflect.defineMetadata('design:paramtypes', [RegisterDto], InputProbe.prototype, 'register');
class TestModule {}
Module({ imports: [HealthModule], controllers: [InputProbe],
  providers: [{ provide: AUTH_CONFIG, useValue: loadAuthConfig({}) }] })(TestModule);
let app;
let base;
before(async () => {
  app = await NestFactory.create(TestModule, { bodyParser: false, logger: false });
  configureApp(app);
  await app.listen(0, '127.0.0.1');
  base = await app.getUrl();
});
after(async () => { if (app) await app.close(); });
const valid = { email: ' Alice@Example.com ', username: 'Chess_Fan', password: 'a long chess password' };
const post = (body, contentType = 'application/json') => fetch(`${base}/api/auth/register`, {
  method: 'POST', headers: { 'Content-Type': contentType }, body,
});

test('real request passes through DTO normalization; health remains available', async () => {
  const response = await post(JSON.stringify(valid));
  assert.equal(response.status, 201);
  assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.deepEqual(await response.json(), { email: 'alice@example.com', username: 'chess_fan' });
  const health = await fetch(`${base}/api/health`);
  assert.equal(health.status, 200);
  assert.equal((await health.json()).status, 'ok');
});

test('malformed and oversized JSON produce safe controlled errors', async () => {
  for (const [body, status, code] of [
    ['{"password":"DO_NOT_REFLECT",', 400, 'INVALID_JSON'],
    [JSON.stringify({ ...valid, password: 'x'.repeat(17000) }), 413, 'PAYLOAD_TOO_LARGE'],
  ]) {
    const response = await post(body);
    assert.equal(response.status, status);
    const result = await response.json();
    assert.equal(result.error.code, code);
    assert.ok(!JSON.stringify(result).includes('DO_NOT_REFLECT'));
  }
});

test('invalid bodies, unexpected fields, and unsupported media are rejected', async () => {
  for (const body of ['[]', 'null', '123', JSON.stringify({ ...valid, role: 'admin' })]) {
    assert.equal((await post(body)).status, 400);
  }
  const response = await post('email=alice@example.com', 'application/x-www-form-urlencoded');
  assert.equal(response.status, 415);
  assert.equal((await response.json()).error.code, 'UNSUPPORTED_MEDIA_TYPE');
});

test('same-origin configuration does not grant permissive CORS', async () => {
  const response = await fetch(`${base}/api/health`, { headers: { Origin: 'https://untrusted.example' } });
  assert.equal(response.headers.get('access-control-allow-origin'), null);
});
