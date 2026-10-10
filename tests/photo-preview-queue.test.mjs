import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';

const source = readFileSync(new URL('../app/photos/preview-queue.ts', import.meta.url), 'utf8');
const compiled = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText;
function fixture(fallback = false) {
  const callbacks = []; const exports = {};
  vm.runInNewContext(compiled, { exports, requestIdleCallback: fallback ? undefined : callback => callbacks.push(callback), setTimeout: callback => callbacks.push(callback) });
  const queue = { pending: [], active: 0, limit: 1 };
  return { ...exports, queue, idle: async () => { callbacks.shift()?.(); await new Promise(resolve => setImmediate(resolve)); }, callbacks };
}

for (const fallback of [false, true]) {
  test(`scrolling pauses new thumbnails and resumes after an idle turn (${fallback ? 'timer' : 'idle callback'})`, async () => {
    const f = fixture(fallback); let started = 0;
    f.setPreviewScrolling(true);
    const pending = f.schedulePreview(f.queue, async () => { started++; return 'thumb'; }, () => false);
    assert.equal(started, 0); assert.equal(f.callbacks.length, 0);
    f.setPreviewScrolling(false);
    assert.equal(started, 0);
    await f.idle();
    assert.equal(await pending, 'thumb'); assert.equal(started, 1);
  });
}

test('opening a full preview bypasses the scrolling pause and queued thumbnails', async () => {
  const f = fixture(); const order = [];
  f.setPreviewScrolling(true);
  const thumb = f.schedulePreview(f.queue, async () => { order.push('thumb'); return 'thumb'; }, () => false);
  const full = f.schedulePreview(f.queue, async () => { order.push('full'); return 'full'; }, () => false, true);
  assert.equal(await full, 'full'); assert.deepEqual(order, ['full']);
  f.setPreviewScrolling(false); await f.idle();
  assert.equal(await thumb, 'thumb'); assert.deepEqual(order, ['full', 'thumb']);
});

test('a scroll starting before the idle callback prevents a queued decode from starting', async () => {
  const f = fixture(); let started = false;
  const pending = f.schedulePreview(f.queue, async () => { started = true; return 'thumb'; }, () => false);
  f.setPreviewScrolling(true); await f.idle();
  assert.equal(started, false);
  f.setPreviewScrolling(false); await f.idle(); assert.equal(await pending, 'thumb');
});

test('canceled queued previews skip decoding and cannot block the next task', async () => {
  const f = fixture(); let canceled = false; let started = 0;
  const skipped = f.schedulePreview(f.queue, async () => { started++; }, () => canceled);
  canceled = true;
  const next = f.schedulePreview(f.queue, async () => 'next', () => false);
  assert.equal(await skipped, null); await f.idle();
  assert.equal(await next, 'next'); assert.equal(started, 0);
});

test('running work respects concurrency and discards canceled results', async () => {
  const f = fixture(); let complete; let canceled = false; let nextStarted = false;
  const first = f.schedulePreview(f.queue, () => new Promise(resolve => { complete = resolve; }), () => canceled);
  await f.idle();
  const second = f.schedulePreview(f.queue, async () => { nextStarted = true; return 'next'; }, () => false);
  assert.equal(nextStarted, false); assert.equal(f.queue.active, 1);
  canceled = true; complete('obsolete'); assert.equal(await first, null);
  await new Promise(resolve => setImmediate(resolve)); await f.idle();
  assert.equal(await second, 'next'); assert.equal(f.queue.active, 0);
});

test('failed decoding releases its slot and permits subsequent previews', async () => {
  const f = fixture();
  const first = f.schedulePreview(f.queue, async () => { throw new Error('decode_failed'); }, () => false);
  const rejection = assert.rejects(first, /decode_failed/);
  const next = f.schedulePreview(f.queue, async () => 'next', () => false);
  await f.idle(); await rejection; await f.idle();
  assert.equal(await next, 'next'); assert.equal(f.queue.active, 0);
});

test('visible thumbnails overtake next-page prefetch queued during scrolling', async () => {
  const f = fixture(); const order = [];
  f.setPreviewScrolling(true);
  const background = f.schedulePreview(f.queue, async () => { order.push('next-page'); }, () => false, false, true);
  const visible = f.schedulePreview(f.queue, async () => { order.push('visible'); }, () => false);
  f.setPreviewScrolling(false); await f.idle(); await visible;
  await f.idle(); await background;
  assert.deepEqual(order, ['visible', 'next-page']);
});

test('prefetch yields to foreground work in another codec queue and resumes on completion', async () => {
  const f = fixture(); const other = { pending: [], active: 0, limit: 1 }; let complete; let prefetched = false;
  const foreground = f.schedulePreview(other, () => new Promise(resolve => { complete = resolve; }), () => false, true);
  const background = f.schedulePreview(f.queue, async () => { prefetched = true; }, () => false, false, true);
  await f.idle(); assert.equal(prefetched, false);
  complete(); await foreground; await f.idle(); await background;
  assert.equal(prefetched, true);
});

test('stale next-page prefetch never decodes after page changes', async () => {
  const f = fixture(); let cancelled = false; let started = false;
  const background = f.schedulePreview(f.queue, async () => { started = true; }, () => cancelled, false, true);
  cancelled = true; await f.idle(); assert.equal(await background, null); assert.equal(started, false);
});
