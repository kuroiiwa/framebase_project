import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createIcloudPdProvider } from "../server/icloud-providers/icloudpd-provider.mjs";

test("running indexes allow partial backup without recording complete ranges; a later finished index completes", async t => {
  const root = await mkdtemp(join(tmpdir(), "framebase-index-backup-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const executablePath = join(root, "icloudpd.exe");
  const backupDirectory = join(root, "backup");
  await writeFile(executablePath, "test");
  await mkdir(join(backupDirectory, "2026/10"), { recursive: true });
  let indexing = true;
  const checkpoints = [];
  const calls = [];
  const provider = createIcloudPdProvider({ executablePath, runCommand: async (_executable, args, options) => {
    if (args.includes("--version")) return { stdout: "version:1.32.3" };
    calls.push({ args, options });
    assert.equal(options.env.FRAMEBASE_BACKUP_READONLY, "1");
    if (args.includes("--list-libraries")) return { stdout: indexing ? 'FRAMEBASE_INDEXING {"indexingState":"FAILED","zoneName":"OtherSync","readProbe":"readable","count":1}\nFRAMEBASE_INDEXING {"indexingState":"RUNNING","zoneName":"PrimarySync","readProbe":"readable","count":2}\n' : "" };
    if (args.includes("--only-print-filenames")) return { stdout: "2026/10/image.jpg\n" };
    await writeFile(join(backupDirectory, "2026/10/image.jpg"), "photo");
    return { stdout: "" };
  } });
  const context = { jobKey: "alice", appleAccount: "alice@example.com", domain: "cn", sessionDirectory: join(root, "session"), backupDirectory, ranges: [{ key: "october", label: "2026年10月", start: "2026-10-01T00:00:00", end: "2026-10-31T23:59:59" }], onRangeComplete: update => checkpoints.push(update) };
  const partial = await provider.backupAll(context);
  assert.equal(partial.status, "indexing");
  assert.equal(partial.files.length, 1);
  assert.equal(partial.failed, 0);
  assert.deepEqual(partial.completedRanges, []);
  assert.equal(checkpoints[0].files.length, 1);
  assert.deepEqual(checkpoints[0].completedRanges, []);
  assert.match(partial.message, /未标记完成/);
  assert.ok(calls.some(call => !call.args.includes("--only-print-filenames") && !call.args.includes("--list-libraries")));
  indexing = false;
  const complete = await provider.backupAll({ ...context, previousFiles: partial.files, initialCompletedRanges: partial.completedRanges });
  assert.equal(complete.status, "completed");
  assert.deepEqual(complete.completedRanges, ["october"]);
});

test("a blocked RUNNING probe reports updating instead of FAILED and never downloads", async t => {
  const root = await mkdtemp(join(tmpdir(), "framebase-blocked-index-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const executablePath = join(root, "icloudpd.exe");
  await writeFile(executablePath, "test");
  let operations = 0;
  const provider = createIcloudPdProvider({ executablePath, runCommand: async (_executable, args) => {
    if (args.includes("--version")) return { stdout: "version:1.32.3" };
    operations++;
    throw Object.assign(new Error("exit 1"), { stdout: 'FRAMEBASE_ERROR {"status":"photos_error","reason":"photos_indexing","indexingState":"RUNNING","readProbeError":"ValueError"}' });
  } });
  const result = await provider.backupAll({ jobKey: "alice", backupDirectory: join(root, "backup"), sessionDirectory: join(root, "session") });
  assert.equal(result.status, "indexing");
  assert.match(result.message, /仍在更新（RUNNING）/);
  assert.doesNotMatch(result.message, /索引异常|FAILED/);
  assert.equal(operations, 1);
});
