import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDebugLogs, logToolDiagnostic } from "../server/framebase-debug-logs.mjs";
import { createReleaseDeleteJobs } from "../server/framebase-release-jobs.mjs";
import { createIcloudPdProvider } from "../server/icloud-providers/icloudpd-provider.mjs";

test("diagnostic field names are not mistaken for traceback exceptions", () => {
  let data;
  logToolDiagnostic({ write: (_event, value) => { data = value; } }, "failure", {
    stderr: 'FRAMEBASE_ERROR {"status":"photos_error","reason":"photos_indexing","indexingState":"RUNNING","readProbeError":null}\nNameError: fixture\n',
    code: 1,
  });
  assert.deepEqual(data.exceptions, ["NameError"]);
  assert.equal(data.records[0].indexingState, "RUNNING");
  assert.equal(data.records[0].readProbeError, null);
});

test("readable FAILED index verifies access but never turns an unmatched target into missing", async () => {
  const root = await mkdtemp(join(tmpdir(), "framebase-index-probe-"));
  try {
    const executablePath = join(root, "tool.exe"); await writeFile(executablePath, "fixture");
    const indexing = 'FRAMEBASE_INDEXING {"indexingState":"FAILED","readProbe":"readable","zoneName":"PrimarySync","count":4679}\n';
    let matched = false;
    const provider = createIcloudPdProvider({ executablePath, runCommand: async (_exe, args, options) => {
      if (args.includes("--version")) return { stdout: "version:1.32.3" };
      if (args.includes("--auth-only")) return { stdout: "" };
      if (!options.env.FRAMEBASE_DELETE_REQUEST) return { stdout: indexing + "one.jpg" };
      assert.equal(options.env.FRAMEBASE_DELETE_COMMIT, undefined);
      const output = indexing + (matched ? 'FRAMEBASE_DELETE {"id":"one","library":"default","status":"matched","bytes":100}\n' : "") + 'FRAMEBASE_DELETE_DONE {"total":1,"processed":1}\n';
      options.onStdout(output);
      return { stdout: output };
    } });
    const logs = createDebugLogs({ projectRoot: root }); const log = logs.start("alice", "verify");
    const context = { appleAccount: "test@example.com", domain: "cn", sessionDirectory: join(root, "session"), backupDirectory: root, debugLog: log };
    const verification = await provider.verifyRuntimeSession("alice", context);
    assert.equal(verification.status, "connected"); assert.match(verification.message, /精确复核/);
    assert.match(logs.read("alice", log.info.id).toString(), /"readProbe":"readable"/);
    const progress = [];
    const options = { ...context, jobKey: "alice", assets: [{ id: "one", library: "default", name: "one.jpg", created: "2023-12-01", originalBytes: 100 }], commit: false, onProgress: value => progress.push(value) };
    const previousCommit = process.env.FRAMEBASE_DELETE_COMMIT;
    process.env.FRAMEBASE_DELETE_COMMIT = "1";
    try {
      const incomplete = await provider.deleteAssets(options);
      assert.equal(incomplete.status, "incomplete"); assert.doesNotMatch(incomplete.message, /未找到/);
      matched = true;
      progress.length = 0;
      const complete = await provider.deleteAssets(options);
      assert.equal(complete.status, "matched"); assert.equal(complete.count, 1);
      const firstMatched = progress.findIndex(value => value.processed === 1);
      assert.ok(firstMatched >= 0);
      assert.ok(progress.slice(firstMatched).every(value => value.processed === 1 && !value.message.includes("索引状态为 FAILED")));
    } finally {
      if (previousCommit === undefined) delete process.env.FRAMEBASE_DELETE_COMMIT;
      else process.env.FRAMEBASE_DELETE_COMMIT = previousCommit;
    }
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("logs isolate owners, redact secrets, retain files and cap output", async () => {
  const root = await mkdtemp(join(tmpdir(), "framebase-logs-"));
  try {
    const logs = createDebugLogs({ projectRoot: root, maxFiles: 2, maxBytes: 6000 });
    const first = logs.start("alice", "preview", { password: "hidden", nested: { cookie: "hidden", text: "token=hidden user@example.com" } });
    logToolDiagnostic(first, "tool_failure", Object.assign(new Error("do not log raw message"), { code: 1, stderr: 'echoed-password\nNameError\nFRAMEBASE_ERROR {"status":"indexing","reason":"photos_indexing","password":"hidden"}' }));
    const content = logs.read("alice", first.info.id).toString();
    assert.match(content, /photos_indexing/); assert.match(content, /NameError/);
    assert.doesNotMatch(content, /hidden|echoed-password|user@example|do not log raw/);
    assert.equal(logs.read("bobby", first.info.id), null);
    assert.equal(logs.read("alice", "../anything"), null);
    assert.throws(() => logs.start("../bad", "preview"));
    for (let i = 0; i < 10; i++) first.write("large", { value: "x".repeat(4000) });
    first.write("finished", { status: "failed" });
    assert.ok(logs.read("alice", first.info.id).length < 6100);
    assert.match(logs.read("alice", first.info.id).toString(), /"event":"finished"/);
    logs.start("alice", "next"); logs.start("alice", "last");
    assert.equal(logs.list("alice").length, 2);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("a logging filesystem failure is visible without throwing into an operation", async () => {
  const root = await mkdtemp(join(tmpdir(), "framebase-logs-denied-"));
  try {
    const blockedRoot = join(root, "file"); await writeFile(blockedRoot, "not a directory");
    const log = createDebugLogs({ projectRoot: blockedRoot }).start("alice", "preview");
    assert.match(log.info.error, /日志写入失败/);
    assert.doesNotThrow(() => log.write("finished", { status: "completed" }));
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("failed jobs expose a correlated persistent log without executing a deletion", async () => {
  const root = await mkdtemp(join(tmpdir(), "framebase-job-logs-"));
  try {
    const logs = createDebugLogs({ projectRoot: root });
    const jobs = createReleaseDeleteJobs({ debugLogs: logs,
      icloud: { connectionContext: async () => ({}) }, recycleBin: {},
      provider: { deleteAssets: async options => { assert.equal(options.commit, false); options.onProgress({ phase: "verifying", processed: 0 }); throw new Error("fixture failure"); } },
    });
    const job = jobs.start("alice", { assets: [{ name: "IMG_0050.JPG" }], preview: true });
    assert.ok(job.debugLog.path.startsWith(root));
    const done = await jobs.wait("alice", job.id);
    assert.equal(done.status, "failed");
    const content = logs.read("alice", job.debugLog.id).toString();
    assert.match(content, /IMG_0050.JPG/); assert.match(content, /exception/); assert.match(content, /finished/);
    const reopened = createDebugLogs({ projectRoot: root });
    assert.equal(reopened.list("alice")[0].id, job.debugLog.id);
  } finally { await rm(root, { recursive: true, force: true }); }
});

for (const [reason, state, expected] of [["photos_indexing", "RUNNING", "indexing"], ["photos_indexing_failed", "FAILED", "indexing_failed"]]) test(`provider records ${state} indexing diagnostics and exit code for session validation`, async () => {
  const root = await mkdtemp(join(tmpdir(), "framebase-tool-logs-"));
  try {
    const executablePath = join(root, "tool.exe"); await writeFile(executablePath, "fixture");
    const logs = createDebugLogs({ projectRoot: root }); const log = logs.start("alice", "verify");
    const provider = createIcloudPdProvider({ executablePath, runCommand: async (_exe, args) => {
      if (args.includes("--version")) return { stdout: "version:1.32.3" };
      throw Object.assign(new Error("fixture"), { code: 1, stderr: `FRAMEBASE_ERROR ${JSON.stringify({ status: "photos_error", reason, indexingState: state, zoneName: "PrimarySync" })}` });
    } });
    const result = await provider.verifyRuntimeSession("alice", { appleAccount: "user@example.com", domain: "com", sessionDirectory: join(root, "session"), backupDirectory: root, debugLog: log });
    assert.equal(result.status, expected);
    const content = logs.read("alice", log.info.id).toString();
    assert.match(content, /verify_tool_failure/); assert.match(content, /"code":1/); assert.match(content, /photos_indexing/); assert.ok(content.includes(state)); assert.match(content, /PrimarySync/);
  } finally { await rm(root, { recursive: true, force: true }); }
});
