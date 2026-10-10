import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';

// Exercise the real cache loader independently of React and filesystem permissions.
const page = readFileSync(new URL('../app/photos/page.tsx', import.meta.url), 'utf8');
const source = page.slice(page.indexOf('async function loadThumbnail('), page.indexOf('function previewStatus(')) + '\nexports.loadThumbnail = loadThumbnail;';
const compiled = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText;
function fixture() {
  const cache = new Map(); const jobs = []; const state = { reads: 0, decodes: 0 }; const exports = {};
  vm.runInNewContext(compiled, {
    exports, thumbnailDecodes: new Map(), HEIC_PREVIEW_EXTENSIONS: new Set(['heic']),
    regularPreviewQueue: {}, heicPreviewQueue: {}, accountDbName: () => 'account', thumbnailCacheKey: item => item.id,
    readThumbnailCache: item => cache.get(item.id),
    readPersistentThumbnail: async () => { state.reads++; return null; },
    createThumbnailBlob: async () => { state.decodes++; return new Blob(['thumb']); },
    writeThumbnailCache: (item, blob) => cache.set(item.id, blob),
    schedulePreview: (queue, task, cancelled, priority, background) => new Promise((resolve, reject) => {
      jobs.push({ background, run: async () => { try { resolve(cancelled() ? null : await task()); } catch (error) { reject(error); } } });
    }),
  });
  return { ...exports, cache, jobs, state };
}
test('next-page prefetch is reused immediately after navigation without another decode', async () => {
  const f = fixture(); const item = { id: 'one', extension: 'heic' };
  const prefetch = f.loadThumbnail(item, () => false, true);
  assert.equal(f.jobs[0].background, true);
  await f.jobs[0].run(); const blob = await prefetch;
  assert.equal(await f.loadThumbnail(item, () => false), blob);
  assert.equal(f.state.decodes, 1); assert.equal(f.jobs.length, 1);
});
test('overlapping consumers share one persisted-cache read and decode', async () => {
  const f = fixture(); const item = { id: 'one', extension: 'heic' };
  const prefetch = f.loadThumbnail(item, () => false, true);
  const visible = f.loadThumbnail(item, () => false);
  await Promise.all(f.jobs.map(job => job.run()));
  assert.equal(await prefetch, await visible);
  assert.equal(f.state.reads, 1); assert.equal(f.state.decodes, 1);
});
test('canceled prefetch does not read files or decode images', async () => {
  const f = fixture(); let cancelled = false;
  const prefetch = f.loadThumbnail({ id: 'one', extension: 'heic' }, () => cancelled, true);
  cancelled = true; await f.jobs[0].run();
  assert.equal(await prefetch, null); assert.equal(f.state.reads, 0); assert.equal(f.state.decodes, 0);
});
