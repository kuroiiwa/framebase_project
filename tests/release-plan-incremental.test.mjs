import assert from "node:assert/strict";
import test from "node:test";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, stat, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createIcloudManager } from "../server/framebase-icloud.mjs";

async function fixture(t) {
  const projectRoot = await mkdtemp(join(tmpdir(), "framebase-release-cache-"));
  t.after(() => rm(projectRoot, { recursive: true, force: true }));
  const hashed = [];
  const hashFile = async (path, onChunk) => {
    hashed.push(path);
    const bytes = await readFile(path); onChunk?.(bytes.length);
    return createHash("sha256").update(bytes).digest("hex");
  };
  const manager = createIcloudManager({ projectRoot, hashFile });
  await mkdir(join(projectRoot, "backup"));
  const config = await manager.configureBackupDirectory("alice", join(projectRoot, "backup"));
  const files = []; const assets = [];
  async function add(name, content) {
    const relativePath = `2024/01/${name}`;
    const path = join(config.backupDirectory, relativePath);
    await mkdir(join(config.backupDirectory, "2024", "01"), { recursive: true });
    await writeFile(path, content);
    const extension = name.split(".").pop().toLowerCase();
    const file = { name, relativePath, extension, mediaType: extension === "mov" ? "video" : "photo", size: Buffer.byteLength(content), sha256: createHash("sha256").update(content).digest("hex") };
    files.push(file);
    assets.push({ id: name, library: "default", name, created: "2024-01-15T12:00:00+08:00", mediaType: "photo", mainBytes: file.size, originalBytes: file.size });
    await manager.writeFullManifest("alice", [file]);
    await manager.recordTimeline("alice", { assets });
    return { file, path };
  }
  return { projectRoot, hashFile, manager, hashed, add, assets };
}

test("release plans persist and reuse successful checks after a server restart", async t => {
  const f = await fixture(t); await f.add("one.jpg", "original");
  assert.equal((await f.manager.createReleasePlan("alice")).status, "ready");
  assert.equal(f.hashed.length, 1);
  const restarted = createIcloudManager({ projectRoot: f.projectRoot, hashFile: f.hashFile });
  const next = await restarted.createReleasePlan("alice");
  assert.equal(next.status, "ready");
  assert.equal(next.assets.length, 1);
  assert.equal(f.hashed.length, 1);
  assert.equal(restarted.readReleaseProgress("alice").reused, 1);
  assert.equal(restarted.readReleaseProgress("alice").readBytes, 0);
});

for (const videoName of ["IMG_4676_HEVC.MOV", "IMG_4676.MOV"]) {
  test(`release plan includes verified image and Live Photo companion (${videoName})`, async t => {
    const f = await fixture(t);
    const image = await f.add("IMG_4676.HEIC", "photo-original");
    const video = await f.add(videoName, "live-video-original");
    await f.manager.recordTimeline("alice", { assets: [{ ...f.assets[0], livePhoto: true, livePhotoBytes: video.file.size, originalBytes: image.file.size + video.file.size }] });
    const plan = await f.manager.createReleasePlan("alice");
    assert.equal(plan.assets.length, 1);
    assert.deepEqual(plan.assets[0].localFiles, [image.file.relativePath, video.file.relativePath]);
    await f.manager.confirmReleasePlan("alice", plan.id, true);
    const recycle = await f.manager.prepareLocalRecycle("alice", plan.assets);
    assert.equal(recycle.fileCount, 2);
    assert.equal(recycle.bytes, image.file.size + video.file.size);
  });
}

test("wrong-size or ambiguous Live Photo companions do not authorize cloud release", async t => {
  const f = await fixture(t);
  await f.add("IMG_4676.HEIC", "photo-original");
  const video = await f.add("IMG_4676_HEVC.MOV", "live-video-original");
  const asset = { ...f.assets[0], livePhoto: true, livePhotoBytes: video.file.size + 1, originalBytes: f.assets[0].mainBytes + video.file.size + 1 };
  await f.manager.recordTimeline("alice", { assets: [asset] });
  assert.equal((await f.manager.createReleasePlan("alice")).assets.length, 0);
  await f.add("IMG_4676.MOV", "live-video-original");
  await f.manager.recordTimeline("alice", { assets: [{ ...asset, livePhotoBytes: video.file.size, originalBytes: f.assets[0].mainBytes + video.file.size }] });
  assert.equal((await f.manager.createReleasePlan("alice")).assets.length, 0);
});

