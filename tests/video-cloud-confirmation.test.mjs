import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
import { collectCloudSelection } from '../app/photos/bulk-selection.ts';

const source = readFileSync(new URL('../app/page.tsx', import.meta.url), 'utf8');
const ast = ts.createSourceFile('page.tsx', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
let workflow;
let batchWorkflow;
function find(node) {
  if (ts.isFunctionDeclaration(node) && node.name?.text === 'releaseVideoFromIcloud') workflow = node.getText(ast);
  if (ts.isFunctionDeclaration(node) && node.name?.text === 'releaseSelectedVideosFromIcloud') batchWorkflow = node.getText(ast);
  ts.forEachChild(node, find);
}
find(ast);
assert.ok(workflow);
const compiled = ts.transpileModule(workflow + '\n' + batchWorkflow, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;

function fixture(answers, { previewFails = false, reviewResults, recycle = false, batchItems, matches = {}, deleted, recycled, partial = false } = {}) {
  const calls = []; const prompts = []; const errors = []; const releasing = []; const jobs = [];
  const current = { videos: [{ id: 'video', sourceId: 'source', size: 123 }, { id: 'survivor', sourceId: 'source', size: 456, liked: true }], sources: [{ id: 'source', videoCount: 2, totalSize: 579 }] };
  let savedVideos;
  let selected = new Set((batchItems || [{ id: 'video' }]).map(item => item.id));
  const asset = { id: 'asset', library: 'main', originalBytes: 123, localFiles: ['test.mov'] };
  const allAssets = batchItems ? collectCloudSelection(batchItems, item => matches[item.id] || null).assets : [asset];
  let catalog = { releasePlan: { id: 'plan', assets: allAssets } };
  const run = vm.runInNewContext(`${compiled}\n({ single: releaseVideoFromIcloud, batch: releaseSelectedVideosFromIcloud })`, {
    collectCloudSelection, selectedVideos: batchItems || [], cloudAssetFor: item => matches[item.id] || null,
    AbortController, releasingAsset: null, videoDeleteAbort: { current: null },
    setVideoDeleteJob: value => { jobs.push(typeof value === 'function' ? value(jobs.at(-1)) : value); },
    videoLibraryRef: { current }, setVideos: value => { savedVideos = value; }, setSources() {}, setSelected: update => { selected = update(selected); }, setPlayer: update => update({ id: 'survivor' }),
    storedVideo: video => video, dbSet: async () => {},
    releaseCatalog: { releasePlan: { id: 'plan' } },
    setReleasingAsset: value => releasing.push(value), setError: value => { if (value) errors.push(value); }, setNotice() {}, setReleaseCatalog: update => { catalog = update(catalog); },
    requestCloudConfirmation: async request => { prompts.push(request); return answers.shift(); },
    formatBytes: bytes => `${bytes} B`,
    fetch: async (url, options) => {
      calls.push({ url, body: JSON.parse(options.body) });
      return { ok: true, json: async () => ({ deleteJob: { id: url.endsWith('/preview') ? 'review' : 'delete', status: 'running' } }) };
    },
    waitForCloudDelete: async (id, progress) => {
      progress({ id, status: 'running', phase: id === 'review' ? 'verifying' : 'deleting' });
      const completed = { id, status: id === 'review' ? previewFails ? 'failed' : reviewResults ? 'partial' : 'completed' : partial ? 'partial' : 'completed', message: partial ? 'partial result' : 'done', result: id === 'review' ? { releaseResult: { status: previewFails ? 'failed' : reviewResults ? 'incomplete' : 'matched', results: previewFails ? [] : reviewResults || allAssets.map(asset => ({ id: asset.id, library: asset.library, status: 'matched' })) }, localRecyclePlan: { fileCount: 1, bytes: 123 } } : { releaseResult: { status: 'deleted', results: allAssets.filter(asset => calls.at(-1).body.assetKeys.includes(`${asset.library}:${asset.id}`)).map(asset => ({ id: asset.id, library: asset.library, status: !deleted || deleted.includes(asset.id) ? 'deleted' : 'failed' })) }, ...(recycle ? { recycleResult: { status: 'recycled', message: 'done', results: (recycled || ['test.mov']).map(relativePath => ({ relativePath, status: 'recycled' })) } } : {}) } };
      progress(completed);
      return completed;
    },
  });
  return { run: () => run.single({ id: 'video', sourceId: 'source', name: 'test.mov', path: 'test.mov' }, asset), runBatch: () => run.batch(), calls, prompts, errors, releasing, jobs, savedVideos: () => savedVideos, selected: () => [...selected], catalog: () => catalog };
}

test('canceling scope selection makes no preview or deletion request', async () => {
  const f = fixture([null]); await f.run();
  assert.equal(f.calls.length, 0); assert.equal(f.prompts.length, 1);
  assert.equal(f.releasing.at(-1), null);
});

test('canceling final confirmation only previews and never submits deletion', async () => {
  const f = fixture(['both', null]); await f.run();
  assert.equal(f.calls.length, 1); assert.ok(f.calls[0].url.endsWith('/preview'));
  assert.equal(f.errors.length, 0);
});

for (const scope of ['cloud', 'both']) {
  test(`${scope} selection preserves its scope through preview and confirmed deletion`, async () => {
    const f = fixture([scope, 'confirm']); await f.run();
    assert.equal(f.calls.length, 2);
    assert.ok(f.calls.every(call => call.body.recycleLocal === (scope === 'both')));
    assert.equal(f.prompts[1].expectedText, undefined);
    assert.equal(f.calls[1].body.confirmation, true);
    assert.ok(f.calls.every(call => call.body.background === true));
    assert.ok(f.jobs.some(job => job?.phase === 'verifying'));
    assert.ok(f.jobs.some(job => job?.phase === 'deleting'));
    assert.equal(f.jobs.at(-1).status, 'completed');
    assert.equal(f.errors.length, 0); assert.equal(f.releasing.at(-1), null);
  });
}

test('only the explicit confirmation button submits deletion', async () => {
  const f = fixture(['cloud', 'wrong']); await f.run();
  assert.equal(f.calls.length, 1); assert.equal(f.errors.length, 0);
});

test('failed background review retains a failure window without requesting deletion', async () => {
  const f = fixture(['both'], { previewFails: true }); await f.run();
  assert.equal(f.calls.length, 1); assert.equal(f.prompts.length, 1);
  assert.equal(f.jobs.at(-1).status, 'failed'); assert.equal(f.errors.length, 1);
});

test('successful recycling updates the latest library and preserves other video marks', async () => {
  const f = fixture(['both', 'confirm'], { recycle: true }); await f.run();
  assert.deepEqual(f.savedVideos().map(video => video.id), ['survivor']);
  assert.equal(f.savedVideos()[0].liked, true);
  assert.equal(f.errors.length, 0);
});

const batchItems = [
  { id: 'video', sourceId: 'source', sourceName: 'backup', name: 'one.mov', path: '2016/one.mov' },
  { id: 'second', sourceId: 'source', sourceName: 'backup', name: 'two.mov', path: '2018/two.mov' },
  { id: 'unmatched', sourceId: 'source', sourceName: 'backup', name: 'other.mov', path: 'other.mov' },
];
const matches = {
  video: { id: 'one', library: 'main', originalBytes: 123, localFiles: ['2016/one.mov'] },
  second: { id: 'two', library: 'main', originalBytes: 456, localFiles: ['2018/two.mov'] },
};

test('batch release previews and deletes only matched assets and explains skipped videos', async () => {
  const f = fixture(['cloud', 'confirm'], { batchItems, matches }); await f.runBatch();
  assert.equal(f.calls.length, 2);
  for (const call of f.calls) assert.deepEqual(call.body.assetKeys, ['main:one', 'main:two']);
  assert.match(f.prompts[0].message, /跳过 1 个/);
  assert.match(f.prompts[1].message, /other\.mov/);
  assert.deepEqual(f.selected(), ['unmatched']);
  assert.equal(f.savedVideos(), undefined);
});

test('partially successful cloud release removes only successful assets from the plan and selection', async () => {
  const f = fixture(['cloud', 'confirm'], { batchItems, matches, deleted: ['one'], partial: true }); await f.runBatch();
  assert.deepEqual(f.catalog().releasePlan.assets.map(asset => asset.id), ['two']);
  assert.deepEqual(f.selected(), ['second', 'unmatched']);
  assert.equal(f.jobs.at(-1).status, 'partial');
  assert.equal(f.errors.length, 1);
});

test('partial local recycling removes only confirmed recycled videos and preserves failed selection', async () => {
  const f = fixture(['both', 'confirm'], { batchItems, matches, recycle: true, recycled: ['2016/one.mov'], partial: true }); await f.runBatch();
  assert.deepEqual(f.savedVideos().map(video => video.id), ['survivor']);
  assert.deepEqual(f.selected(), ['second', 'unmatched']);
  assert.match(f.jobs.at(-1).message, /本地已回收 1/);
});

test('an unconfirmed cloud failure never removes a local video even if a recycle result claims success', async () => {
  const f = fixture(['both', 'confirm'], { batchItems, matches, recycle: true, recycled: ['2016/one.mov'], deleted: ['two'], partial: true }); await f.runBatch();
  assert.equal(f.savedVideos(), undefined);
  assert.deepEqual(f.selected(), ['video', 'second', 'unmatched']);
});

test('batch release with no matches never starts cloud requests', async () => {
  const f = fixture([], { batchItems }); await f.runBatch();
  assert.equal(f.calls.length, 0); assert.equal(f.prompts.length, 0); assert.equal(f.errors.length, 1);
});

test('batch release over 100 selected videos is rejected without silently truncating the scope', async () => {
  const f = fixture([], { batchItems: Array.from({ length: 101 }, (_, id) => ({ id: String(id) })) }); await f.runBatch();
  assert.equal(f.calls.length, 0); assert.equal(f.prompts.length, 0);
  assert.match(f.errors[0], /100/);
});

test('duplicate selections of the same cloud asset commit only one asset key', async () => {
  const duplicates = batchItems.slice(0, 2);
  const f = fixture(['cloud', 'confirm'], { batchItems: duplicates, matches: { video: matches.video, second: matches.video } }); await f.runBatch();
  assert.deepEqual(f.calls[1].body.assetKeys, ['main:one']);
  assert.deepEqual(f.selected(), []);
});

for (const scope of ['cloud', 'both']) {
  test(`partial preview offers explicit confirmation and commits only verified assets (${scope})`, async () => {
    const f = fixture([scope, 'confirm'], { batchItems, matches, recycle: scope === 'both', recycled: ['2016/one.mov'], reviewResults: [
      { id: 'one', library: 'main', status: 'matched' },
      { id: 'two', library: 'main', status: 'mismatch' },
      { id: 'foreign', library: 'main', status: 'matched' },
      { id: 'one', library: 'main', status: 'matched' },
    ] });
    await f.runBatch();
    assert.deepEqual(f.calls[0].body.assetKeys, ['main:one', 'main:two']);
    assert.deepEqual(f.calls[1].body.assetKeys, ['main:one']);
    assert.match(f.prompts[1].choices[0].label, /1/);
    assert.match(f.prompts[1].message, /1\/2/);
    assert.match(f.prompts[1].message, /123 B/);
    if (scope === 'both') assert.doesNotMatch(f.prompts[1].message, /同时将 1 个本地原文件/);
    assert.deepEqual(f.selected(), ['second', 'unmatched']);
    assert.deepEqual(f.catalog().releasePlan.assets.map(asset => asset.id), ['two']);
    assert.equal(f.errors.length, 0);
  });
}

test('canceling partial verification preserves every selected item and sends no deletion', async () => {
  const f = fixture(['cloud', null], { batchItems, matches, reviewResults: [{ id: 'one', library: 'main', status: 'matched' }] });
  await f.runBatch();
  assert.equal(f.calls.length, 1);
  assert.deepEqual(f.selected(), ['video', 'second', 'unmatched']);
});

test('no verified requested assets refuses deletion even with a foreign matched result', async () => {
  const f = fixture(['cloud'], { batchItems, matches, reviewResults: [{ id: 'foreign', library: 'main', status: 'matched' }, { id: 'one', library: 'other', status: 'matched' }] });
  await f.runBatch();
  assert.equal(f.calls.length, 1);
  assert.equal(f.prompts.length, 1);
  assert.equal(f.errors.length, 1);
});
