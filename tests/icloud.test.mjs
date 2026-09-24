import assert from "node:assert/strict";
import { mkdtemp, readFile, realpath, rm } from "node:fs/promises";
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

test("iCloud backup center remains a separate authenticated route", async () => {
  const [page, lanPage, server] = await Promise.all([
    readFile(new URL("../app/icloud/page.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/lan/page.tsx", import.meta.url), "utf8"),
    readFile(new URL("../server/framebase-lan-server.mjs", import.meta.url), "utf8"),
  ]);
  assert.match(page, /iCloud 备份中心/);
  assert.match(page, /<AccountGate>/);
  assert.match(page, /\/api\/icloud\/pick-folder/);
  assert.match(page, /\/api\/icloud\/connection/);
  assert.match(page, /验证已有会话/);
  assert.match(page, /开始 Apple 登录/);
  assert.match(page, /扫描最近 10 个项目/);
  assert.match(page, /安全备份最近 3 个/);
  assert.match(page, /完整增量备份/);
  assert.match(page, /开始完整备份/);
  assert.match(page, /视频库与独立图片库按格式隔离管理/);
  assert.match(page, /← 返回视频库/);
  assert.match(lanPage, /← 返回视频库/);
  assert.match(server, /requirePc\(request, response\)/);
  assert.match(server, /icloud\.configureBackupDirectory\(current\.username/);
  assert.match(server, /icloudProvider\.verifyRuntimeSession/);
  assert.match(server, /icloudProvider\.startAuthentication/);
  assert.match(server, /icloudProvider\.scanRecent/);
  assert.match(server, /icloudProvider\.backupRecent/);
  assert.match(server, /\/api\/icloud\/backup\/test/);
  assert.match(server, /icloudProvider\.backupAll/);
  assert.match(server, /\/api\/icloud\/backup\/full\/pause/);
  assert.match(server, /ShowDialog\(\$owner\)/);
});
