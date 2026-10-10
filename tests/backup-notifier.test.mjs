import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
import { createBackupNotifier } from '../app/icloud/backup-notifier.ts';

test('prepared sound and permitted desktop notification work in a background tab', async t => {
  const tones = []; const notices = [];
  let focused = false;
  class Audio {
    state = 'suspended'; currentTime = 0; destination = {};
    async resume() { this.state = 'running'; }
    async close() { this.state = 'closed'; }
    createOscillator() { const tone = { frequency: {}, connect() {}, disconnect() {}, start() {}, stop() {} }; tones.push(tone); return tone; }
    createGain() { return { gain: { setValueAtTime() {}, linearRampToValueAtTime() {}, exponentialRampToValueAtTime() {} }, connect() {}, disconnect() {} }; }
  }
  class DesktopNotification {
    static permission = 'granted';
    constructor(title, options) { this.title = title; this.options = options; notices.push(this); }
    close() { this.closed = true; }
  }
  const saved = Object.fromEntries(['window', 'document', 'Notification'].map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  Object.defineProperty(globalThis, 'window', { configurable: true, value: { AudioContext: Audio, focus: () => { focused = true; } } });
  Object.defineProperty(globalThis, 'document', { configurable: true, value: { visibilityState: 'hidden' } });
  Object.defineProperty(globalThis, 'Notification', { configurable: true, value: DesktopNotification });
  t.after(() => { for (const [key, descriptor] of Object.entries(saved)) { if (descriptor) Object.defineProperty(globalThis, key, descriptor); else delete globalThis[key]; } });
  const notifier = createBackupNotifier();
  await notifier.prepareSound();
  notifier.notify('Completed', 'Backup saved', false);
  assert.equal(tones.length, 3);
  assert.equal(notices.length, 1);
  notices[0].onclick();
  assert.equal(focused, true);
  notifier.notify('Failed', 'Retry exhausted', true);
  assert.equal(tones.length, 5);
  assert.equal(notices.length, 2);
  notifier.dispose();
  notifier.notify('Completed', 'No reminders after leaving', false);
  assert.equal(tones.length, 5);
  assert.equal(notices.length, 2);
});

test('unsupported desktop and audio APIs do not interrupt completion', async () => {
  const notifier = createBackupNotifier();
  await notifier.prepareSound();
  assert.equal(await notifier.enableDesktop(), 'unsupported');
  assert.doesNotThrow(() => notifier.notify('Completed', 'Done', false));
  notifier.dispose();
});

test('terminal backup result alerts once and overlapping polls cannot repeat it', async () => {
  const source = readFileSync(new URL('../app/icloud/page.tsx', import.meta.url), 'utf8');
  const ast = ts.createSourceFile('page.tsx', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  let poll;
  function find(node) {
    if (ts.isVariableDeclaration(node) && node.name.getText(ast) === 'poll' && node.initializer?.getText(ast).includes('backupNotifier.current?.notify')) poll = node.initializer.getText(ast);
    ts.forEachChild(node, find);
  }
  find(ast); assert.ok(poll);
  const compiled = ts.transpileModule(`const poll = ${poll};`, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
  for (const status of ['completed', 'failed', 'paused', 'cancelled', 'verifying']) {
    const alerts = []; const notices = []; let calls = 0; let configs = 0;
    const run = vm.runInNewContext(`let cancelled = false, polling = false, notified = false; ${compiled}\npoll;`, {
      fetch: async () => { calls += 1; return { ok: true, json: async () => ({ fullBackup: { status, message: 'Result' } }) }; },
      setConfig: () => { configs += 1; },
      setBackupCompletion: request => alerts.push(request),
      backupNotifier: { current: { notify: (...args) => notices.push(args) } },
    });
    await Promise.all([run(), run()]);
    assert.equal(calls, 1);
    const terminal = ['completed', 'failed'].includes(status);
    assert.equal(alerts.length, terminal ? 1 : 0);
    assert.equal(notices.length, terminal ? 1 : 0);
    if (terminal) {
      await run();
      assert.equal(calls, 1);
      assert.equal(configs, 1);
      assert.equal(notices[0][2], status === 'failed');
    }
  }
});
