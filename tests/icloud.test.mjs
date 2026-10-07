import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createIcloudManager } from "../server/framebase-icloud.mjs";

test("iCloud backup configuration stays isolated by FrameBase user", async () => {
  const projectRoot = await mkdtemp(join(tmpdir(), "framebase-icloud-project-"));
  const selectedRoot = await mkdtemp(join(tmpdir(), "framebase-icloud-backup-"));
  try {
    const manager = createIcloudManager({ projectRoot });
    const gabri = await manager.configureBackupDirectory("gabri", selectedRoot);
    const alice = await manager.configureBackupDirectory("alice", selectedRoot);

    assert.equal(gabri.backupDirectory, await realpath(join(selectedRoot, "FrameBase-iCloud", "gabri")));
    assert.equal(alice.backupDirectory, await realpath(join(selectedRoot, "FrameBase-iCloud", "alice")));
    assert.equal(gabri.selectedDirectory, await realpath(selectedRoot));
    assert.equal(alice.selectedDirectory, await realpath(selectedRoot));
    assert.notEqual(gabri.backupDirectory, alice.backupDirectory);
    assert.equal((await manager.read("gabri")).backupDirectory, gabri.backupDirectory);
    assert.equal((await manager.read("alice")).backupDirectory, alice.backupDirectory);
    assert.equal((await manager.read("bob")).backupDirectory, null);

    const connectedGabri = await manager.configureConnection("gabri", { appleAccount: "GABRI@example.com", icloudDomain: "cn" });
    const connectedAlice = await manager.configureConnection("alice", { appleAccount: "alice@example.com", icloudDomain: "com" });
    assert.equal(connectedGabri.appleAccount, "gabri@example.com");
    assert.equal(connectedGabri.icloudDomain, "cn");
    assert.equal(connectedAlice.icloudDomain, "com");
    assert.notEqual((await manager.connectionContext("gabri")).sessionDirectory, (await manager.connectionContext("alice")).sessionDirectory);

    await manager.recordScan("gabri", { samples: [{ name: "IMG_0001.HEIC", extension: "heic", mediaType: "photo" }, { name: "terminal prompt", extension: "", mediaType: "photo" }] });
    await manager.recordScan("alice", { samples: [{ name: "VID_0002.MOV", extension: "mov", mediaType: "video" }] });
    assert.deepEqual((await manager.readScan("gabri")).samples.map(item => item.name), ["IMG_0001.HEIC"]);
    assert.deepEqual((await manager.readScan("alice")).samples.map(item => item.name), ["VID_0002.MOV"]);
    await manager.recordBackup("gabri", { files: [{ name: "IMG_0001.HEIC", relativePath: "2026/09/IMG_0001.HEIC", extension: "heic", mediaType: "photo", size: 2048, sha256: "a".repeat(64) }] });
    await manager.recordBackup("gabri", { files: [{ name: "IMG_0002.JPG", relativePath: "2026/09/IMG_0002.JPG", extension: "jpg", mediaType: "photo", size: 1024, sha256: "b".repeat(64) }] });
    assert.deepEqual((await manager.readBackup("gabri")).files.map(item => item.relativePath), ["2026/09/IMG_0001.HEIC", "2026/09/IMG_0002.JPG"]);
    assert.equal((await manager.readBackup("gabri")).files[0].sha256, "a".repeat(64));
    assert.equal((await manager.readBackup("gabri")).fileCount, 2);
    assert.equal((await manager.readBackup("alice")).fileCount, 0);
    assert.ok((await manager.read("gabri")).lastBackupAt);

    await manager.writeFullBackup("gabri", { status: "verifying", phase: "verifying", message: "校验中", planned: 2, verified: 1 });
    await manager.writeFullManifest("gabri", [{ name: "IMG_0001.HEIC", relativePath: "2026/09/IMG_0001.HEIC", extension: "heic", mediaType: "photo", size: 2048, sha256: "a".repeat(64), verifiedAt: new Date().toISOString() }]);
    await manager.writeFullManifest("gabri", [{ name: "VID_0001.MOV", relativePath: "2026/09/VID_0001.MOV", extension: "mov", mediaType: "video", size: 4096, sha256: "b".repeat(64), verifiedAt: new Date().toISOString() }]);
    assert.equal((await manager.readFullBackup("gabri")).status, "verifying");
    assert.equal((await manager.readFullManifest("gabri")).files.length, 2);
    assert.equal((await manager.readFullManifest("alice")).files.length, 0);
    const coverage = await manager.readBackupCoverage("gabri");
    assert.deepEqual(coverage.years.map(item => [item.key, item.verifiedCount, item.verifiedBytes]), [["2026", 2, 6144]]);
    assert.deepEqual(coverage.quarters.map(item => item.key), ["2026-Q3"]);
    assert.deepEqual(coverage.months.map(item => [item.key, item.photoCount, item.videoCount]), [["2026-09", 1, 1]]);
    assert.equal((await manager.readBackupCoverage("alice")).fileCount, 0);
    await manager.recordTimeline("gabri", { scannedAt: new Date().toISOString(), total: { key: "total", itemCount: 2, photoCount: 1, videoCount: 1, originalBytes: 6144 }, years: [{ key: "2026", itemCount: 2, photoCount: 1, videoCount: 1, originalBytes: 6144 }], quarters: [{ key: "2026-Q3", itemCount: 2, photoCount: 1, videoCount: 1, originalBytes: 6144 }], months: [{ key: "2026-09", itemCount: 2, photoCount: 1, videoCount: 1, originalBytes: 6144 }] });
    assert.equal((await manager.readTimeline("gabri")).months[0].key, "2026-09");
    assert.equal((await manager.readTimeline("alice")).years.length, 0);
    await manager.recordCompletedRanges("gabri", [{ key: "2026", label: "2026 年", start: "2026-01-01T00:00:00", end: "2026-12-31T23:59:59" }]);
    await manager.recordCompletedRanges("gabri", [{ key: "2025-Q4", label: "2025 年第 4 季度", start: "2025-10-01T00:00:00", end: "2025-12-31T23:59:59" }, { key: "2026", label: "2026 年", start: "2026-01-01T00:00:00", end: "2026-12-31T23:59:59" }]);
    assert.deepEqual((await manager.readBackupHistory("gabri")).completedRanges.map(item => item.key), ["2025-Q4", "2026"]);
    assert.equal((await manager.readBackupHistory("alice")).completedRanges.length, 0);

    const gabriFile = JSON.parse(await readFile(join(projectRoot, ".framebase-icloud", "gabri", "config.json"), "utf8"));
    const aliceFile = JSON.parse(await readFile(join(projectRoot, ".framebase-icloud", "alice", "config.json"), "utf8"));
    assert.equal(gabriFile.backupDirectory, gabri.backupDirectory);
    assert.equal(aliceFile.backupDirectory, alice.backupDirectory);
    await assert.rejects(manager.configureBackupDirectory("gabri", "relative-folder"), { status: 400 });
  } finally {
    await rm(projectRoot, { recursive: true, force: true });
    await rm(selectedRoot, { recursive: true, force: true });
  }
});

