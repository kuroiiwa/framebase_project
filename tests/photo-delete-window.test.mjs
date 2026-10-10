import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
import { collectCloudSelection, MAX_PHOTO_SELECTION } from '../app/photos/bulk-selection.ts';
import { viewerAfterRemoval } from '../app/photos/viewer-navigation.ts';

// Execute the real client workflow with fake assets and API responses; no files are deleted.
const source = readFileSync(new URL('../app/photos/page.tsx', import.meta.url), 'utf8');
const ast = ts.createSourceFile('page.tsx', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
let workflow;
let recyclingWorkflow;
function find(node) {
  if (ts.isFunctionDeclaration(node) && node.name?.text === 'deleteBatchPhotos') workflow = node.getText(ast);
  if (ts.isFunctionDeclaration(node) && node.name?.text === 'applyBatchRecycling') recyclingWorkflow = node.getText(ast);
  ts.forEachChild(node, find);
}
find(ast);
assert.ok(workflow);
const compiled = ts.transpileModule(workflow, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
const compiledRecycling = ts.transpileModule(recyclingWorkflow, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;

function fixture(mode = 'icloud') {
  const calls = [];
  const state = { releasingAsset: null, finished: false, error: '', job: null };
  let confirm;
  let ready;
  const waiting = new Promise(resolve => { ready = resolve; });
  const context = {
    MAX_PHOTO_SELECTION, collectCloudSelection, deleteMode: mode, releasingAsset: null, appleSessionBusy: false,
    releaseCatalog: { releasePlan: { id: 'fake-plan' } }, deletePollAbort: { current: null },
    cloudAssetFor: item => ({ id: item.id, library: 'test', localFiles: [] }),
    setReleasingAsset: value => { state.releasingAsset = value; context.releasingAsset = value; },
    setError: value => { state.error = value; }, setNotice() {}, setDeleteElapsed() {}, setBatchLocalProgress() {},
    setDeleteJob: value => { state.job = typeof value === 'function' ? value(state.job) : value; },
    setDeleteFinished: value => { state.finished = value; }, setSelectedIds: update => update(['fake-photo']),
    previewCloudDeletion: async () => ({ localRecyclePlan: { fileCount: 0 } }),
    requestDeleteConfirmation: () => { ready(); return new Promise(resolve => { confirm = resolve; }); },
    fetch: async (url, options) => { calls.push({ url, body: JSON.parse(options.body) }); return { ok: true, json: async () => ({ deleteJob: { id: 'fake-job', status: 'running' } }) }; },
    waitForCloudDelete: async () => ({ status: 'completed', elapsedSeconds: 3, message: 'done', result: { releaseResult: { status: 'deleted', results: [{ id: 'fake-photo', library: 'test', status: 'deleted' }] } } }),
    refreshReleaseCatalog() {},
  };
  const run = vm.runInNewContext(`${compiled}\ndeleteBatchPhotos`, context);
  return { run, waiting, calls, state, context, confirm: value => confirm(value) };
}
const photos = [{ id: 'fake-photo', name: 'test.jpg', sourceId: 'fake-source', sourceName: 'test' }];

test('cloud review waits for explicit confirmation even when the window is minimized', async () => {
  const f = fixture();
  const pending = f.run(photos);
  await f.waiting;
  assert.equal(f.calls.length, 0);
  assert.equal(f.state.releasingAsset, 'batch');
  f.context.deleteMinimized = true;
  await Promise.resolve();
  assert.equal(f.calls.length, 0);
  f.confirm(false);
  await pending;
  assert.equal(f.calls.length, 0);
  assert.equal(f.state.releasingAsset, null);
  assert.equal(f.state.finished, false);
});

test('accepted confirmation submits one background task and retains the result window', async () => {
  const f = fixture();
  const pending = f.run(photos);
  await f.waiting;
  f.context.deleteMinimized = true;
  f.context.deleteMinimized = false;
  f.confirm(true);
  await pending;
  assert.equal(f.calls.length, 1);
  assert.equal(f.calls[0].url, '/api/icloud/release/delete');
  assert.deepEqual(f.calls[0].body, { planId: 'fake-plan', assetKeys: ['test:fake-photo'], recycleLocal: false, confirmation: true, background: true });
  assert.equal(f.state.finished, true);
  assert.equal(f.state.releasingAsset, null);
  assert.equal(f.state.error, '');
});

test('canceling local confirmation never hashes or recycles files', async () => {
  const f = fixture('local');
  const pending = f.run(photos);
  await f.waiting;
  f.confirm(false);
  await pending;
  assert.equal(f.calls.length, 0);
  assert.equal(f.state.error, '');
  assert.equal(f.state.releasingAsset, null);
});

test('deleted open photo advances past other deleted photos in the latest browsing order', () => {
  assert.equal(viewerAfterRemoval('b', ['a', 'b', 'c', 'd'], new Set(['a', 'd'])), 'd');
  assert.equal(viewerAfterRemoval('b', ['d', 'b', 'c', 'a'], new Set(['a', 'd'])), 'a');
});

test('viewer falls back to the previous survivor or closes when no filtered photos remain', () => {
  assert.equal(viewerAfterRemoval('d', ['a', 'b', 'c', 'd'], new Set(['a', 'b'])), 'b');
  assert.equal(viewerAfterRemoval('b', ['a', 'b'], new Set(['off-filter'])), null);
  assert.equal(viewerAfterRemoval('hidden', ['a', 'c'], new Set(['c'])), 'c');
});

test('cloud-only deletion, a failed deletion and an already closed viewer never change the preview', () => {
  assert.equal(viewerAfterRemoval('b', ['a', 'b', 'c'], new Set(['b', 'c'])), 'b');
  assert.equal(viewerAfterRemoval(null, ['a', 'b'], new Set(['a'])), null);
});

test('recycling applies to the latest viewer and preserves changes made while the task ran', async () => {
  const currentPhotos = ['a', 'b', 'c', 'd'].map(id => ({ id, sourceId: 'source', size: 1, liked: id === 'a' }));
  const persisted = [];
  const state = { photos: currentPhotos, viewerId: 'c', selected: ['a', 'b', 'd'] };
  const context = {
    photos: currentPhotos.map(photo => ({ ...photo, liked: false })), viewerId: 'b', // old task closure
    libraryStateRef: { current: { photos: currentPhotos, sources: [{ id: 'source' }], filtered: currentPhotos } },
    viewerAfterRemoval, SOURCES_KEY: 'sources',
    setPhotos: next => { state.photos = next; }, setSources() {},
    setSelectedIds: update => { state.selected = update(state.selected); },
    setViewerId: update => { state.viewerId = update(state.viewerId); },
    dbSet: async (key, value) => { persisted.push({ key, value }); },
  };
  const apply = vm.runInNewContext(`${compiledRecycling}\napplyBatchRecycling`, context);
  const item = currentPhotos[1];
  await apply([item], [{ item, mainDeleted: true, companionDeleted: false }]);
  assert.equal(state.viewerId, 'c');
  assert.equal(state.photos.find(photo => photo.id === 'a').liked, true);
  assert.deepEqual(Array.from(state.selected), ['a', 'd']);
  assert.equal(persisted.find(entry => entry.key === 'photo-library:source').value.find(photo => photo.id === 'a').liked, true);
});

test('a viewer opened on a task photo after submission advances only after successful recycling', async () => {
  const currentPhotos = ['a', 'b', 'c'].map(id => ({ id, sourceId: 'source', size: 1 }));
  let currentViewer = 'b';
  const context = {
    viewerId: null,
    libraryStateRef: { current: { photos: currentPhotos, sources: [], filtered: currentPhotos } },
    viewerAfterRemoval, SOURCES_KEY: 'sources', setPhotos() {}, setSources() {},
    setSelectedIds: update => update([]), setViewerId: update => { currentViewer = update(currentViewer); }, dbSet: async () => {},
  };
  const apply = vm.runInNewContext(`${compiledRecycling}\napplyBatchRecycling`, context);
  const item = currentPhotos[1];
  await apply([item], [{ item, mainDeleted: false, companionDeleted: false }]);
  assert.equal(currentViewer, 'b');
  await apply([item], [{ item, mainDeleted: true, companionDeleted: false }]);
  assert.equal(currentViewer, 'c');
});