test("same-name Live Photo video in another directory cannot be paired", async t => {
  const f = await fixture(t);
  await f.add("IMG_4676.HEIC", "photo-original");
  const video = await f.add("IMG_4676_HEVC.MOV", "live-video-original");
  const relativePath = "2024/01/other/IMG_4676_HEVC.MOV";
  const otherPath = join(dirname(video.path), "other", video.file.name);
  await mkdir(dirname(otherPath), { recursive: true });
  await writeFile(otherPath, "live-video-original");
  await f.manager.writeFullManifest("alice", [{ ...video.file, relativePath }]);
  await rm(video.path);
  // Remove the original path from the manifest as a real rescan would do.
  const manifestPath = join(f.projectRoot, ".framebase-icloud", "alice", "full-manifest.json");
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  manifest.files = manifest.files.filter(file => file.relativePath !== video.file.relativePath);
  await writeFile(manifestPath, JSON.stringify(manifest));
  await f.manager.recordTimeline("alice", { assets: [{ ...f.assets[0], livePhoto: true, livePhotoBytes: video.file.size, originalBytes: f.assets[0].mainBytes + video.file.size }] });
  const plan = await f.manager.createReleasePlan("alice");
  assert.equal(plan.status, "ready"); assert.equal(plan.assets.length, 0);
});

test("new files hash once while unchanged files skip; cloud matching still refreshes", async t => {
  const f = await fixture(t); await f.add("one.jpg", "original");
  await f.manager.createReleasePlan("alice");
  await f.add("two.jpg", "another");
  const updated = await f.manager.createReleasePlan("alice");
  assert.equal(updated.assets.length, 2);
  assert.equal(f.hashed.length, 2);
  assert.equal(f.manager.readReleaseProgress("alice").reused, 1);
  await f.manager.recordTimeline("alice", { assets: [f.assets[1]] });
  const refreshed = await f.manager.createReleasePlan("alice");
  assert.deepEqual(refreshed.assets.map(asset => asset.id), ["two.jpg"]);
  assert.equal(f.hashed.length, 2);
});

test("same size edits with restored modification time cannot reuse cached verification", async t => {
  const f = await fixture(t); const { path } = await f.add("one.jpg", "original");
  await f.manager.createReleasePlan("alice");
  const before = await stat(path);
  await writeFile(path, "tampered");
  await utimes(path, before.atime, before.mtime);
  const blocked = await f.manager.createReleasePlan("alice");
  assert.equal(blocked.status, "blocked");
  assert.equal(blocked.failedCount, 1);
  assert.equal(f.hashed.length, 2);
  assert.equal(f.manager.readReleaseProgress("alice").reused, 0);
  await f.manager.createReleasePlan("alice");
  assert.equal(f.hashed.length, 3); // Failed checks are never cached as successes.
});

test("manifest hash changes and missing files invalidate the cached check", async t => {
  const f = await fixture(t); const { file, path } = await f.add("one.jpg", "original");
  await f.manager.createReleasePlan("alice");
  await f.manager.writeFullManifest("alice", [{ ...file, sha256: "a".repeat(64) }]);
  assert.equal((await f.manager.createReleasePlan("alice")).status, "blocked");
  assert.equal(f.hashed.length, 2);
  await rm(path);
  assert.equal((await f.manager.createReleasePlan("alice")).status, "blocked");
  assert.equal(f.manager.readReleaseProgress("alice").reused, 0);
});

test("a malformed optional cache falls back to a complete hash check", async t => {
  const f = await fixture(t); await f.add("one.jpg", "original");
  await f.manager.createReleasePlan("alice");
  await writeFile(join(f.projectRoot, ".framebase-icloud", "alice", "release-verification-cache.json"), "invalid JSON");
  assert.equal((await f.manager.createReleasePlan("alice")).status, "ready");
  assert.equal(f.hashed.length, 2);
});

test("changing the backup root requires a fresh verification", async t => {
  const f = await fixture(t); const { file } = await f.add("one.jpg", "original");
  await f.manager.createReleasePlan("alice");
  const otherRoot = join(f.projectRoot, "other-backup"); await mkdir(otherRoot);
  const config = await f.manager.configureBackupDirectory("alice", otherRoot);
  await mkdir(join(config.backupDirectory, "2024", "01"), { recursive: true });
  await writeFile(join(config.backupDirectory, file.relativePath), "original");
  assert.equal((await f.manager.createReleasePlan("alice")).status, "ready");
  assert.equal(f.hashed.length, 2);
  assert.equal(f.manager.readReleaseProgress("alice").reused, 0);
});

test("a file changing during hashing cannot become a cached success", async t => {
  const f = await fixture(t); await f.add("one.jpg", "original");
  const manager = createIcloudManager({ projectRoot: f.projectRoot, hashFile: async (path, onChunk) => {
    const sha = await f.hashFile(path, onChunk);
    await writeFile(path, "tampered");
    return sha;
  } });
  assert.equal((await manager.createReleasePlan("alice")).status, "blocked");
  assert.equal(manager.readReleaseProgress("alice").failed, 1);
  const cached = JSON.parse(await readFile(join(f.projectRoot, ".framebase-icloud", "alice", "release-verification-cache.json"), "utf8"));
  assert.deepEqual(cached.files, {});
});
