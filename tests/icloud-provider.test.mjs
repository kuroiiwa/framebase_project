import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createIcloudPdProvider, inventoryRecoveryLimits, isTolerableInventoryGap } from "../server/icloud-providers/icloudpd-provider.mjs";

test("timeline recovery starts with a small reverse window and expands only when needed", () => {
  assert.deepEqual(inventoryRecoveryLimits(4680, 4670), [64, 256, 1024, 4680]);
  assert.deepEqual(inventoryRecoveryLimits(4680, 3000), [1712, 4680]);
  assert.deepEqual(inventoryRecoveryLimits(3, 2), [3]);
  assert.deepEqual(inventoryRecoveryLimits(100, 100), []);
});

test("a small stable Apple index gap stops repeated reverse scans", async () => {
  assert.equal(isTolerableInventoryGap(4680, 4670), true);
  assert.equal(isTolerableInventoryGap(100, 99), false);
  assert.equal(isTolerableInventoryGap(4680, 4600), false);
  const root = await mkdtemp(join(tmpdir(), "framebase-provider-stable-gap-"));
  const executablePath = join(root, "icloudpd.exe");
  try {
    await writeFile(executablePath, "test");
    const inventory = Array.from({ length: 4670 }, (_, index) => `FRAMEBASE_INVENTORY {"id":"asset-${index}","created":"2025-03-02T10:00:00+08:00","mediaType":"photo","originalBytes":100,"livePhoto":false,"raw":false}`);
    let reverseCalls = 0;
    const provider = createIcloudPdProvider({
      executablePath,
      runCommand: async (_executable, args, options) => {
        if (args.includes("--version")) return { stdout: "version:1.32.3\n", stderr: "" };
        if (args.includes("--list-libraries")) return { stdout: "", stderr: "" };
        if (options?.env?.FRAMEBASE_INVENTORY_DIRECTION === "DESCENDING") {
          reverseCalls += 1;
          return { stdout: ['FRAMEBASE_INVENTORY_TOTAL {"count":4680,"library":"default"}', ...inventory.slice(-64)].join("\n"), stderr: "" };
        }
        return { stdout: ['FRAMEBASE_INVENTORY_TOTAL {"count":4680,"library":"default"}', ...inventory].join("\n"), stderr: "" };
      },
    });
    const result = await provider.scanTimeline({ jobKey: "alice", appleAccount: "alice@example.com", domain: "cn", sessionDirectory: join(root, "session"), backupDirectory: join(root, "backup") });
    assert.equal(result.status, "ready");
    assert.equal(result.total.itemCount, 4670);
    assert.match(result.message, /10 个不可枚举记录/);
    assert.equal(reverseCalls, 1);
    // During unfinished indexing, the same stable gap is not a complete recount.
    const unfinished = createIcloudPdProvider({ executablePath, runCommand: async (_executable, args) => {
      if (args.includes("--version")) return { stdout: "version:1.32.3\n" };
      if (args.includes("--list-libraries")) return { stdout: "" };
      return { stdout: ['FRAMEBASE_INDEXING {"indexingState":"RUNNING","readProbe":"readable"}', 'FRAMEBASE_INVENTORY_TOTAL {"count":4680}', ...inventory].join("\n") };
    } });
    const incomplete = await unfinished.scanTimeline({ jobKey: "alice", appleAccount: "alice@example.com", domain: "cn", sessionDirectory: join(root, "session"), backupDirectory: join(root, "backup") });
    assert.equal(incomplete.status, "incomplete");
    assert.match(incomplete.message, /已保留上次统计/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("icloudpd provider verifies an existing session without placing a password in process arguments", async () => {
  const root = await mkdtemp(join(tmpdir(), "framebase-provider-"));
  const executablePath = join(root, "icloudpd.exe");
  const calls = [];
  try {
    await writeFile(executablePath, "test");
    const provider = createIcloudPdProvider({
      executablePath,
      runCommand: async (executable, args, options) => {
        calls.push({ executable, args, options });
        return args.includes("--version") ? { stdout: "icloudpd 1.32.3\n", stderr: "" } : { stdout: "", stderr: "" };
      },
    });
    const info = await provider.info();
    assert.equal(info.available, true);
    const result = await provider.verifyExistingSession({
      appleAccount: "alice@example.com",
      domain: "cn",
      sessionDirectory: join(root, "session"),
      backupDirectory: join(root, "backup"),
    });
    assert.equal(result.status, "connected");
    const verifyCall = calls.find(call => call.args.includes("--auth-only"));
    assert.ok(calls.at(-1).args.includes("--only-print-filenames"));
    assert.equal(calls.at(-1).args[calls.at(-1).args.indexOf("--recent") + 1], "1");
    assert.equal(verifyCall.executable, executablePath);
    assert.ok(verifyCall.args.includes("--auth-only"));
    assert.ok(verifyCall.args.includes("--cookie-directory"));
    assert.equal(verifyCall.args.includes("--password"), false);
    assert.equal(verifyCall.args.some(value => /secret|password123/i.test(value)), false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("icloudpd provider reports a missing authentication session without exposing tool output", async () => {
  const root = await mkdtemp(join(tmpdir(), "framebase-provider-auth-"));
  const executablePath = join(root, "icloudpd.exe");
  try {
    await writeFile(executablePath, "test");
    const provider = createIcloudPdProvider({
      executablePath,
      runCommand: async (_executable, args) => {
        if (args.includes("--version")) return { stdout: "icloudpd 1.32.3\n", stderr: "" };
        throw Object.assign(new Error("failed"), { stderr: "None of providers gave password for alice@example.com" });
      },
    });
    const result = await provider.verifyExistingSession({ appleAccount: "alice@example.com", domain: "com", sessionDirectory: join(root, "session"), backupDirectory: join(root, "backup") });
    assert.equal(result.status, "needs_auth");
    assert.equal(result.message.includes("alice@example.com"), false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("icloudpd provider scans a bounded recent sample without download or delete flags", async () => {
  const root = await mkdtemp(join(tmpdir(), "framebase-provider-scan-"));
  const executablePath = join(root, "icloudpd.exe");
  const scanCalls = [];
  let authData;
  let authExit;
  let spawnCount = 0;
  const writes = [];
  try {
    await writeFile(executablePath, "test");
    const provider = createIcloudPdProvider({
      executablePath,
      runCommand: async () => ({ stdout: "icloudpd 1.32.3\n", stderr: "" }),
      spawnProcess: (_executable, args) => {
        spawnCount += 1;
        let dataCallback;
        let exitCallback;
        const child = {
          onData: callback => { dataCallback = callback; if (spawnCount === 1) authData = callback; },
          onExit: callback => { exitCallback = callback; if (spawnCount === 1) authExit = callback; },
          write: value => { writes.push(value); },
          kill: () => exitCallback?.({ exitCode: 1 }),
        };
        if (spawnCount > 1) {
          scanCalls.push(args);
          queueMicrotask(() => {
            dataCallback(`${String.fromCharCode(27)}]0;icloudpd.exe${String.fromCharCode(7)}iCloud Password for alice@example.com:`);
            if (spawnCount === 3) dataCallback("SharedSync\r\n");
            if (spawnCount === 4) dataCallback("2026/09/IMG_0001.HEIC\r\nnot-a-media-entry\r\n2026/09/IMG_0002.MOV\r\n");
            exitCallback({ exitCode: 0 });
          });
        }
        return child;
      },
    });
    const context = { appleAccount: "alice@example.com", domain: "cn", sessionDirectory: join(root, "session"), backupDirectory: join(root, "backup") };
    await provider.startAuthentication("alice", context);
    authData("iCloud Password for alice@example.com:");
    provider.submitAuthenticationInput("alice", "password", "runtime-secret");
    authExit({ exitCode: 0 });
    const result = await provider.scanRecent({ ...context, jobKey: "alice", limit: 10 });
    assert.equal(result.status, "ready");
    assert.deepEqual(result.samples.map(item => item.mediaType), ["photo", "video"]);
    assert.deepEqual(writes, ["runtime-secret\r", "runtime-secret\r", "runtime-secret\r", "runtime-secret\r"]);
    assert.ok(scanCalls[0].includes("--only-print-filenames"));
    assert.ok(scanCalls[1].includes("--list-libraries"));
    assert.equal(scanCalls[2][scanCalls[2].indexOf("--library") + 1], "SharedSync");
    assert.equal(scanCalls[2][scanCalls[2].indexOf("--recent") + 1], "10");
    assert.equal(scanCalls.flat().includes("--dry-run"), false);
    assert.equal(scanCalls.flat().includes("--auto-delete"), false);
    assert.equal(scanCalls.flat().includes("--delete-after-download"), false);
    assert.equal(scanCalls.flat().includes("--keep-icloud-recent-days"), false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("icloudpd provider reuses a trusted session after FrameBase restarts", async () => {
  const root = await mkdtemp(join(tmpdir(), "framebase-provider-session-scan-"));
  const executablePath = join(root, "icloudpd.exe");
  const calls = [];
  try {
    await writeFile(executablePath, "test");
    const provider = createIcloudPdProvider({
      executablePath,
      runCommand: async (_executable, args) => {
        calls.push(args);
        if (args.includes("--version")) return { stdout: "version:1.32.3\n", stderr: "" };
        return { stdout: "2026/09/IMG_7100.PNG\n", stderr: "" };
      },
      spawnProcess: () => { throw new Error("trusted session scans must not open an interactive login"); },
    });
    const result = await provider.scanRecent({
      jobKey: "alice",
      appleAccount: "alice@example.com",
      domain: "cn",
      sessionDirectory: join(root, "session"),
      backupDirectory: join(root, "backup"),
      limit: 10,
    });
    assert.equal(result.status, "ready");
    assert.deepEqual(result.samples.map(item => item.name), ["IMG_7100.PNG"]);
    const scanArgs = calls.at(-1);
    assert.equal(scanArgs[scanArgs.indexOf("--password-provider") + 1], "parameter");
    assert.equal(scanArgs.includes("--password"), false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("icloudpd provider safely backs up at most three recent originals and verifies local files", async () => {
  const root = await mkdtemp(join(tmpdir(), "framebase-provider-safe-backup-"));
  const executablePath = join(root, "icloudpd.exe");
  const backupDirectory = join(root, "backup");
  const plannedPath = join(backupDirectory, "2026", "09", "IMG_7100.PNG");
  const calls = [];
  try {
    await writeFile(executablePath, "test");
    const provider = createIcloudPdProvider({
      executablePath,
      runCommand: async (_executable, args) => {
        calls.push(args);
        if (args.includes("--version")) return { stdout: "version:1.32.3\n", stderr: "" };
        if (args.includes("--only-print-filenames")) return { stdout: `${plannedPath}\n`, stderr: "" };
        await mkdir(join(backupDirectory, "2026", "09"), { recursive: true });
        await writeFile(plannedPath, "verified-media");
        return { stdout: "", stderr: "" };
      },
      spawnProcess: () => { throw new Error("trusted session backups must not open an interactive login"); },
    });
    const result = await provider.backupRecent({
      jobKey: "alice",
      appleAccount: "alice@example.com",
      domain: "cn",
      sessionDirectory: join(root, "session"),
      backupDirectory,
      limit: 99,
    });
    assert.equal(result.status, "completed");
    assert.equal(result.files.length, 1);
    assert.equal(result.files[0].size, 14);
    assert.match(result.files[0].sha256, /^[a-f0-9]{64}$/);
    const downloadArgs = calls.find(args => args.includes("--size"));
    assert.equal(downloadArgs[downloadArgs.indexOf("--recent") + 1], "3");
    assert.equal(downloadArgs[downloadArgs.indexOf("--size") + 1], "original");
    assert.equal(downloadArgs[downloadArgs.indexOf("--live-photo-size") + 1], "original");
    assert.equal(downloadArgs.includes("--only-print-filenames"), false);
    assert.equal(downloadArgs.includes("--auto-delete"), false);
    assert.equal(downloadArgs.includes("--delete-after-download"), false);
    assert.equal(downloadArgs.includes("--keep-icloud-recent-days"), false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("icloudpd provider incrementally backs up and hashes photos, videos, Live Photos, and RAW files without delete flags", async () => {
  const root = await mkdtemp(join(tmpdir(), "framebase-provider-full-backup-"));
  const executablePath = join(root, "icloudpd.exe");
  const backupDirectory = join(root, "backup");
  const photoPath = join(backupDirectory, "2026", "09", "IMG_7100.HEIC");
  const liveVideoPath = join(backupDirectory, "2026", "09", "IMG_7100.MOV");
  const rawPath = join(backupDirectory, "2026", "09", "IMG_7101.DNG");
  const calls = [];
  try {
    await writeFile(executablePath, "test");
    const provider = createIcloudPdProvider({
      executablePath,
      runCommand: async (_executable, args) => {
        calls.push(args);
        if (args.includes("--version")) return { stdout: "version:1.32.3\n", stderr: "" };
        if (args.includes("--list-libraries")) return { stdout: "SharedSync\n", stderr: "" };
        if (args.includes("--only-print-filenames")) return args.includes("SharedSync")
          ? { stdout: `${photoPath}\n${liveVideoPath}\n${rawPath}\n`, stderr: "" }
          : { stdout: "", stderr: "" };
        await mkdir(join(backupDirectory, "2026", "09"), { recursive: true });
        await writeFile(photoPath, "photo");
        await writeFile(liveVideoPath, "live-video");
        await writeFile(rawPath, "raw");
        return { stdout: "", stderr: "" };
      },
    });
    const photoHash = createHash("sha256").update("photo").digest("hex");
    const progress = [];
    const result = await provider.backupAll({
      jobKey: "alice", appleAccount: "alice@example.com", domain: "cn", sessionDirectory: join(root, "session"), backupDirectory,
      previousFiles: [{ relativePath: "2026/09/IMG_7100.HEIC", size: 5, sha256: photoHash }],
      ranges: [{ key: "2026-Q3", label: "2026 年第 3 季度", start: "2026-07-01T00:00:00", end: "2026-09-30T23:59:59" }],
      onProgress: update => progress.push(update),
    });
    assert.equal(result.status, "completed");
    assert.equal(result.files.length, 3);
    assert.deepEqual(result.files.map(item => item.mediaType), ["photo", "video", "photo"]);
    assert.equal(result.skipped, 1);
    assert.ok(result.files.every(item => /^[a-f0-9]{64}$/.test(item.sha256)));
    assert.ok(progress.some(item => item.phase === "planning"));
    assert.ok(progress.some(item => item.phase === "downloading"));
    assert.ok(progress.some(item => item.phase === "verifying"));
    const downloadArgs = calls.find(args => args.includes("--library") && !args.includes("--only-print-filenames"));
    assert.equal(downloadArgs[downloadArgs.indexOf("--size") + 1], "original");
    assert.equal(downloadArgs[downloadArgs.indexOf("--live-photo-size") + 1], "original");
    assert.equal(downloadArgs[downloadArgs.indexOf("--skip-created-before") + 1], "2026-07-01T00:00:00");
    assert.equal(downloadArgs[downloadArgs.indexOf("--skip-created-after") + 1], "2026-09-30T23:59:59");
    assert.equal(downloadArgs.some(argument => ["--auto-delete", "--delete-after-download", "--keep-icloud-recent-days"].includes(argument)), false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("full backup re-verifies existing local media when iCloud has nothing new to download", async () => {
  const root = await mkdtemp(join(tmpdir(), "framebase-provider-full-existing-"));
  const executablePath = join(root, "icloudpd.exe");
  const backupDirectory = join(root, "backup");
  const existingPath = join(backupDirectory, "2025", "IMG_0001.JPG");
  try {
    await writeFile(executablePath, "test");
    await mkdir(join(backupDirectory, "2025"), { recursive: true });
    await writeFile(existingPath, "existing-photo");
    const sha256 = createHash("sha256").update("existing-photo").digest("hex");
    const provider = createIcloudPdProvider({
      executablePath,
      runCommand: async (_executable, args) => args.includes("--version")
        ? { stdout: "version:1.32.3\n", stderr: "" }
        : { stdout: "", stderr: "" },
    });
    const result = await provider.backupAll({
      jobKey: "alice", appleAccount: "alice@example.com", domain: "cn", sessionDirectory: join(root, "session"), backupDirectory,
      previousFiles: [{ relativePath: "2025/IMG_0001.JPG", size: 14, sha256 }],
    });
    assert.equal(result.status, "completed");
    assert.equal(result.files.length, 1);
    assert.equal(result.planned, 1);
    assert.equal(result.skipped, 1);
    assert.equal(result.files[0].sha256, sha256);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("full backup reuses a persisted hash when size and modification time are unchanged", async () => {
  const root = await mkdtemp(join(tmpdir(), "framebase-provider-fast-existing-"));
  const executablePath = join(root, "icloudpd.exe");
  const backupDirectory = join(root, "backup");
  const existingPath = join(backupDirectory, "2025", "IMG_0002.JPG");
  let hashCalls = 0;
  try {
    await writeFile(executablePath, "test");
    await mkdir(join(backupDirectory, "2025"), { recursive: true });
    await writeFile(existingPath, "unchanged-photo");
    const fileInfo = await stat(existingPath);
    const sha256 = createHash("sha256").update("unchanged-photo").digest("hex");
    const provider = createIcloudPdProvider({
      executablePath,
      hashFile: async () => { hashCalls += 1; return sha256; },
      runCommand: async (_executable, args) => args.includes("--version")
        ? { stdout: "version:1.32.3\n", stderr: "" }
        : { stdout: "", stderr: "" },
    });
    const result = await provider.backupAll({
      jobKey: "alice", appleAccount: "alice@example.com", domain: "cn", sessionDirectory: join(root, "session"), backupDirectory,
      previousFiles: [{ relativePath: "2025/IMG_0002.JPG", extension: "jpg", mediaType: "photo", size: fileInfo.size, modifiedMs: fileInfo.mtimeMs, sha256, verifiedAt: "2026-01-01T00:00:00.000Z" }],
    });
    assert.equal(result.status, "completed");
    assert.equal(hashCalls, 0);
    assert.equal(result.skipped, 1);
    assert.equal(result.files[0].modifiedMs, fileInfo.mtimeMs);
    assert.equal(result.files[0].verifiedAt, "2026-01-01T00:00:00.000Z");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("selected backup ranges are planned, downloaded, and verified one at a time", async () => {
  const root = await mkdtemp(join(tmpdir(), "framebase-provider-ranges-in-order-"));
  const executablePath = join(root, "icloudpd.exe");
  const backupDirectory = join(root, "backup");
  const firstPath = join(backupDirectory, "2024", "01", "first.jpg");
  const secondPath = join(backupDirectory, "2025", "01", "second.jpg");
  const events = [];
  try {
    await writeFile(executablePath, "test");
    const provider = createIcloudPdProvider({
      executablePath,
      runCommand: async (_executable, args) => {
        if (args.includes("--version")) return { stdout: "version:1.32.3\n", stderr: "" };
        if (args.includes("--list-libraries")) return { stdout: "", stderr: "" };
        const start = args[args.indexOf("--skip-created-before") + 1];
        const year = start?.slice(0, 4);
        if (args.includes("--only-print-filenames")) {
          events.push(`plan-${year}`);
          return { stdout: `${year === "2024" ? firstPath : secondPath}\n`, stderr: "" };
        }
        events.push(`download-${year}`);
        const destination = year === "2024" ? firstPath : secondPath;
        await mkdir(join(backupDirectory, year, "01"), { recursive: true });
        await writeFile(destination, year);
        return { stdout: "", stderr: "" };
      },
    });
    const progress = [];
    const rangeCompletions = [];
    const result = await provider.backupAll({
      jobKey: "alice", appleAccount: "alice@example.com", domain: "cn", sessionDirectory: join(root, "session"), backupDirectory,
      ranges: [
        { key: "2024", label: "2024 年", start: "2024-01-01T00:00:00", end: "2024-12-31T23:59:59" },
        { key: "2025", label: "2025 年", start: "2025-01-01T00:00:00", end: "2025-12-31T23:59:59" },
      ],
      initialCompletedRanges: ["2024"],
      onProgress: update => progress.push(update),
      onRangeComplete: update => rangeCompletions.push(update),
    });
    assert.equal(result.status, "completed");
    assert.deepEqual(events, ["plan-2025", "download-2025"]);
    assert.deepEqual(result.completedRanges, ["2024", "2025"]);
    assert.equal(result.files.length, 1);
    assert.deepEqual(rangeCompletions.map(update => update.completedRanges), [["2024", "2025"]]);
    assert.deepEqual(rangeCompletions.map(update => update.files.length), [1]);
    assert.ok(progress.some(item => item.currentRange === "2024 年" && item.message.includes("直接跳过")));
    assert.ok(progress.some(item => item.currentRange === "2025 年" && item.rangeIndex === 2 && item.phase === "planning"));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("resume skips fully completed ranges before querying iCloud", async () => {
  const root = await mkdtemp(join(tmpdir(), "framebase-provider-completed-range-"));
  const executablePath = join(root, "icloudpd.exe");
  let cloudCalls = 0;
  try {
    await writeFile(executablePath, "test");
    const provider = createIcloudPdProvider({
      executablePath,
      runCommand: async (_executable, args) => {
        if (args.includes("--version")) return { stdout: "version:1.32.3\n", stderr: "" };
        cloudCalls += 1;
        return { stdout: "", stderr: "" };
      },
    });
    const result = await provider.backupAll({
      jobKey: "alice", appleAccount: "alice@example.com", domain: "cn", sessionDirectory: join(root, "session"), backupDirectory: join(root, "backup"),
      ranges: [{ key: "2024", label: "2024 年", start: "2024-01-01T00:00:00", end: "2024-12-31T23:59:59" }],
      initialCompletedRanges: ["2024"],
    });
    assert.equal(result.status, "completed");
    assert.equal(cloudCalls, 0);
    assert.deepEqual(result.completedRanges, ["2024"]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("planning emits heartbeat progress while iCloud is still responding", async () => {
  const root = await mkdtemp(join(tmpdir(), "framebase-provider-planning-heartbeat-"));
  const executablePath = join(root, "icloudpd.exe");
  try {
    await writeFile(executablePath, "test");
    const provider = createIcloudPdProvider({
      executablePath,
      progressInterval: 10,
      runCommand: async (_executable, args) => {
        if (args.includes("--version")) return { stdout: "version:1.32.3\n", stderr: "" };
        if (args.includes("--list-libraries")) await new Promise(resolve => setTimeout(resolve, 35));
        return { stdout: "", stderr: "" };
      },
    });
    const progress = [];
    await provider.backupAll({ jobKey: "alice", appleAccount: "alice@example.com", domain: "cn", sessionDirectory: join(root, "session"), backupDirectory: join(root, "backup"), onProgress: update => progress.push(update) });
    assert.ok(progress.some(update => update.phase === "planning" && update.message.includes("已等待") && update.message.includes("秒")));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("full backup verifies local files with a bounded two-worker pool", async () => {
  const root = await mkdtemp(join(tmpdir(), "framebase-provider-parallel-verification-"));
  const executablePath = join(root, "icloudpd.exe");
  const backupDirectory = join(root, "backup");
  const mediaDirectory = join(backupDirectory, "2025", "06");
  const mediaPaths = Array.from({ length: 5 }, (_, index) => join(mediaDirectory, `IMG_${index}.JPG`));
  let activeHashes = 0;
  let peakHashes = 0;
  try {
    await writeFile(executablePath, "test");
    const provider = createIcloudPdProvider({
      executablePath,
      hashFile: async path => {
        activeHashes += 1;
        peakHashes = Math.max(peakHashes, activeHashes);
        await new Promise(resolve => setTimeout(resolve, 15));
        activeHashes -= 1;
        return createHash("sha256").update(path).digest("hex");
      },
      runCommand: async (_executable, args) => {
        if (args.includes("--version")) return { stdout: "version:1.32.3\n", stderr: "" };
        if (args.includes("--list-libraries")) return { stdout: "", stderr: "" };
        if (args.includes("--only-print-filenames")) return { stdout: `${mediaPaths.join("\n")}\n`, stderr: "" };
        await mkdir(mediaDirectory, { recursive: true });
        await Promise.all(mediaPaths.map((path, index) => writeFile(path, `photo-${index}`)));
        return { stdout: "", stderr: "" };
      },
    });
    const progress = [];
    const result = await provider.backupAll({
      jobKey: "alice", appleAccount: "alice@example.com", domain: "cn", sessionDirectory: join(root, "session"), backupDirectory,
      ranges: [{ key: "2025-06", label: "2025 年 6 月", start: "2025-06-01T00:00:00", end: "2025-06-30T23:59:59" }],
      onProgress: update => progress.push(update),
    });
    assert.equal(result.status, "completed");
    assert.equal(result.files.length, 5);
    assert.equal(peakHashes, 2);
    assert.ok(result.files.every(item => /^[a-f0-9]{64}$/.test(item.sha256)));
    assert.ok(progress.some(item => item.phase === "verifying" && item.message.includes("2 路并行校验")));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("full backup reports live transfer rate and photo/video download counts", async () => {
  const root = await mkdtemp(join(tmpdir(), "framebase-provider-live-progress-"));
  const executablePath = join(root, "icloudpd.exe");
  const backupDirectory = join(root, "backup");
  const mediaDirectory = join(backupDirectory, "2025", "07");
  const photoPath = join(mediaDirectory, "IMG_1001.HEIC");
  const videoPath = join(mediaDirectory, "IMG_1001.MOV");
  try {
    await writeFile(executablePath, "test");
    const provider = createIcloudPdProvider({
      executablePath,
      progressInterval: 10,
      runCommand: async (_executable, args) => {
        if (args.includes("--version")) return { stdout: "version:1.32.3\n", stderr: "" };
        if (args.includes("--list-libraries")) return { stdout: "", stderr: "" };
        if (args.includes("--only-print-filenames")) return { stdout: `${photoPath}\n${videoPath}\n`, stderr: "" };
        await mkdir(mediaDirectory, { recursive: true });
        await writeFile(photoPath, Buffer.alloc(4096, 1));
        await new Promise(resolve => setTimeout(resolve, 30));
        await writeFile(videoPath, Buffer.alloc(8192, 2));
        await new Promise(resolve => setTimeout(resolve, 30));
        return { stdout: "", stderr: "" };
      },
    });
    const progress = [];
    const result = await provider.backupAll({
      jobKey: "alice", appleAccount: "alice@example.com", domain: "cn", sessionDirectory: join(root, "session"), backupDirectory,
      ranges: [{ key: "2025-07", label: "2025 年 7 月", start: "2025-07-01T00:00:00", end: "2025-07-31T23:59:59" }],
      onProgress: update => progress.push(update),
    });
    const live = progress.filter(item => item.phase === "downloading");
    assert.equal(result.status, "completed");
    assert.ok(live.some(item => item.plannedPhotoCount === 1 && item.plannedVideoCount === 1));
    assert.ok(live.some(item => item.syncedPhotoCount >= 1 && item.downloadedBytes >= 4096));
    assert.ok(live.some(item => item.transferRateBps > 0));
    assert.ok(live.some(item => item.syncedPhotoCount === 1 && item.syncedVideoCount === 1));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("provider builds exact year, quarter, and month summaries from read-only inventory metadata", async () => {
  const root = await mkdtemp(join(tmpdir(), "framebase-provider-timeline-"));
  const executablePath = join(root, "icloudpd.exe");
  const calls = [];
  const progress = [];
  try {
    await writeFile(executablePath, "test");
    const provider = createIcloudPdProvider({
      executablePath,
      runCommand: async (_executable, args, options) => {
        calls.push({ args, options });
        if (args.includes("--version")) return { stdout: "version:1.32.3\n", stderr: "" };
        if (args.includes("--list-libraries")) return { stdout: "SharedSync\n", stderr: "" };
        if (options?.env?.FRAMEBASE_INVENTORY_DIRECTION === "DESCENDING") return { stdout: [
          'FRAMEBASE_INVENTORY_TOTAL {"count":3,"library":"SharedSync"}',
          'FRAMEBASE_INVENTORY {"id":"c","created":"2023-12-04T10:00:00+08:00","mediaType":"photo","originalBytes":300,"livePhoto":false,"raw":true}',
        ].join("\n"), stderr: "" };
        return { stdout: [
          'FRAMEBASE_INVENTORY_TOTAL {"count":3,"library":"SharedSync"}',
          'FRAMEBASE_INVENTORY {"id":"a","created":"2024-03-02T10:00:00+08:00","mediaType":"photo","originalBytes":100,"livePhoto":true,"raw":false}',
          'FRAMEBASE_INVENTORY {"id":"b","created":"2024-04-03T10:00:00+08:00","mediaType":"video","originalBytes":200,"livePhoto":false,"raw":false}',
        ].join("\n"), stderr: "" };
      },
    });
    const result = await provider.scanTimeline({ jobKey: "alice", appleAccount: "alice@example.com", domain: "cn", sessionDirectory: join(root, "session"), backupDirectory: join(root, "backup"), onProgress: update => progress.push(update) });
    assert.equal(result.status, "ready");
    assert.equal(result.total.itemCount, 3);
    assert.equal(result.total.originalBytes, 600);
    assert.deepEqual(result.years.map(item => [item.key, item.itemCount]), [["2024", 2], ["2023", 1]]);
    assert.deepEqual(result.quarters.map(item => item.key), ["2024-Q2", "2024-Q1", "2023-Q4"]);
    assert.deepEqual(result.months.map(item => item.key), ["2024-04", "2024-03", "2023-12"]);
    assert.equal(result.assets.length, 3);
    assert.equal(result.assets[0].library, "SharedSync");
    assert.ok(progress.some(update => update.phase === "discovering"));
    assert.ok(progress.some(update => update.phase === "reading" && update.libraryIndex === 1 && update.libraryCount === 1));
    assert.ok(progress.some(update => update.message.includes("正在反向补扫")));
    assert.ok(progress.some(update => update.phase === "completed" && update.itemCount === 3));
    const inventoryCall = calls.find(call => call.options?.env?.FRAMEBASE_INVENTORY_JSON === "1");
    assert.ok(inventoryCall.args.includes("--only-print-filenames"));
    assert.equal(inventoryCall.args.some(argument => ["--auto-delete", "--delete-after-download", "--keep-icloud-recent-days"].includes(argument)), false);
    assert.equal(calls.filter(call => call.options?.env?.FRAMEBASE_INVENTORY_JSON === "1").some(call => call.options.env.FRAMEBASE_INVENTORY_DIRECTION === "DESCENDING"), true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("provider refuses to replace a timeline when both inventory directions remain incomplete", async () => {
  const root = await mkdtemp(join(tmpdir(), "framebase-provider-incomplete-timeline-"));
  const executablePath = join(root, "icloudpd.exe");
  try {
    await writeFile(executablePath, "test");
    const provider = createIcloudPdProvider({
      executablePath,
      runCommand: async (_executable, args, options) => {
        if (args.includes("--version")) return { stdout: "version:1.32.3\n", stderr: "" };
        if (args.includes("--list-libraries")) return { stdout: "", stderr: "" };
        const id = options?.env?.FRAMEBASE_INVENTORY_DIRECTION === "DESCENDING" ? "b" : "a";
        return { stdout: [
          'FRAMEBASE_INVENTORY_TOTAL {"count":3,"library":"default"}',
          `FRAMEBASE_INVENTORY {"id":"${id}","created":"2024-03-02T10:00:00+08:00","mediaType":"photo","originalBytes":100,"livePhoto":false,"raw":false}`,
        ].join("\n"), stderr: "" };
      },
    });
    const result = await provider.scanTimeline({ jobKey: "alice", appleAccount: "alice@example.com", domain: "cn", sessionDirectory: join(root, "session"), backupDirectory: join(root, "backup") });
    assert.equal(result.status, "incomplete");
    assert.match(result.message, /2\/3/);
    assert.equal(result.assets.length, 0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("provider rejects empty command output unless the inventory explicitly confirms a zero total", async () => {
  const root = await mkdtemp(join(tmpdir(), "framebase-provider-empty-timeline-"));
  const executablePath = join(root, "icloudpd.exe");
  try {
    await writeFile(executablePath, "test");
    let confirmedEmpty = false;
    const provider = createIcloudPdProvider({
      executablePath,
      runCommand: async (_executable, args) => {
        if (args.includes("--version")) return { stdout: "version:1.32.3\n", stderr: "" };
        if (args.includes("--list-libraries")) return { stdout: "", stderr: "" };
        return { stdout: confirmedEmpty ? 'FRAMEBASE_INVENTORY_TOTAL {"count":0,"library":"default"}\n' : "", stderr: "" };
      },
    });
    const context = { jobKey: "alice", appleAccount: "alice@example.com", domain: "cn", sessionDirectory: join(root, "session"), backupDirectory: join(root, "backup") };
    const missingMarker = await provider.scanTimeline(context);
    assert.equal(missingMarker.status, "incomplete");
    assert.match(missingMarker.message, /没有返回有效的图库总数/);
    confirmedEmpty = true;
    const emptyLibrary = await provider.scanTimeline(context);
    assert.equal(emptyLibrary.status, "ready");
    assert.equal(emptyLibrary.total.itemCount, 0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("provider deletes only exact asset ids through the protected FrameBase adapter request", async () => {
  const root = await mkdtemp(join(tmpdir(), "framebase-provider-delete-"));
  const executablePath = join(root, "icloudpd.exe");
  const calls = [];
  try {
    await writeFile(executablePath, "test");
    const provider = createIcloudPdProvider({
      executablePath,
      runCommand: async (_executable, args, options) => {
        if (args.includes("--version")) return { stdout: "version:1.32.3\n", stderr: "" };
        const request = JSON.parse(await readFile(options.env.FRAMEBASE_DELETE_REQUEST, "utf8"));
        calls.push({ args, options, request });
        const asset = request.assets[0];
        return { stdout: `FRAMEBASE_DELETE ${JSON.stringify({ id: asset.id, library: asset.library, status: options.env.FRAMEBASE_DELETE_COMMIT === "1" ? "deleted" : "matched", bytes: asset.originalBytes })}\n`, stderr: "" };
      },
    });
    const asset = { id: "asset-1", library: "SharedSync", name: "IMG_0001.HEIC", created: "2024-03-02T10:00:00+08:00", mediaType: "photo", originalBytes: 4096 };
    const context = { jobKey: "alice", appleAccount: "alice@example.com", domain: "cn", sessionDirectory: join(root, "session"), backupDirectory: join(root, "backup"), assets: [asset] };
    await mkdir(context.sessionDirectory, { recursive: true });
    const preview = await provider.deleteAssets({ ...context, commit: false });
    const deleted = await provider.deleteAssets({ ...context, commit: true });
    assert.equal(preview.status, "matched");
    assert.equal(deleted.status, "deleted");
    assert.equal(deleted.bytes, 4096);
    assert.equal(calls[0].args.includes("--library"), true);
    assert.equal(calls[0].args.some(argument => ["--auto-delete", "--delete-after-download", "--keep-icloud-recent-days"].includes(argument)), false);
    assert.equal(calls[0].options.env.FRAMEBASE_DELETE_COMMIT, undefined);
    assert.equal(calls[1].options.env.FRAMEBASE_DELETE_COMMIT, "1");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("deletion emits heartbeat and confirmed cloud results while the tool is still running", async () => {
  const root = await mkdtemp(join(tmpdir(), "framebase-delete-progress-"));
  const executablePath = join(root, "icloudpd.exe");
  let finish;
  let ready;
  const opened = new Promise(resolve => { ready = resolve; });
  const progress = [];
  const line = 'FRAMEBASE_DELETE {"id":"one","library":"default","status":"deleted","bytes":100}\n';
  try {
    await writeFile(executablePath, "test");
    await mkdir(join(root, "session"));
    const provider = createIcloudPdProvider({ executablePath, progressInterval: 10, runCommand: async (_executable, args, options) => {
      if (args.includes("--version")) return { stdout: "version:1.32.3", stderr: "" };
      ready(options);
      await new Promise(resolve => { finish = resolve; });
      return { stdout: line, stderr: "" };
    } });
    const running = provider.deleteAssets({ jobKey: "alice", appleAccount: "test@example.com", domain: "cn", sessionDirectory: join(root, "session"), backupDirectory: root, commit: true, assets: [{ id: "one", library: "default", name: "one.jpg", created: "2023-12-01", originalBytes: 100 }], onProgress: value => progress.push(value) });
    const options = await opened;
    await new Promise(resolve => setTimeout(resolve, 35));
    assert.ok(progress.length >= 2, "waiting for Apple must produce heartbeat feedback");
    options.onStdout('FRAMEBASE_DELETE_PROGRESS {"scanned":100,"remaining":1,"direction":"DESCENDING"}\n');
    assert.match(progress.at(-1).message, /反向补扫.*100/);
    options.onStdout(line.slice(0, 25));
    options.onStdout(line.slice(25));
    assert.equal(progress.at(-1).deleted, 1);
    assert.match(progress.at(-1).message, /正在结束复核/);
    finish();
    const result = await running;
    assert.equal(result.count, 1, "streamed and final output must not double-count the same asset");
    assert.equal(result.status, "deleted");
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("icloudpd provider passes password and MFA only through the temporary pseudo-terminal", async () => {
  const root = await mkdtemp(join(tmpdir(), "framebase-provider-login-"));
  const executablePath = join(root, "icloudpd.exe");
  const writes = [];
  let spawnedArgs;
  let child;
  let emitData;
  let emitExit;
  try {
    await writeFile(executablePath, "test");
    const provider = createIcloudPdProvider({
      executablePath,
      runCommand: async (_executable, args) => args.includes("--version") ? { stdout: "version:1.32.3\n", stderr: "" } : { stdout: "", stderr: "" },
      spawnProcess: (_executable, args) => {
        spawnedArgs = args;
        child = {
          onData: callback => { emitData = callback; },
          onExit: callback => { emitExit = callback; },
          write: value => { writes.push(value); },
          kill: () => emitExit({ exitCode: 1 }),
        };
        return child;
      },
    });
    await provider.startAuthentication("gabri", { appleAccount: "alice@example.com", domain: "cn", sessionDirectory: join(root, "session"), backupDirectory: join(root, "backup") });
    emitData("iCloud Password for alice@example.com:");
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(provider.authenticationStatus("gabri").status, "waiting_password");
    provider.submitAuthenticationInput("gabri", "password", "secret-value");
    assert.deepEqual(writes, ["secret-value\r"]);
    assert.equal(spawnedArgs.includes("secret-value"), false);
    assert.equal(spawnedArgs.includes("--password"), false);
    emitData("Two-factor authentication is required (2fa)\nEnter the code:");
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(provider.authenticationStatus("gabri").status, "waiting_mfa");
    provider.submitAuthenticationInput("gabri", "mfa", "123456");
    assert.deepEqual(writes, ["secret-value\r", "123456\r"]);
    emitExit({ exitCode: 0 });
    assert.equal(provider.authenticationStatus("gabri").status, "connected");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});


test("preview explains missing targets and changed metadata instead of a generic failure", async () => {
  const root = await mkdtemp(join(tmpdir(), "framebase-delete-reasons-"));
  try {
    const executablePath=join(root,"icloudpd.exe");
    await writeFile(executablePath,"test"); await mkdir(join(root,"session"));
    const provider=createIcloudPdProvider({executablePath,runCommand:async (_exe,args) => args.includes("--version") ? {stdout:"version:1.32.3"} : {stdout:'FRAMEBASE_DELETE {"id":"one","library":"default","status":"mismatch","fields":["originalBytes"]}\nFRAMEBASE_DELETE_DONE {"total":2,"processed":1}\n'}});
    const result=await provider.deleteAssets({jobKey:"alice",sessionDirectory:join(root,"session"),assets:["one","two"].map(id=>({id,library:"default",name:id+".jpg",created:"2023-12-01",originalBytes:100})),commit:false});
    assert.equal(result.status,"partial");
    assert.match(result.message,/未找到/); assert.match(result.message,/元数据不一致.*originalBytes/);
  } finally {await rm(root,{recursive:true,force:true});}
});


test("session verification requires photo access after successful account authentication", async () => {
  const root=await mkdtemp(join(tmpdir(),"framebase-photo-session-"));
  try {
    const executablePath=join(root,"icloudpd.exe");await writeFile(executablePath,"test");
    const provider=createIcloudPdProvider({executablePath,runCommand:async(_exe,args)=>{
      if(args.includes("--version"))return {stdout:"version:1.32.3"};
      if(args.includes("--auth-only"))return {stdout:""};
      assert.ok(args.includes("--only-print-filenames"));
      assert.equal(args.some(value=>["--auto-delete","--delete-after-download","--keep-icloud-recent-days"].includes(value)),false);
      throw Object.assign(new Error("failed"),{stderr:"None of providers gave password"});
    }});
    const result=await provider.verifyExistingSession({appleAccount:"test@example.com",domain:"cn",sessionDirectory:join(root,"session"),backupDirectory:root});
    assert.equal(result.status,"needs_auth");
  }finally {await rm(root,{recursive:true,force:true});}
});

test("tool exceptions mentioning password functions are not reported as expired sessions", async () => {
  const root=await mkdtemp(join(tmpdir(),"framebase-tool-errors-"));
  try {
    const executablePath=join(root,"icloudpd.exe");await writeFile(executablePath,"test");
    const provider=createIcloudPdProvider({executablePath,runCommand:async(_exe,args)=>{
      if(args.includes("--version"))return {stdout:"version:1.32.3"};
      throw Object.assign(new Error("failed"),{stderr:'Traceback: authentication.py password_provider\nTypeError: invalid metadata'});
    }});
    const result=await provider.verifyExistingSession({appleAccount:"test@example.com",domain:"cn",sessionDirectory:join(root,"session"),backupDirectory:root});
    assert.equal(result.status,"tool_error");assert.match(result.message,/TypeError/);
    assert.equal(result.message.includes("password_provider"),false);
  }finally {await rm(root,{recursive:true,force:true});}
});


test("runtime session verification and deletion reuse the same user's in-memory credential and cookie directory", async () => {
  const root=await mkdtemp(join(tmpdir(),"framebase-shared-session-"));
  try {
    const executablePath=join(root,"icloudpd.exe");await writeFile(executablePath,"test");
    const calls=[];const writes=[];let loginData;let loginExit;
    const provider=createIcloudPdProvider({executablePath,runCommand:async()=>({stdout:"version:1.32.3"}),spawnProcess:(_exe,args,options)=>{
      const first=calls.length===0;calls.push({args,options});let data;let exit;
      const child={onData:callback=>{data=callback;if(first)loginData=callback;},onExit:callback=>{exit=callback;if(first)loginExit=callback;},write:value=>writes.push(value),kill:()=>{}};
      if(!first)queueMicrotask(()=>{data("iCloud Password for test@example.com:");if(options?.env?.FRAMEBASE_DELETE_REQUEST)data('FRAMEBASE_DELETE {"id":"one","library":"default","status":"matched","bytes":100}\n');exit({exitCode:0});});
      return child;
    }});
    const context={appleAccount:"test@example.com",domain:"cn",sessionDirectory:join(root,"session"),backupDirectory:root};
    await provider.startAuthentication("alice",context);loginData("iCloud Password for test@example.com:");provider.submitAuthenticationInput("alice","password","runtime-secret");loginExit({exitCode:0});
    assert.equal((await provider.verifyRuntimeSession("alice",context)).status,"connected");
    assert.equal((await provider.deleteAssets({...context,jobKey:"alice",assets:[{id:"one",library:"default",name:"one.jpg",created:"2023-12-01",originalBytes:100}],commit:false})).status,"matched");
    assert.equal(calls.length,4);
    for(const call of calls){assert.equal(call.args[call.args.indexOf("--cookie-directory")+1],context.sessionDirectory);assert.equal(call.args.includes("runtime-secret"),false);}
    assert.equal(writes.length,4);
    assert.equal(provider.hasRuntimeCredential("bob"),false);
  }finally {await rm(root,{recursive:true,force:true});}
});


test("empty successful process output cannot imply missing cloud assets", async () => {
 const root=await mkdtemp(join(tmpdir(),"framebase-incomplete-delete-"));
 try {
  const executablePath=join(root,"icloudpd.exe");await writeFile(executablePath,"test");await mkdir(join(root,"session"));
  const provider=createIcloudPdProvider({executablePath,runCommand:async (_exe,args)=>({stdout:args.includes("--version")?"version:1.32.3":""})});
  const result=await provider.deleteAssets({jobKey:"alice",sessionDirectory:join(root,"session"),assets:[{id:"one",library:"default",name:"one.jpg",created:"2023-12-01",originalBytes:100}],commit:false});
  assert.equal(result.status,"incomplete");assert.equal(result.results.length,0);assert.doesNotMatch(result.message,/未找到/);
 }finally{await rm(root,{recursive:true,force:true});}
});

test("machine network diagnostics survive disabled tool logging without exposing output", async () => {
 const root=await mkdtemp(join(tmpdir(),"framebase-safe-network-"));
 try {
  const executablePath=join(root,"icloudpd.exe");await writeFile(executablePath,"test");
  const provider=createIcloudPdProvider({executablePath,runCommand:async(_exe,args)=>{
   if(args.includes("--version"))return {stdout:"version:1.32.3"};
   throw Object.assign(new Error("exit 1"),{stdout:'FRAMEBASE_ERROR {"status":"network_error","reason":"PyiCloudConnectionErrorException"}\nFRAMEBASE_ERROR {"status":"error","reason":"cli_failed"}\n'});
  }});
  const result=await provider.verifyExistingSession({appleAccount:"test@example.com",domain:"cn",sessionDirectory:join(root,"session"),backupDirectory:root});
  assert.equal(result.status,"network_error");assert.match(result.message,/网络或代理/);assert.doesNotMatch(result.message,/cli_failed|test@example/);
 }finally{await rm(root,{recursive:true,force:true});}
});


test("Apple indexing errors preserve the plan and do not imply missing photos", async () => {
 const root=await mkdtemp(join(tmpdir(),"framebase-indexing-"));
 try {
  const executablePath=join(root,"icloudpd.exe");await writeFile(executablePath,"test");
  const provider=createIcloudPdProvider({executablePath,runCommand:async(_exe,args)=>{
   if(args.includes("--version"))return {stdout:"version:1.32.3"};
   throw Object.assign(new Error("exit 1"),{stdout:'FRAMEBASE_ERROR {"status":"photos_error","reason":"photos_indexing"}\n'});
  }});
  const result=await provider.verifyExistingSession({appleAccount:"test@example.com",domain:"cn",sessionDirectory:join(root,"session"),backupDirectory:root});
  assert.equal(result.status,"indexing");assert.match(result.message,/无需因此重新生成/);assert.doesNotMatch(result.message,/未找到|失效/);
 }finally{await rm(root,{recursive:true,force:true});}
});
