import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';

function load(name, globals) {
  const source = readFileSync(new URL(`../app/photos/${name}.ts`, import.meta.url), 'utf8').replaceAll('import.meta.url', '"https://example.test/heic-preview.js"');
  const compiled = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText;
  const exports = {};
  vm.runInNewContext(compiled, { exports, Blob, URL, Error, ...globals });
  return exports;
}

function codecFixture({ fail = false, dom = false } = {}) {
  const state = { decoders: 0, freed: [], encodes: [], draws: [], canvases: [] };
  const image = (id, primary) => ({
    is_primary: () => primary, get_width: () => primary ? 4032 : 160, get_height: () => primary ? 3024 : 120,
    display(data, callback) { state.displayed = id; callback(fail ? null : data); },
    free() { state.freed.push(id); },
  });
  class Canvas {
    constructor(width, height) { this.width = width; this.height = height; state.canvases.push(this); }
    getContext() { return { putImageData() {}, drawImage: (...args) => state.draws.push(args.slice(3)) }; }
    convertToBlob(options) { state.encodes.push({ width: this.width, height: this.height, ...options }); return Promise.resolve(new Blob(['preview'], { type: options.type })); }
    toBlob(callback, type, quality) { this.convertToBlob({ type, quality }).then(callback); }
  }
  const codec = load('heic-codec', {
    require: () => ({ default: { HeifDecoder: class { constructor() { state.decoders++; } decode() { return [image('secondary', false), image('primary', true)]; } } } }),
    ImageData: class { constructor(width, height) { this.width = width; this.height = height; } },
    OffscreenCanvas: dom ? undefined : Canvas,
    document: { createElement: () => new Canvas(0, 0) },
  });
  return { codec, state };
}

for (const dom of [false, true]) {
  test(`HEIC thumbnail encodes primary image once at proportional size (${dom ? 'DOM' : 'worker'} canvas)`, async () => {
    const { codec, state } = codecFixture({ dom });
    const blob = await codec.decodeHeicBlob(new Blob(['heic']), { width: 384, type: 'image/webp', quality: .72 });
    assert.equal(blob.type, 'image/webp');
    assert.equal(state.displayed, 'primary');
    assert.deepEqual(state.encodes, [{ width: 384, height: 288, type: 'image/webp', quality: .72 }]);
    assert.deepEqual(state.freed, ['secondary', 'primary']);
    assert.ok(state.canvases.every(canvas => canvas.width === 1 && canvas.height === 1));
  });
}

test('decoder is reused and requested dimensions never upscale the original', async () => {
  const { codec, state } = codecFixture();
  await codec.decodeHeicBlob(new Blob(['heic']), { width: 8000 });
  await codec.decodeHeicBlob(new Blob(['heic']));
  assert.equal(state.decoders, 1);
  assert.equal(state.encodes.length, 2);
  assert.ok(state.encodes.every(entry => entry.width === 4032 && entry.height === 3024));
  assert.equal(state.canvases.length, 2);
  assert.equal(state.draws.length, 0);
});

test('all HEIC image handles are released on decoding failure', async () => {
  const { codec, state } = codecFixture({ fail: true });
  await assert.rejects(codec.decodeHeicBlob(new Blob(['bad'])), /heic_decode_failed/);
  assert.deepEqual(state.freed, ['secondary', 'primary']);
  assert.equal(state.encodes.length, 0);
});

function clientFixture({ unavailable = false } = {}) {
  const state = { workers: [], fallback: 0, timers: new Set() };
  class Worker {
    constructor() { if (unavailable) throw new Error('blocked'); state.workers.push(this); this.sent = []; }
    postMessage(message) { this.sent.push(message); }
    terminate() { this.terminated = true; }
  }
  const client = load('heic-preview', {
    Worker, OffscreenCanvas: class {},
    setTimeout: callback => { state.timers.add(callback); return callback; },
    clearTimeout: timer => state.timers.delete(timer),
    require: () => ({ decodeHeicBlob: async () => { state.fallback++; return new Blob(['fallback']); } }),
  });
  return { client, state };
}

test('worker responses match overlapping requests and clear their timers', async () => {
  const { client, state } = clientFixture();
  const first = client.decodeHeicPreview(new Blob(['first']));
  const second = client.decodeHeicPreview(new Blob(['second']));
  const worker = state.workers[0];
  const a = new Blob(['a']); const b = new Blob(['b']);
  worker.onmessage({ data: { id: worker.sent[1].id, blob: b } });
  worker.onmessage({ data: { id: worker.sent[0].id, blob: a } });
  assert.equal(await first, a); assert.equal(await second, b);
  assert.equal(state.workers.length, 1); assert.equal(state.fallback, 0); assert.equal(state.timers.size, 0);
});

test('codec errors propagate without decoding twice in the main thread', async () => {
  const { client, state } = clientFixture();
  const pending = client.decodeHeicPreview(new Blob(['bad']));
  const worker = state.workers[0];
  worker.onmessage({ data: { id: worker.sent[0].id, error: 'unsupported_heic' } });
  await assert.rejects(pending, /unsupported_heic/);
  assert.equal(state.fallback, 0); assert.equal(state.timers.size, 0);
});

test('worker crash releases all pending requests and switches to fallback', async () => {
  const { client, state } = clientFixture();
  const pending = [client.decodeHeicPreview(new Blob(['a'])), client.decodeHeicPreview(new Blob(['b']))];
  state.workers[0].onerror();
  await Promise.all(pending);
  await client.decodeHeicPreview(new Blob(['c']));
  assert.equal(state.fallback, 3); assert.equal(state.workers.length, 1);
  assert.equal(state.workers[0].terminated, true); assert.equal(state.timers.size, 0);
});

test('blocked worker creation uses the main-thread compatibility path', async () => {
  const { client, state } = clientFixture({ unavailable: true });
  await client.decodeHeicPreview(new Blob(['a']));
  await client.decodeHeicPreview(new Blob(['b']));
  assert.equal(state.fallback, 2);
});
