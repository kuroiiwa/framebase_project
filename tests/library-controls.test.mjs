import assert from 'node:assert/strict';
import test from 'node:test';
import { ScanControl, selectRange } from '../app/library-controls.ts';

test('shift selection spans pages in displayed order and preserves earlier selections', () => {
  const order = Array.from({ length: 100 }, (_, index) => String(index));
  const original = new Set(['99']);
  const selected = selectRange(original, order, '18', '52', true);
  assert.equal(selected.size, 36);
  assert.ok(selected.has('18') && selected.has('52') && selected.has('99'));
  assert.deepEqual(original, new Set(['99']));
});
test('reverse shift selection includes both endpoints', () => {
  assert.deepEqual(selectRange(new Set(), ['c', 'a', 'b'], 'b', 'c', true), new Set(['c', 'a', 'b']));
});
test('filtered out anchor falls back to toggling a single item', () => {
  assert.deepEqual(selectRange(new Set(['b']), ['a', 'b'], 'hidden', 'b', true), new Set());
});
test('plain selection toggles without clearing other pages', () => {
  assert.deepEqual(selectRange(new Set(['offpage']), ['a'], null, 'a', false), new Set(['offpage', 'a']));
});
test('paused task cannot proceed until resumed', async () => {
  const control = new ScanControl(); control.paused = true;
  let passed = false;
  const pending = control.checkpoint().then(() => { passed = true; });
  await new Promise(resolve => setTimeout(resolve, 120));
  assert.equal(passed, false);
  control.paused = false;
  await pending;
  assert.equal(passed, true);
});
test('cancellation releases paused workers and blocks later work', async () => {
  const control = new ScanControl(); control.paused = true;
  const pending = control.checkpoint();
  control.cancelled = true;
  await assert.rejects(pending, { name: 'AbortError' });
  await assert.rejects(control.checkpoint(), { name: 'AbortError' });
});
