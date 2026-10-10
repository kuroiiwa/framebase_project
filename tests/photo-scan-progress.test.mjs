import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
import { findLivePhotoVideo } from '../shared/live-photo.mjs';

const page = readFileSync(new URL('../app/photos/page.tsx', import.meta.url), 'utf8');
function load(source, globals) {
  const exports = {};
  const compiled = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText;
  vm.runInNewContext(compiled, { exports, Error, ...globals }); return exports;
}
test('small and empty scans report directory discovery and final counts', async () => {
  const source = page.slice(page.indexOf('async function scanDirectory('), page.indexOf('async function createPreviewBlob(')) + '\nexports.scan = scanDirectory;';
  let time = 0;
  const { scan } = load(source, { Date: { now: () => time }, readMarks: () => ({}), PHOTO_EXTENSIONS: new Set(['heic']), LIVE_PHOTO_IMAGE_EXTENSIONS: new Set(['heic']), findLivePhotoVideo });
  const image = { kind: 'file', name: 'IMG_4676.HEIC', getFile: async () => { time += 200; return { size: 12, lastModified: 1000 }; } };
  const video = { kind: 'file', name: 'IMG_4676_HEVC.MOV' };
  const handle = { async *values() { time += 200; yield image; yield video; yield { kind: 'directory', name: 'empty', async *values() {} }; } };
  const reports = [];
  const found = await scan({ id: 'source', name: 'photos', handle }, counts => reports.push(counts));
  assert.equal(found.length, 1); assert.equal(found[0].liveVideo.name, video.name);
  assert.ok(reports.some(counts => counts.photos === 0));
  const last = reports.at(-1); assert.equal(last.photos, 1); assert.equal(last.files, 2); assert.equal(last.folders, 2);
  const emptyReports = [];
  await scan({ id: 'empty', name: 'empty', handle: { async *values() {} } }, counts => emptyReports.push(counts));
  assert.equal(emptyReports.at(-1).photos, 0); assert.equal(emptyReports.at(-1).folders, 1);
});

function fixture({ denied = false, saveFailure = false } = {}) {
  const state = { scan: null, phases: [], scans: 0, loading: false, libraryUpdated: false };
  let grant; let completeScan; let save;
  const permission = new Promise(resolve => { grant = resolve; });
  const scanning = new Promise(resolve => { completeScan = resolve; });
  const saving = new Promise(resolve => { save = resolve; });
  const source = { id: 'one', name: 'photos', handle: { queryPermission: () => permission } };
  const code = page.slice(page.indexOf('  const loadSource = useCallback('), page.indexOf('  async function chooseFolder()')) + '\nexports.run = loadSource;';
  const { run } = load(code, {
    useCallback: callback => callback, sources: [source], scanActiveRef: { current: false },
    setLoading: value => { state.loading = value; }, setScanElapsed() {}, setError: message => { state.error = message; }, setNotice() {},
    setPhotoScan: update => { state.scan = typeof update === 'function' ? update(state.scan) : update; state.phases.push(state.scan.phase); },
    scanDirectory: async (_source, progress) => { state.scans++; progress({ photos: 1, files: 2, folders: 1, currentPath: 'photos/one.heic' }); return scanning; },
    dbSet: async () => { if (saveFailure) throw new Error('save_failed'); await saving; }, SOURCES_KEY: 'sources',
    setSources: () => { state.libraryUpdated = true; }, setPhotos() {},
  });
  return { run: () => run(source), state, grant: () => grant(denied ? 'denied' : 'granted'), completeScan: () => completeScan([{ size: 12 }]), save };
}
const tick = () => new Promise(resolve => setImmediate(resolve));
test('rescan immediately reports permissions, scanning, saving, and completion without duplicate scans', async () => {
  const f = fixture(); const running = f.run();
  assert.equal(f.state.scan.phase, 'permission'); assert.equal(f.state.loading, true);
  await f.run(); assert.equal(f.state.scans, 0);
  f.grant(); await tick(); assert.equal(f.state.scan.phase, 'scanning');
  f.completeScan(); await tick(); assert.equal(f.state.scan.phase, 'saving'); assert.equal(f.state.libraryUpdated, false);
  f.save(); await running; assert.equal(f.state.scan.phase, 'completed'); assert.equal(f.state.loading, false); assert.equal(f.state.libraryUpdated, true);
  assert.equal(f.state.scans, 1);
});
test('permission failure produces a visible failed state and retains the library', async () => {
  const f = fixture({ denied: true }); const running = f.run(); f.grant(); await running;
  assert.equal(f.state.scan.phase, 'failed'); assert.ok(f.state.scan.message); assert.equal(f.state.loading, false);
  assert.equal(f.state.scans, 0); assert.equal(f.state.libraryUpdated, false);
});
test('index persistence failure reports failure without replacing the visible library', async () => {
  const f = fixture({ saveFailure: true }); const running = f.run(); f.grant(); await tick(); f.completeScan(); await running;
  assert.equal(f.state.scan.phase, 'failed'); assert.equal(f.state.scan.message, 'save_failed'); assert.equal(f.state.libraryUpdated, false); assert.equal(f.state.loading, false);
});
