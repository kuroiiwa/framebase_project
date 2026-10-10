import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import { runBackupWithRetries } from "../server/framebase-backup-retry.mjs";

function fixture(results) {
  const controller = new AbortController();
  const attempts = []; const retries = []; const waits = [];
  const options = {
    signal: controller.signal,
    run: async attempt => { attempts.push(attempt); const result = results.shift(); if (result instanceof Error) throw result; return result; },
    onRetry: async retry => { retries.push(retry); },
    wait: async ms => { waits.push(ms); },
  };
  return { options, controller, attempts, retries, waits };
}

test("successful backup never retries", async () => {
  const f = fixture([{ status: "completed" }]);
  assert.equal((await runBackupWithRetries(f.options)).status, "completed");
  assert.deepEqual(f.attempts, [0]);
  assert.deepEqual(f.waits, []);
});

test("backup retries at most twice and reports exhaustion", async () => {
  const f = fixture(Array.from({ length: 3 }, () => ({ status: "network_error", message: "Temporary network error" })));
  const result = await runBackupWithRetries(f.options);
  assert.equal(result.status, "network_error");
  assert.deepEqual(f.attempts, [0, 1, 2]);
  assert.deepEqual(f.waits, [5000, 10000]);
  assert.deepEqual(f.retries.map(item => item.retry), [1, 2]);
  assert.match(result.message, /2/);
});

test("verification failure can recover on the second retry", async () => {
  const f = fixture([{ status: "verification_failed" }, { status: "network_error" }, { status: "completed" }]);
  assert.equal((await runBackupWithRetries(f.options)).status, "completed");
  assert.deepEqual(f.attempts, [0, 1, 2]);
});

for (const status of ["needs_auth", "tool_missing", "indexing_failed", "empty", "aborted"]) {
  test(`${status} is returned without automatic retries`, async () => {
    const f = fixture([{ status }]);
    assert.equal((await runBackupWithRetries(f.options)).status, status);
    assert.deepEqual(f.attempts, [0]);
    assert.equal(f.retries.length, 0);
  });
}

test("unexpected tool exception retries without exposing diagnostic text", async () => {
  const f = fixture([new Error("private details"), { status: "completed" }]);
  assert.equal((await runBackupWithRetries(f.options)).status, "completed");
  assert.deepEqual(f.attempts, [0, 1]);
  assert.doesNotMatch(f.retries[0].result.message, /private/);
});

test("pausing during retry delay aborts immediately and never launches another attempt", async () => {
  const f = fixture([{ status: "network_error" }]);
  f.options.wait = async (_ms, signal) => { f.controller.abort(); signal.throwIfAborted(); };
  assert.equal((await runBackupWithRetries(f.options)).status, "aborted");
  assert.deepEqual(f.attempts, [0]);
});

test("canceling a running attempt prevents retry even if the tool returns a failure", async () => {
  const f = fixture([]);
  f.options.run = async () => { f.controller.abort(); return { status: "network_error" }; };
  assert.equal((await runBackupWithRetries(f.options)).status, "aborted");
  assert.equal(f.retries.length, 0);
});

test("an already stopped job never starts the tool", async () => {
  const f = fixture([]); f.controller.abort();
  assert.equal((await runBackupWithRetries(f.options)).status, "aborted");
  assert.equal(f.attempts.length, 0);
});

test("server retry reloads verified files and completed ranges from the latest checkpoint", async () => {
  const source = readFileSync(new URL('../server/framebase-lan-server.mjs', import.meta.url), 'utf8');
  const start = source.indexOf('run: async attempt => {');
  const end = source.indexOf('\n          },\n        });', start);
  assert.ok(start >= 0 && end > start);
  const calls = [];
  let state = { completedRanges: [], planned: 0, downloaded: 0, verified: 0 };
  let files = [{ relativePath: 'old.jpg' }];
  const icloud = {
    readFullBackup: async () => state,
    readFullManifest: async () => ({ files }),
    writeFullBackup: async (_username, update) => { state = { ...state, ...update }; return state; },
    writeFullManifest: async (_username, added) => { files = [...files, ...added]; return { files }; },
    recordCompletedRanges: async () => {},
  };
  const controller = new AbortController();
  const run = vm.runInNewContext(`(${source.slice(start + 5, end)}\n})`, {
    icloud, controller, current: { username: 'alice' }, context: {}, resumingExisting: false,
    previousState: state, previousManifest: { files }, initialCompletedRanges: [],
    ranges: [{ key: 'first' }, { key: 'second' }],
    icloudProvider: { backupAll: async options => {
      calls.push(options);
      if (calls.length === 1) {
        await options.onRangeComplete({ files: [{ relativePath: 'first.jpg' }], completedRanges: ['first'] });
        return { status: 'network_error', message: 'Network interrupted', files: [] };
      }
      assert.deepEqual(Array.from(options.initialCompletedRanges), ['first']);
      assert.deepEqual(options.previousFiles.map(item => item.relativePath), ['old.jpg', 'first.jpg']);
      assert.equal(options.signal, controller.signal);
      return { status: 'completed', files: [{ relativePath: 'second.jpg' }], completedRanges: ['first', 'second'] };
    } },
  });
  const result = await runBackupWithRetries({ run, signal: controller.signal, onRetry: async () => {}, wait: async () => {} });
  assert.equal(result.status, 'completed');
  assert.equal(calls.length, 2);
  assert.deepEqual(files.map(item => item.relativePath), ['old.jpg', 'first.jpg', 'second.jpg']);
  assert.deepEqual(Array.from(state.completedRanges), ['first', 'second']);
});
