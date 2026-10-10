import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';

function load(name, globals) {
  const source = readFileSync(new URL(`../app/photos/${name}.ts`, import.meta.url), 'utf8').replaceAll('import.meta.url', '"https://example.test/thumbnail.js"');
  const compiled = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText;
  const exports = {};
  vm.runInNewContext(compiled, { exports, Blob, URL, Error, ...globals });
  return exports;
}
function fixture(blocked = false) {
  const state = { workers: [], fallback: 0, timers: new Set() };
  class Worker {
    constructor() { if (blocked) throw new Error('blocked'); state.workers.push(this); this.sent = []; }
    postMessage(message) { this.sent.push(message); }
    terminate() { this.terminated = true; }
  }
  const client = load('thumbnail-preview', {
    Worker, OffscreenCanvas: class {},
    setTimeout: callback => { state.timers.add(callback); return callback; },
    clearTimeout: timer => state.timers.delete(timer),
    require: () => ({ encodeThumbnail: async () => { state.fallback++; return new Blob(['fallback']); } }),
  });
  return { client, state };
}
test('regular thumbnails are encoded in a shared worker and match overlapping responses', async () => {
  const { client, state } = fixture();
  const a = client.createBrowserThumbnail(new Blob(['a']), 384, .72);
  const b = client.createBrowserThumbnail(new Blob(['b']), 384, .72);
  const worker = state.workers[0]; const first = new Blob(['first']); const second = new Blob(['second']);
  assert.equal(worker.sent[0].width, 384); assert.equal(worker.sent[0].quality, .72);
  worker.onmessage({ data: { id: worker.sent[1].id, blob: second } });
  worker.onmessage({ data: { id: worker.sent[0].id, blob: first } });
  assert.equal(await a, first); assert.equal(await b, second);
  assert.equal(state.fallback, 0); assert.equal(state.timers.size, 0); assert.equal(state.workers.length, 1);
});
test('invalid images do not trigger a second decode on the UI thread', async () => {
  const { client, state } = fixture();
  const pending = client.createBrowserThumbnail(new Blob(['bad']), 384, .72);
  state.workers[0].onmessage({ data: { id: 1, error: 'invalid_image' } });
  await assert.rejects(pending, /invalid_image/); assert.equal(state.fallback, 0); assert.equal(state.timers.size, 0);
});
test('worker failure releases pending tasks and retains compatibility fallback', async () => {
  const { client, state } = fixture();
  const pending = client.createBrowserThumbnail(new Blob(['a']), 384, .72);
  state.workers[0].onerror(); await pending;
  await client.createBrowserThumbnail(new Blob(['b']), 384, .72);
  assert.equal(state.fallback, 2); assert.equal(state.timers.size, 0); assert.equal(state.workers[0].terminated, true);
  const blocked = fixture(true);
  await blocked.client.createBrowserThumbnail(new Blob(['a']), 384, .72); assert.equal(blocked.state.fallback, 1);
});
for (const failure of [false, true]) {
  test(`thumbnail encoding frees bitmap and canvas on ${failure ? 'failure' : 'success'}`, async () => {
    let closed = false; const canvases = [];
    const codec = load('thumbnail-codec', {
      createImageBitmap: async () => ({ width: 384, height: 288, close() { closed = true; } }),
      OffscreenCanvas: class {
        constructor(width, height) { this.width = width; this.height = height; canvases.push(this); }
        getContext() { return { drawImage() {} }; }
        async convertToBlob(options) { assert.equal(options.type, 'image/webp'); if (failure) throw new Error('encode_failed'); return new Blob(['thumb']); }
      },
    });
    const pending = codec.encodeThumbnail(new Blob(['source']), 384, .72);
    if (failure) await assert.rejects(pending, /encode_failed/); else await pending;
    assert.equal(closed, true); assert.equal(canvases[0].width, 1); assert.equal(canvases[0].height, 1);
  });
}
