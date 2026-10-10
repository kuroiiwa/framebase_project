import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { timelineProgress } from '../app/icloud/timeline-progress.ts';

test('last library and reverse recovery never imply a completed recount', () => {
  const job = { status: 'running', phase: 'reading', message: 'PrimarySync 首轮返回 4179/4189 项，正在反向补扫 完整图库…', libraryIndex: 2, libraryCount: 2, itemCount: 4180 };
  const display = timelineProgress(job);
  assert.equal(display.indeterminate, true);
  assert.equal(display.value, undefined);
  assert.equal(display.stage, '反向补扫');
  for (const phase of ['starting', 'discovering', 'reading', 'recovering', 'aggregating', 'completed']) {
    const running = timelineProgress({ ...job, phase, message: '' });
    assert.equal(running.indeterminate, true);
    assert.notEqual(running.label, '100%');
    assert.equal(running.value, undefined);
  }
});

test('only successful saved statistics show 100%; failure remains incomplete', () => {
  const completed = timelineProgress({ status: 'completed', phase: 'completed', message: '' });
  assert.equal(completed.value, 100);
  assert.equal(completed.label, '100%');
  const failed = timelineProgress({ status: 'failed', phase: 'failed', message: '已保留上次统计' });
  assert.equal(failed.value, undefined);
  assert.equal(failed.label, '未完成');
  assert.equal(failed.indeterminate, false);
});

test('statistics panel uses the job state instead of library position as percentage', () => {
  const source = readFileSync(new URL('../app/icloud/page.tsx', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /timelineJob\.libraryIndex\s*\/\s*timelineJob\.libraryCount/);
  assert.match(source, /aria-valuenow=\{timelineDisplay\.value\}/);
  assert.match(source, /timelineJob\.status !== "idle"/);
  assert.match(source, /项目数在每轮读取结束后更新/);
});
