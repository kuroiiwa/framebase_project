import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
import * as jsxRuntime from 'react/jsx-runtime';

function compile(file) {
  return ts.transpileModule(readFileSync(new URL(`../app/photos/${file}`, import.meta.url), 'utf8'), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX } }).outputText;
}
const helpers = {};
vm.runInNewContext(compile('drag-selection.ts'), { exports: helpers });
const component = compile('photo-selection-grid.tsx');

function fixture(initial = [], limit = 100) {
  const changes = []; const refs = []; const frames = new Map(); let frameId = 0;
  const window = { scrollX: 0, scrollY: 0, innerHeight: 800, scrollBy(_x, y) { this.scrollY += y; } };
  const captures = new Set();
  const cards = [0, 1, 2].map(index => ({ dataset: { photoId: String(index) }, getBoundingClientRect: () => ({ left: index * 110, right: index * 110 + 100, top: 100 - window.scrollY, bottom: 200 - window.scrollY }) }));
  const grid = { querySelectorAll: () => cards, setPointerCapture: id => captures.add(id), hasPointerCapture: id => captures.has(id), releasePointerCapture: id => captures.delete(id) };
  const exports = {};
  vm.runInNewContext(component, { exports, window, requestAnimationFrame: callback => { const id = ++frameId; frames.set(id, callback); return id; }, cancelAnimationFrame: id => frames.delete(id), require: name => {
    if (name === 'react') return { useEffect() {}, useRef: value => { const ref = { current: value }; refs.push(ref); return ref; }, useState: value => [value, update => { value = typeof update === 'function' ? update(value) : update; }] };
    if (name === 'react/jsx-runtime') return jsxRuntime;
    if (name === './drag-selection') return helpers;
    return { default: {} };
  } });
  const element = exports.default({ enabled: true, selectedIds: initial, limit, onChange: ids => changes.push([...ids]), className: 'grid', children: [] });
  refs[0].current = grid;
  function event(x, y, { card = 0, control = false, touch = false } = {}) {
    return { clientX: x, clientY: y, currentTarget: grid, pointerId: 1, pointerType: touch ? 'touch' : 'mouse', button: 0, isPrimary: true, preventDefault() {}, target: { closest: selector => selector === '[data-photo-id]' ? cards[card] : control ? {} : null } };
  }
  return { handlers: element.props, changes, captures, window, frames, event };
}

test('drag selects intersecting photos once and suppresses the trailing thumbnail click', () => {
  const f = fixture(['elsewhere']);
  f.handlers.onPointerDown(f.event(10, 130));
  f.handlers.onPointerMove(f.event(190, 170));
  f.handlers.onPointerUp(f.event(190, 170));
  assert.deepEqual(f.changes.at(-1), ['elsewhere', '0', '1']);
  assert.equal(f.captures.size, 0); assert.equal(f.frames.size, 0);
  let stopped = false;
  f.handlers.onClickCapture({ preventDefault() {}, stopPropagation() { stopped = true; } });
  assert.equal(stopped, true);
});
test('dragging from a selected photo removes only intersecting selections', () => {
  const f = fixture(['0', '1', '2', 'elsewhere']);
  f.handlers.onPointerDown(f.event(10, 130)); f.handlers.onPointerMove(f.event(190, 170)); f.handlers.onPointerUp(f.event(190, 170));
  assert.deepEqual(f.changes.at(-1), ['2', 'elsewhere']);
});
test('clicks, touch scrolling and action controls do not start a selection drag', () => {
  for (const options of [{}, { touch: true }, { control: true }]) {
    const f = fixture(); f.handlers.onPointerDown(f.event(10, 130, options));
    if (options.touch || options.control) f.handlers.onPointerMove(f.event(190, 170, options));
    f.handlers.onPointerUp(f.event(12, 132, options));
    assert.equal(f.changes.length, 0); assert.equal(f.frames.size, 0);
    let stopped = false; f.handlers.onClickCapture({ preventDefault() {}, stopPropagation() { stopped = true; } }); assert.equal(stopped, false);
  }
});
test('canceling a drag restores selection and releases capture', () => {
  const f = fixture(['elsewhere']); f.handlers.onPointerDown(f.event(10, 130)); f.handlers.onPointerMove(f.event(190, 170));
  f.handlers.onPointerCancel(f.event(190, 170));
  assert.deepEqual(f.changes.at(-1), ['elsewhere']); assert.equal(f.captures.size, 0); assert.equal(f.frames.size, 0);
});
test('selection limits preserve existing cross-page choices', () => {
  const f = fixture(['elsewhere'], 2); f.handlers.onPointerDown(f.event(10, 130)); f.handlers.onPointerMove(f.event(320, 180)); f.handlers.onPointerUp(f.event(320, 180));
  assert.deepEqual(f.changes.at(-1), ['elsewhere', '0']);
});
test('edge dragging scrolls and continues selection in document coordinates', () => {
  const f = fixture(); f.handlers.onPointerDown(f.event(10, 130)); f.handlers.onPointerMove(f.event(190, 790));
  const callback = f.frames.values().next().value; callback();
  assert.ok(f.window.scrollY > 0); assert.deepEqual(f.changes.at(-1), ['0', '1']);
  f.handlers.onPointerUp(f.event(190, 790)); assert.equal(f.captures.size, 0);
});
test('reverse rectangle selection uses the same intersecting cards', () => {
  const rect = helpers.selectionRect(200, 200, 0, 0);
  assert.deepEqual(JSON.parse(JSON.stringify(rect)), { left: 0, top: 0, right: 200, bottom: 200 });
  assert.deepEqual([...helpers.intersectingPhotos(rect, [{ id: 'one', rect: { left: 50, top: 50, right: 100, bottom: 100 } }, { id: 'out', rect: { left: 210, top: 0, right: 250, bottom: 50 } }])], ['one']);
});

test('batch cleanup clears selection after marks persist and retains it on persistence failure', () => {
  const page = readFileSync(new URL('../app/photos/page.tsx', import.meta.url), 'utf8');
  const source = page.slice(page.indexOf('function markSelectedForCleanup()'), page.indexOf('  const formats = useMemo')) + '\nexports.mark = markSelectedForCleanup;';
  const compiled = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText;
  for (const fail of [false, true]) {
    const exports = {}; let selection = ['one']; let photos; const writes = [];
    vm.runInNewContext(compiled, {
      exports, loading: false, selectedIds: selection,
      libraryStateRef: { current: { photos: [{ id: 'one', sourceId: 'source', cleanup: false }, { id: 'two', sourceId: 'source', cleanup: false }] } },
      persistMarks: (items, sourceId) => { if (fail) throw new Error('storage_failed'); writes.push({ items, sourceId }); },
      setPhotos: items => { photos = items; }, setSelectedIds: ids => { selection = ids; }, setNotice() {},
    });
    if (fail) { assert.throws(exports.mark, /storage_failed/); assert.deepEqual(selection, ['one']); }
    else { exports.mark(); assert.equal(selection.length, 0); assert.equal(writes.length, 1); assert.equal(photos[0].cleanup, true); assert.equal(photos[1].cleanup, false); }
  }
});