test("capacity release plan trusts a persisted manifest even when the recovered task is paused", async () => {
  const projectRoot = await mkdtemp(join(tmpdir(), "framebase-release-project-"));
  const selectedRoot = await mkdtemp(join(tmpdir(), "framebase-release-backup-"));
  try {
    const manager = createIcloudManager({ projectRoot });
    const config = await manager.configureBackupDirectory("alice", selectedRoot);
    const relativePath = "2026/09/IMG_0001.HEIC";
    const localPath = join(config.backupDirectory, "2026", "09", "IMG_0001.HEIC");
    await mkdir(join(config.backupDirectory, "2026", "09"), { recursive: true });
    await writeFile(localPath, "verified-original");
    const sha256 = createHash("sha256").update("verified-original").digest("hex");
    await manager.writeFullManifest("alice", [{ name: "IMG_0001.HEIC", relativePath, extension: "heic", mediaType: "photo", size: 17, sha256, verifiedAt: new Date().toISOString() }]);
    await manager.writeFullBackup("alice", { status: "paused", phase: "paused", message: "service restarted", manifestFileCount: 1 });
    const cloudAsset = { id: "asset-1", library: "default", name: "IMG_0001.HEIC", created: "2026-09-12T10:00:00+08:00", mediaType: "photo", extension: "heic", originalBytes: 17, mainBytes: 17, livePhotoBytes: 0, livePhoto: false, raw: false };
    await manager.recordTimeline("alice", { scannedAt: new Date().toISOString(), total: { key: "total", itemCount: 1, photoCount: 1, videoCount: 0, originalBytes: 17 }, years: [{ key: "2026", itemCount: 1, photoCount: 1, videoCount: 0, originalBytes: 17 }], quarters: [{ key: "2026-Q3", itemCount: 1, photoCount: 1, videoCount: 0, originalBytes: 17 }], months: [{ key: "2026-09", itemCount: 1, photoCount: 1, videoCount: 0, originalBytes: 17 }], assets: [cloudAsset] });
    const ready = await manager.createReleasePlan("alice");
    assert.equal(ready.status, "ready");
    assert.equal(ready.eligibleCount, 1);
    assert.equal(ready.assets.length, 1);
    await assert.rejects(manager.confirmReleasePlan("alice", ready.id, "错误文字"), { status: 400 });
    const confirmed = await manager.confirmReleasePlan("alice", ready.id, "确认本地备份完整");
    assert.equal(confirmed.status, "confirmed");
    const localRecycle = await manager.prepareLocalRecycle("alice", [cloudAsset]);
    assert.equal(localRecycle.fileCount, 1);
    assert.equal(localRecycle.bytes, 17);
    const history = await manager.recordReleasedAssets("alice", [cloudAsset], { results: [{ id: "asset-1", library: "default", status: "deleted", bytes: 17 }] }, { status: "recycled", results: [{ relativePath, size: 17, status: "recycled" }] });
    assert.equal(history.movedCount, 1);
    assert.equal(history.movedBytes, 17);
    assert.equal(history.recycledFileCount, 1);
    assert.equal(history.recycledBytes, 17);
    assert.equal((await manager.readReleasePlan("alice")).assets.length, 0);
    assert.equal((await manager.recordReleasedAssets("alice", [cloudAsset], { results: [{ id: "asset-1", library: "default", status: "deleted", bytes: 17 }] })).movedCount, 1);
    assert.ok((await manager.readTimeline("alice")).staleAt);
    assert.equal((await manager.readTimeline("alice")).total.itemCount, 0);
    assert.equal((await manager.readFullManifest("alice")).files.length, 0);
    await manager.writeFullManifest("alice", [{ name: "IMG_0001.HEIC", relativePath, extension: "heic", mediaType: "photo", size: 17, sha256, verifiedAt: new Date().toISOString() }]);
    await manager.recordTimeline("alice", { scannedAt: new Date().toISOString(), total: { key: "total", itemCount: 1, photoCount: 1, videoCount: 0, originalBytes: 17 }, years: [], quarters: [], months: [], assets: [cloudAsset] });
    await writeFile(localPath, "tampered-original");
    const blocked = await manager.createReleasePlan("alice");
    assert.equal(blocked.status, "blocked");
    assert.equal(blocked.failedCount, 1);
  } finally {
    await rm(projectRoot, { recursive: true, force: true });
    await rm(selectedRoot, { recursive: true, force: true });
  }
});

