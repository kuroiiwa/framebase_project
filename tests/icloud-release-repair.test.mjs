import assert from 'node:assert/strict';
import test from 'node:test';
import { repairBackupMonths } from '../app/icloud/release-repair.ts';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';

test('repair selection chooses distinct months rather than a spanning range', () => {
  const files = ['2017/12/09/a.MOV', '2017/12/20/b.MOV', '2019\\11\\29\\c.MOV'];
  const result = repairBackupMonths(files.map(relativePath => ({ relativePath })), ['2017-12', '2018-01', '2019-11']);
  assert.deepEqual(result, { months: ['2017-12', '2019-11'], unavailableMonths: [], unknownCount: 0 });
});

test('unavailable cloud months and invalid dates are reported instead of selected', () => {
  const files = ['2024/02/29/a.MOV', '2023/02/29/b.MOV', '2024/13/01/c.MOV', 'unknown.MOV', '2024/03/01/d.MOV'];
  const result = repairBackupMonths(files.map(relativePath => ({ relativePath })), ['2024-02']);
  assert.deepEqual(result, { months: ['2024-02'], unavailableMonths: ['2024-03'], unknownCount: 3 });
});

const source = readFileSync(new URL('../app/icloud/page.tsx', import.meta.url), 'utf8');
const ast = ts.createSourceFile('page.tsx', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
let createPlan;
let busyExpression;
let statusEffect;
function find(node) {
  if (ts.isFunctionDeclaration(node) && node.name?.text === 'createReleasePlan') createPlan = node.getText(ast);
  if (ts.isVariableDeclaration(node) && node.name.getText(ast) === 'busy') busyExpression = node.initializer.getText(ast);
  if (ts.isCallExpression(node) && node.expression.getText(ast) === 'useEffect' && node.arguments[0]?.getText(ast).includes('/api/icloud/release/status')) statusEffect = node.arguments[0].getText(ast);
  ts.forEachChild(node, find);
}
find(ast);
assert.ok(createPlan && busyExpression && statusEffect);
const workflow = ts.transpileModule(`${createPlan}\nfunction readBusy() { return ${busyExpression}; }\nconst startPolling = ${statusEffect};`, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;

for (const immediate of ['completed', 'running', 'failed']) {
  test(`release controls recover when request returns ${immediate} before polling sees running`, async () => {
    const context = vm.createContext({
      requestBusy: null, releaseProgress: null, config: {}, errors: [],
      setBusy(value) { context.requestBusy = typeof value === 'function' ? value(context.requestBusy) : value; },
      setReleaseProgress(value) { context.releaseProgress = value; },
      setConfig(update) { context.config = update(context.config); },
      setError(value) { if (value) context.errors.push(value); },
      setMessage() {}, setReleaseAcknowledged() {},
      fetch: async url => ({ ok: true, json: async () => url.endsWith('/plan') ? { releaseProgress: { status: immediate } } : { releaseProgress: { status: 'completed' }, releasePlan: { id: 'ready', status: 'ready' } } }),
      setInterval() { return 1; }, clearInterval() {},
    });
    const api = vm.runInContext(`${workflow}\n({ createReleasePlan, readBusy, startPolling })`, context);
    await api.createReleasePlan();
    assert.equal(api.readBusy(), immediate === 'running' ? 'release' : null);
    const stop = api.startPolling();
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(api.readBusy(), null);
    assert.equal(context.config.releasePlan.id, 'ready');
    // A background completion must not unlock a separate confirmation request.
    context.requestBusy = 'release';
    assert.equal(api.readBusy(), 'release');
    stop();
  });
}
