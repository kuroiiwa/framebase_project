import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { webcrypto } from 'node:crypto';
import ts from 'typescript';
import { collectCloudSelection, MAX_PHOTO_SELECTION } from '../app/photos/bulk-selection.ts';
import { viewerAfterRemoval } from '../app/photos/viewer-navigation.ts';

// Execute the real client workflow with fake assets and API responses; no files are deleted.
const source = readFileSync(new URL('../app/photos/page.tsx', import.meta.url), 'utf8');
const ast = ts.createSourceFile('page.tsx', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
let workflow;
let recyclingWorkflow;
let previewWorkflow;
let localWorkflow;
function find(node) {
  if (ts.isFunctionDeclaration(node) && node.name?.text === 'deleteBatchPhotos') workflow = node.getText(ast);
  if (ts.isFunctionDeclaration(node) && node.name?.text === 'applyBatchRecycling') recyclingWorkflow = node.getText(ast);
  if (ts.isFunctionDeclaration(node) && node.name?.text === 'recycleBatchLocalPhotos') localWorkflow = node.getText(ast);
  if (ts.isFunctionDeclaration(node) && node.name?.text === 'previewCloudDeletion') previewWorkflow = node.getText(ast);
  ts.forEachChild(node, find);
}
find(ast);
assert.ok(workflow);
const compiled = ts.transpileModule(workflow, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
const compiledLocal = ts.transpileModule(localWorkflow, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
const compiledRecycling = ts.transpileModule(recyclingWorkflow, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;

function fixture(mode = 'icloud') {
  const calls = [];
  const state = { releasingAsset: null, finished: false, error: '', job: null };
  let confirm;
  let ready;
  const waiting = new Promise(resolve => { ready = resolve; });
  const context = {
    crypto: webcrypto, applyBatchRecycling: async () => {},
    MAX_PHOTO_SELECTION, collectCloudSelection, deleteMode: mode, releasingAsset: null, appleSessionBusy: false, autoReleaseAfterReview: false,
    releaseCatalog: { releasePlan: { id: 'fake-plan', assets: [{ id: 'fake-photo', library: 'test' }, { id: 'pending', library: 'test' }] } }, deletePollAbort: { current: null },
    setReleaseCatalog: update => { context.releaseCatalog = update(context.releaseCatalog); },
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
  const run = vm.runInNewContext(`${compiledLocal}\n${compiled}\ndeleteBatchPhotos`, context);
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
  assert.deepEqual(Array.from(f.context.releaseCatalog.releasePlan.assets, asset => asset.id), ['pending']);
});

test('canceling local confirmation never hashes or recycles files', async () => {
  const f = fixture('local');
  f.context.autoReleaseAfterReview = true;
  const pending = f.run(photos);
  await f.waiting;
  f.confirm(false);
  await pending;
  assert.equal(f.calls.length, 0);
  assert.equal(f.state.error, '');
  assert.equal(f.state.releasingAsset, null);
});

test('failed and partial background reviews cannot authorize deletion even with a matched summary', async () => {
  const compiledPreview = ts.transpileModule(previewWorkflow, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
  for (const status of ['failed', 'partial', 'completed']) {
    const result = { releaseResult: { status: 'matched', results: [{ id: 'one', library: 'test', status: 'matched' }] } };
    const preview = vm.runInNewContext(`${compiledPreview}\npreviewCloudDeletion`, {
      releaseCatalog: { releasePlan: { id: 'plan' } }, deletePollAbort: { current: null }, setDeleteJob() {}, setDeleteElapsed() {},
      fetch: async () => ({ ok: true, json: async () => ({ deleteJob: { id: 'review' } }) }),
      waitForCloudDelete: async () => ({ status, result, message: 'review_status' }),
    });
    if (status === 'completed') assert.equal(await preview(['test:one'], false), result);
    else await assert.rejects(preview(['test:one'], false), /review_status/);
  }
});

for (const mode of ['icloud', 'both']) {
  test(`opted-in batch release submits only after full successful review (${mode})`, async () => {
    const f = fixture(mode); f.context.autoReleaseAfterReview = true;
    let completeReview; let prompted = false;
    f.context.requestDeleteConfirmation = () => { prompted = true; return true; };
    f.context.previewCloudDeletion = () => new Promise(resolve => { completeReview = resolve; });
    f.context.applyBatchRecycling = async () => {};
    const pending = f.run(photos);
    assert.equal(f.calls.length, 0);
    completeReview({ releaseResult: { status: 'matched', results: [{ id: 'fake-photo', library: 'test', status: 'matched' }] } });
    await pending;
    assert.equal(prompted, false); assert.equal(f.calls.length, 1);
    assert.equal(f.calls[0].body.confirmation, true);
    assert.equal(f.calls[0].body.recycleLocal, mode === 'both');
    assert.deepEqual(f.calls[0].body.assetKeys, ['test:fake-photo']);
    assert.equal(f.state.finished, true); assert.equal(f.state.error, '');
  });
}

test('auto release stops on review errors, incomplete results, foreign assets and skipped photos', async () => {
  const good = { id: 'fake-photo', library: 'test', status: 'matched' };
  const variants = [
    () => { throw new Error('network_failed'); },
    () => ({ releaseResult: { status: 'partial', results: [good] } }),
    () => ({ releaseResult: { status: 'matched', results: [] } }),
    () => ({ releaseResult: { status: 'matched', results: [{ ...good, id: 'foreign' }] } }),
    () => ({ releaseResult: { status: 'matched', results: [{ ...good, status: 'failed' }] } }),
    () => ({ releaseResult: { status: 'matched', results: [good, good] } }),
  ];
  for (const review of variants) {
    const f = fixture(); f.context.autoReleaseAfterReview = true;
    f.context.previewCloudDeletion = async () => review();
    let prompted = false; f.context.requestDeleteConfirmation = () => { prompted = true; return true; };
    await f.run(photos);
    assert.equal(f.calls.length, 0); assert.equal(prompted, false);
    assert.ok(f.state.error); assert.equal(f.state.finished, false); assert.equal(f.state.releasingAsset, null);
  }
  const f = fixture(); f.context.autoReleaseAfterReview = true;
  f.context.cloudAssetFor = item => item.id === 'fake-photo' ? { id: item.id, library: 'test', localFiles: [] } : null;
  f.context.previewCloudDeletion = async () => ({ releaseResult: { status: 'matched', results: [good] } });
  await f.run([...photos, { ...photos[0], id: 'unmatched' }]);
  assert.equal(f.calls.length, 0); assert.match(f.state.error, /未匹配/);
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

function unmatchedPhoto(id = 'legacy') {
  return { id, name: id + '.png', path: '2026/09/' + id + '.png', sourceId: 'legacy-source', sourceName: 'backup', handle: { getFile: async () => ({ size: 3, arrayBuffer: async () => new Uint8Array([1, 2, 3]).buffer }) } };
}
function localFallbackFixture(cloudStatus = 'completed', cancelled = false) {
  const f = fixture('both');
  const outcomes = [];
  f.context.autoReleaseAfterReview = true;
  f.context.cloudAssetFor = item => item.id === 'fake-photo' ? { id: item.id, library: 'test', localFiles: [] } : null;
  f.context.previewCloudDeletion = async () => ({ releaseResult: { status: 'matched', results: [{ id: 'fake-photo', library: 'test', status: 'matched' }] } });
  f.context.requestDeleteConfirmation = () => { throw new Error('unexpected confirmation'); };
  f.context.applyBatchRecycling = async (items, results) => { outcomes.push(...results); };
  f.context.waitForCloudDelete = async () => ({ status: cloudStatus, message: 'cloud result', result: { releaseResult: { results: [] } } });
  f.context.fetch = async (url, options) => {
    const body = JSON.parse(options.body); f.calls.push({ url, body });
    return { ok: true, json: async () => url === '/api/photos/recycle'
      ? cancelled ? { cancelled: true } : { recycleResult: { status: 'recycled', message: 'done', results: body.groups.flat().map(file => ({ relativePath: file.relativePath, status: 'recycled' })) } }
      : { deleteJob: { id: 'cloud-job' } } };
  };
  return { ...f, outcomes };
}

test('both mode recycles unverified local photos after matched cloud photos, including live companions', async () => {
  const f = localFallbackFixture();
  const legacy = unmatchedPhoto(); legacy.liveVideo = { ...unmatchedPhoto('companion'), name: 'legacy.mov', path: '2026/09/legacy.mov' };
  await f.run([...photos, legacy]);
  assert.equal(f.state.error, ''); assert.equal(f.state.finished, true);
  assert.deepEqual(f.calls.map(call => call.url), ['/api/icloud/release/delete', '/api/photos/recycle']);
  assert.deepEqual(f.calls[0].body.assetKeys, ['test:fake-photo']);
  const files = f.calls[1].body.groups[0];
  assert.equal(files.length, 2); assert.equal(files[0].relativePath, legacy.path);
  assert.match(files[0].sha256, /^[a-f0-9]{64}$/);
  assert.equal(f.outcomes.find(result => result.item.id === 'legacy').mainDeleted, true);
  assert.equal(f.outcomes.find(result => result.item.id === 'legacy').companionDeleted, true);
});

test('both mode with no matched photos uses local recycling without cloud requests', async () => {
  const f = localFallbackFixture();
  f.context.previewCloudDeletion = () => { throw new Error('must not query cloud'); };
  await f.run([unmatchedPhoto()]);
  assert.equal(f.state.error, ''); assert.equal(f.state.finished, true);
  assert.deepEqual(f.calls.map(call => call.url), ['/api/photos/recycle']);
});

test('failed cloud operations leave unmatched local photos untouched', async () => {
  const f = localFallbackFixture('partial');
  await f.run([...photos, unmatchedPhoto()]);
  assert.deepEqual(f.calls.map(call => call.url), ['/api/icloud/release/delete']);
  assert.equal(f.outcomes.some(result => result.item.id === 'legacy'), false);
  assert.ok(f.state.error);
});

test('cancelled source selection retains unmatched photos and reports the cancellation', async () => {
  const f = localFallbackFixture('completed', true);
  await f.run([...photos, unmatchedPhoto()]);
  assert.match(f.state.error, /已取消/);
  assert.equal(f.outcomes.some(result => result.item.id === 'legacy'), false);
});

test('manual both mode cancellation leaves an entirely unmatched batch untouched', async () => {
  const f = fixture('both'); f.context.cloudAssetFor = () => null;
  const pending = f.run([unmatchedPhoto()]);
  await f.waiting; f.confirm(false); await pending;
  assert.equal(f.calls.length, 0); assert.equal(f.state.finished, false);
});