test("iCloud backup center remains a separate authenticated route", async () => {
  const [page, styles, lanPage, server] = await Promise.all([
    readFile(new URL("../app/icloud/page.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/icloud/icloud.module.css", import.meta.url), "utf8"),
    readFile(new URL("../app/lan/page.tsx", import.meta.url), "utf8"),
    readFile(new URL("../server/framebase-lan-server.mjs", import.meta.url), "utf8"),
  ]);
  assert.match(page, /iCloud 备份中心/);
  assert.match(page, /\/api\/runtime\/version/);
  assert.match(page, /后端运行版本/);
  assert.match(page, /未检测到运行版本/);
  assert.match(page, /<AccountGate>/);
  assert.match(page, /\/api\/icloud\/pick-folder/);
  assert.match(page, /\/api\/icloud\/connection/);
  assert.match(page, /验证已有会话/);
  assert.match(page, /开始 Apple 登录/);
  assert.match(page, /扫描最近 10 个项目/);
  assert.match(page, /安全备份最近 3 个/);
  assert.match(page, /完整增量备份/);
  assert.match(page, /开始完整备份/);
  assert.match(page, /按时间统计与选择/);
  assert.match(page, /每 3 个月/);
  assert.match(page, /备份所选范围/);
  assert.match(page, /备份状态/);
  assert.match(page, /部分备份/);
  assert.match(page, /mergeConfig\(current, data\)/);
  assert.match(page, /config\?\.backupHistory\?\.completedRanges/);
  assert.match(page, /实时同步速率/);
  assert.match(page, /等待 iCloud/);
  assert.match(page, /图片进度/);
  assert.match(page, /syncedPhotoCount/);
  assert.match(page, /transferRateBps/);
  assert.match(server, /readBackupCoverage/);
  assert.match(server, /runtimeStartedAt/);
  assert.match(server, /function readGitCommit\(\)/);
  assert.match(server, /readFileSync\(join\(gitDirectory, "HEAD"\)/);
  assert.match(server, /readFileSync\(join\(root, "packed-refs"\)/);
  assert.match(server, /git", \["rev-parse", "--short=8", "HEAD"\]/);
  assert.match(server, /url\.pathname === "\/api\/runtime\/version"/);
  assert.match(server, /pid: process\.pid/);
  assert.match(server, /readBackupHistory/);
  assert.match(server, /recordCompletedRanges/);
  assert.match(server, /resumingExisting \? previousState\.completedRanges/);
  assert.match(server, /onRangeComplete/);
  assert.match(page, /生成只读释放计划/);
  assert.match(page, /请先刷新上方时间统计/);
  assert.match(page, /六重核对/);
  assert.match(page, /已开放逐项安全释放/);
  assert.match(page, /视频库与独立图片库按格式隔离管理/);
  assert.match(page, /← 返回视频库/);
  assert.match(styles, /\.topbar \.backLink\{[^}]*display:inline-flex;align-items:center;justify-content:center/);
  assert.match(styles, /\.runtimeVersion\{/);
  assert.match(styles, /\.progressIndeterminate i\{/);
  assert.match(lanPage, /← 返回视频库/);
  assert.match(server, /requirePc\(request, response\)/);
  assert.match(server, /icloud\.configureBackupDirectory\(current\.username/);
  assert.match(server, /icloudProvider\.verifyRuntimeSession/);
  assert.match(server, /icloudProvider\.startAuthentication/);
  assert.match(server, /icloudProvider\.scanRecent/);
  assert.match(server, /icloudProvider\.backupRecent/);
  assert.match(server, /\/api\/icloud\/backup\/test/);
  assert.match(server, /icloudProvider\.backupAll/);
  assert.match(server, /icloudProvider\.scanTimeline/);
  assert.match(server, /\/api\/icloud\/timeline/);
  assert.match(server, /\/api\/icloud\/timeline\/status/);
  assert.match(page, /已读取项目/);
  assert.match(page, /已用时间/);
  assert.match(server, /\/api\/icloud\/backup\/full\/pause/);
  assert.match(server, /\/api\/icloud\/release\/plan/);
  assert.match(server, /icloud\.confirmReleasePlan/);
  assert.match(server, /icloudProvider\.deleteAssets/);
  assert.match(server, /icloud\.recordReleasedAssets/);
  assert.match(server, /recycleBin\.recycle/);
  assert.match(server, /icloud\.prepareLocalRecycle/);
  assert.match(server, /\/api\/icloud\/release\/recycle\/retry/);
  assert.match(server, /ShowDialog\(\$owner\)/);
});
