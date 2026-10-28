const { test } = require('node:test');
const assert = require('node:assert/strict');
const { PresenceService } = require('../dist/friends/presence.service');

test('presence counts tabs, cancels reconnect grace and clears state on shutdown', t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const presence = new PresenceService();
  let transitions = 0;
  presence.events.on('presence', () => transitions++);
  assert.equal(presence.connect('alice', 'tab1'), true);
  presence.connect('alice', 'tab2');
  presence.disconnect('alice', 'tab1');
  assert.equal(presence.isOnline('alice'), true);
  presence.disconnect('alice', 'tab2');
  assert.equal(presence.isOnline('alice'), true);
  t.mock.timers.tick(4999);
  presence.connect('alice', 'tab3');
  t.mock.timers.tick(10);
  assert.equal(transitions, 1);
  presence.disconnect('alice', 'tab3');
  t.mock.timers.tick(5001);
  assert.equal(presence.isOnline('alice'), false);
  assert.equal(transitions, 2);
  presence.connect('alice', 'tab4');
  presence.disconnect('alice', 'tab4', true);
  assert.equal(presence.isOnline('alice'), false);
  presence.onModuleDestroy();
});

test('presence caps connections per user without evicting an existing tab', () => {
  const presence = new PresenceService();
  for (let i = 0; i < 10; i++) assert.equal(presence.connect('alice', `tab${i}`), true);
  assert.equal(presence.connect('alice', 'extra'), false);
  presence.disconnect('alice', 'tab0', true);
  assert.equal(presence.isOnline('alice'), true);
  assert.equal(presence.connect('alice', 'extra'), true);
  presence.onModuleDestroy();
});
