import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';

const source = readFileSync(new URL('../app/page.tsx', import.meta.url), 'utf8');
const ast = ts.createSourceFile('page.tsx', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
let workflow;
function find(node) {
  if (ts.isFunctionDeclaration(node) && node.name?.text === 'releaseVideoFromIcloud') workflow = node.getText(ast);
  ts.forEachChild(node, find);
}
find(ast);
assert.ok(workflow);
const compiled = ts.transpileModule(workflow, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;

function fixture(answers, { previewFails = false, recycle = false } = {}) {
  const calls = []; const prompts = []; const errors = []; const releasing = []; const jobs = [];
  const current = { videos: [{ id: 'video', sourceId: 'source', size: 123 }, { id: 'survivor', sourceId: 'source', size: 456, liked: true }], sources: [{ id: 'source', videoCount: 2, totalSize: 579 }] };
  let savedVideos;
  const run = vm.runInNewContext(`${compiled}\nreleaseVideoFromIcloud`, {
    AbortController, releasingAsset: null, videoDeleteAbort: { current: null },
    setVideoDeleteJob: value => { jobs.push(typeof value === 'function' ? value(jobs.at(-1)) : value); },
    videoLibraryRef: { current }, setVideos: value => { savedVideos = value; }, setSources() {}, setSelected: update => update(new Set(['video'])), setPlayer: update => update({ id: 'survivor' }),
    storedVideo: video => video, dbSet: async () => {},
    releaseCatalog: { releasePlan: { id: 'plan' } },
    setReleasingAsset: value => releasing.push(value), setError: value => { if (value) errors.push(value); }, setNotice() {}, setReleaseCatalog() {},
    requestCloudConfirmation: async request => { prompts.push(request); return answers.shift(); },
    formatBytes: bytes => `${bytes} B`,
    fetch: async (url, options) => {
      calls.push({ url, body: JSON.parse(options.body) });
      return { ok: true, json: async () => ({ deleteJob: { id: url.endsWith('/preview') ? 'review' : 'delete', status: 'running' } }) };
    },
    waitForCloudDelete: async (id, progress) => {
      progress({ id, status: 'running', phase: id === 'review' ? 'verifying' : 'deleting' });
      const completed = { id, status: previewFails && id === 'review' ? 'failed' : 'completed', result: id === 'review' ? { releaseResult: { status: previewFails ? 'failed' : 'matched' }, localRecyclePlan: { fileCount: 1, bytes: 123 } } : { releaseResult: { status: 'deleted' }, ...(recycle ? { recycleResult: { status: 'recycled', message: 'done' } } : {}) } };
      progress(completed);
      return completed;
    },
  });
  return { run: () => run({ id: 'video', sourceId: 'source', name: 'test.mov' }, { id: 'asset', library: 'main', originalBytes: 123 }), calls, prompts, errors, releasing, jobs, savedVideos: () => savedVideos };
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
