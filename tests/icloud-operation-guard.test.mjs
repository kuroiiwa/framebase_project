import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import { createIcloudOperationGuard, icloudOperationKind } from "../server/framebase-icloud-operation-guard.mjs";

function fixture() {
  const backups = new Set(); const releases = new Set();
  const guard = createIcloudOperationGuard({ backupRunning: username => backups.has(username), releaseRunning: username => releases.has(username) });
  return { guard, backups, releases };
}

test("all backup and release entry points are guarded; pause, cancel and polling remain available", () => {
  for (const path of ["backup/test", "backup/full/start", "backup/full/resume"]) assert.equal(icloudOperationKind("POST", `/api/icloud/${path}`), "backup");
  for (const path of ["release/delete", "release/delete/preview", "release/plan"]) assert.equal(icloudOperationKind("POST", `/api/icloud/${path}`), "release");
  for (const path of ["backup/full/pause", "backup/full/cancel", "release/delete/status", "config"]) assert.equal(icloudOperationKind("POST", `/api/icloud/${path}`), null);
  assert.equal(icloudOperationKind("GET", "/api/icloud/config"), null);
});

for (const [active, requested] of [["backup", "release"], ["release", "backup"], ["backup", "backup"], ["release", "release"]]) {
  test(`${active} request reserves immediately and blocks simultaneous ${requested} request`, () => {
    const { guard } = fixture();
    const first = guard.acquire("alice", active);
    assert.ok(first.release);
    const second = guard.acquire("alice", requested);
    assert.ok(second.error);
    if (active === "backup" && requested === "release") assert.match(second.error, /先暂停备份/);
    if (active === "release" && requested === "backup") assert.match(second.error, /不能开始或继续备份/);
    assert.ok(guard.acquire("bob", requested).release);
    first.release();
    const next = guard.acquire("alice", requested);
    assert.ok(next.release);
    first.release(); // An old cleanup must not release a newer reservation.
    assert.ok(guard.acquire("alice", active).error);
    next.release();
  });
}

test("background jobs remain protected after the start request returns", () => {
  const { guard, backups, releases } = fixture();
  const start = guard.acquire("alice", "backup");
  backups.add("alice"); start.release();
  assert.match(guard.acquire("alice", "release").error, /备份正在运行/);
  backups.delete("alice");
  const release = guard.acquire("alice", "release");
  releases.add("alice"); release.release();
  assert.match(guard.acquire("alice", "backup").error, /释放或复核正在运行/);
  releases.delete("alice");
  assert.ok(guard.acquire("alice", "backup").release);
});

test("actual HTTP handler returns a visible 409 before launching a conflicting operation", async () => {
  const source = readFileSync(new URL('../server/framebase-lan-server.mjs', import.meta.url), 'utf8');
  const start = source.indexOf('async function handleIcloud(request, response, url)');
  const end = source.indexOf('async function handleIcloudOperation', start);
  assert.ok(start >= 0 && end > start);
  const { guard } = fixture();
  let finish; let executions = 0;
  const handler = vm.runInNewContext(`${source.slice(start, end)}\nhandleIcloud;`, {
    requirePc: () => ({ username: 'alice' }),
    icloudOperationKind, icloudOperationGuard: guard,
    json: (_response, status, body) => ({ status, ...body }),
    handleIcloudOperation: async () => { executions += 1; await new Promise(resolve => { finish = resolve; }); return { status: 202 }; },
  });
  const request = { method: 'POST', headers: { origin: 'http://localhost:3000', host: 'localhost:3000' } };
  const first = handler(request, {}, { pathname: '/api/icloud/backup/full/start' });
  const rejected = await handler(request, {}, { pathname: '/api/icloud/release/delete/preview' });
  assert.equal(rejected.status, 409);
  assert.match(rejected.error, /先暂停备份/);
  assert.equal(executions, 1);
  finish(); await first;
  const next = handler(request, {}, { pathname: '/api/icloud/release/delete' });
  finish(); await next;
  assert.equal(executions, 2);
});

test("HTTP request validation errors release the reservation instead of blocking future tasks", async () => {
  const source = readFileSync(new URL('../server/framebase-lan-server.mjs', import.meta.url), 'utf8');
  const start = source.indexOf('async function handleIcloud(request, response, url)');
  const end = source.indexOf('async function handleIcloudOperation', start);
  const { guard } = fixture();
  const handler = vm.runInNewContext(`${source.slice(start, end)}\nhandleIcloud;`, {
    requirePc: () => ({ username: 'alice' }), icloudOperationKind, icloudOperationGuard: guard,
    json: (_response, status, body) => ({ status, ...body }),
    handleIcloudOperation: async () => { throw new Error('Invalid plan'); },
  });
  await assert.rejects(handler({ method: 'POST', headers: { origin: 'http://localhost', host: 'localhost' } }, {}, { pathname: '/api/icloud/release/delete' }), /Invalid plan/);
  assert.ok(guard.acquire('alice', 'backup').release);
});
