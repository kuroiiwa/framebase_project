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
  assert.match(page, /← 返回视频库/);
  assert.match(lanPage, /← 返回视频库/);
  assert.match(server, /requirePc\(request, response\)/);
  assert.match(server, /icloud\.configureBackupDirectory\(current\.username/);
  assert.match(server, /ShowDialog\(\$owner\)/);
});
