import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createPowerManager, validatePowerRequest, isLocalAdmin, shutdownArguments } from '../server/framebase-power.mjs';

async function fixture(t, options = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'framebase-power-test-'));
  const timers = [];
  let executed = 0, token = 'initial-video-pairing-token';
  const path = join(directory, 'power.json');
  const manager = createPowerManager({ path, platform: 'win32', now: () => 1000, readPairingToken: async () => token,
    execute: async () => { executed++; if (options.error) throw new Error('模拟权限不足'); },
    schedule: (callback, delay) => { const timer = { callback, delay }; timers.push(timer); return timer; },
    unschedule: timer => { timer.cancelled = true; }, ...options });
  t.after(async () => { manager.stop(); await rm(directory, { recursive: true, force: true }); });
  const admin = { admin: true };
  const register = async () => {
    await manager.action('settings', { enabled: true }, admin);
    const result = await manager.action('register', { name: '测试手机' }, { paired: true });
    return { secret: result.cookie, id: result.data.device.id, paired: true };
  };
  const authorize = async () => { const device = await register(); await manager.action('approve', { deviceId: device.id }, admin); return device; };
  return { manager, timers, admin, path, authorize, register, executed: () => executed, rotate: () => { token = 'new-pairing-token'; } };
}
const request = { confirm: true, requestId: '0123456789abcdef0123456789abcdef' };

test('remote power defaults off and video pairing never authorizes shutdown', async t => {
  const f = await fixture(t);
  assert.equal((await f.manager.status('')).enabled, false);
  await assert.rejects(f.manager.action('request', request, { paired: true }), { status: 403 });
  await assert.rejects(f.manager.action('settings', { enabled: true }, { paired: true }), { status: 403 });
  assert.equal(f.executed(), 0);
});
test('device registration needs explicit local approval and stores only secret hash', async t => {
  const f = await fixture(t); const device = await f.register();
  await assert.rejects(f.manager.action('request', request, device), { status: 403 });
  await assert.rejects(f.manager.action('approve', { deviceId: device.id }, device), { status: 403 });
  assert.equal((await f.manager.status(device.secret)).authorized, false);
  assert.equal((await readFile(f.path, 'utf8')).includes(device.secret), false);
});
test('authorized request waits exactly 10 seconds; duplicate requests do not start another timer', async t => {
  const f = await fixture(t); const device = await f.authorize();
  const result = await f.manager.action('request', request, device);
  assert.equal(result.data.task.deadline, 11000); assert.equal(f.timers[0].delay, 10000); assert.equal(f.executed(), 0);
  await f.manager.action('request', request, device); assert.equal(f.timers.length, 1);
  await assert.rejects(f.manager.action('request', { ...request, requestId: 'fedcba9876543210fedcba9876543210' }, device), { status: 409 });
  f.timers[0].callback(); const status = await f.manager.status(device.secret);
  assert.equal(f.executed(), 1); assert.equal(status.task.phase, 'accepted');
  await assert.rejects(f.manager.action('cancel', { taskId: request.requestId }, device), { status: 409 });
});
for (const who of ['phone', 'computer']) test(`${who} can cancel pending shutdown without executing it`, async t => {
  const f = await fixture(t); const device = await f.authorize();
  await f.manager.action('request', request, device);
  await f.manager.action('cancel', { taskId: request.requestId }, who === 'phone' ? device : f.admin);
  f.timers[0].callback();
  assert.equal((await f.manager.status(device.secret)).task.phase, 'cancelled'); assert.equal(f.executed(), 0);
  await f.manager.action('request', request, device); assert.equal(f.timers.length, 1);
});
for (const action of ['settings', 'remove']) test(`${action} revokes pending shutdown`, async t => {
  const f = await fixture(t); const device = await f.authorize();
  await f.manager.action('request', request, device);
  await f.manager.action(action, action === 'settings' ? { enabled: false } : { deviceId: device.id }, f.admin);
  f.timers[0].callback(); await f.manager.status(device.secret); assert.equal(f.executed(), 0);
});
test('pairing rotation invalidates device authorization and cancels countdown', async t => {
  const f = await fixture(t); const device = await f.authorize();
  await f.manager.action('request', request, device); f.rotate(); f.timers[0].callback();
  const status = await f.manager.status(device.secret); assert.equal(status.authorized, false); assert.equal(status.task.phase, 'cancelled'); assert.equal(f.executed(), 0);
});
test('execution failure is reported without claiming shutdown succeeded', async t => {
  const f = await fixture(t, { error: true }); const device = await f.authorize();
  await f.manager.action('request', request, device); f.timers[0].callback();
  const status = await f.manager.status(device.secret); assert.equal(status.task.phase, 'failed'); assert.match(status.task.error, /权限/);
});
test('service restart never restores pending shutdown', async t => {
  const f = await fixture(t); const device = await f.authorize(); await f.manager.action('request', request, device); f.manager.stop();
  const restarted = createPowerManager({ path: f.path, readPairingToken: async () => 'initial-video-pairing-token', execute: async () => assert.fail('must never execute'), platform: 'win32' });
  assert.equal((await restarted.status(device.secret)).task, null);
});
test('wrong device, missing confirmation, stale cancellation and unsupported system are rejected', async t => {
  const f = await fixture(t); const device = await f.authorize();
  await assert.rejects(f.manager.action('request', request, { paired: true, secret: 'wrong-secret' }), { status: 403 });
  await assert.rejects(f.manager.action('request', { ...request, confirm: false }, device), { status: 400 });
  await f.manager.action('request', request, device);
  await assert.rejects(f.manager.action('cancel', { taskId: 'stale' }, device), { status: 409 });
  const other = await fixture(t, { platform: 'linux' });
  await assert.rejects(other.manager.action('settings', { enabled: true }, other.admin), { status: 501 });
});
test('request validation rejects cross-origin, plain forms, non-LAN and DNS rebinding admin hosts', () => {
  const req = { method: 'POST', socket: { remoteAddress: '192.168.1.20' }, headers: { host: '192.168.1.10:3000', origin: 'http://192.168.1.10:3000', 'content-type': 'application/json', 'x-framebase-power': '1' } };
  assert.doesNotThrow(() => validatePowerRequest(req));
  assert.throws(() => validatePowerRequest({ ...req, headers: { ...req.headers, origin: 'https://evil.example' } }), { status: 403 });
  assert.throws(() => validatePowerRequest({ ...req, headers: { ...req.headers, 'x-framebase-power': undefined } }), { status: 403 });
  assert.throws(() => validatePowerRequest({ ...req, socket: { remoteAddress: '8.8.8.8' } }), { status: 403 });
  assert.equal(isLocalAdmin({ ...req, socket: { remoteAddress: '127.0.0.1' }, headers: { host: 'evil.example:3000' } }), false);
  assert.equal(isLocalAdmin({ ...req, socket: { remoteAddress: '127.0.0.1' }, headers: { host: 'localhost:3000' } }), true);
  assert.deepEqual(shutdownArguments, ['/s', '/t', '0']);
});
