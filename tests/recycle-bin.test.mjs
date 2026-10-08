import assert from "node:assert/strict";
import test from "node:test";
import { createRecycleBin } from "../server/framebase-recycle-bin.mjs";
import { preparePhotoRecycle } from "../server/framebase-photo-recycle.mjs";
import { createHash } from "node:crypto";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

test("single-photo recycle verifies exact local content and rejects paths outside the selected source", async () => {
  const root = await mkdtemp(join(tmpdir(), "framebase-photo-recycle-"));
  try {
    await writeFile(join(root, "one.jpg"), "image");
    await writeFile(join(root, "one.mov"), "video");
    const image = { relativePath: "one.jpg", size: 5, sha256: createHash("sha256").update("image").digest("hex") };
    const video = { relativePath: "one.mov", size: 5, sha256: createHash("sha256").update("video").digest("hex") };
    assert.equal((await preparePhotoRecycle(root, [image])).fileCount, 1);
    assert.equal((await preparePhotoRecycle(root, [image, video])).bytes, 10);
    await assert.rejects(preparePhotoRecycle(root, [{ ...image, relativePath: "../one.jpg" }]), /路径超出/);
    await assert.rejects(preparePhotoRecycle(root, [{ ...image, relativePath: join(root, "..", "one.jpg") }]), /路径超出/);
    await assert.rejects(preparePhotoRecycle(root, [image, { ...video, relativePath: "other.mov" }]), /不匹配/);
    await assert.rejects(preparePhotoRecycle(root, [{ ...image, relativePath: "script.exe" }]), /仅允许删除图片/);
    await writeFile(join(root, "one.jpg"), "other");
    await assert.rejects(preparePhotoRecycle(root, [image]), /文件与当前图片不一致/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Windows recycle adapter passes exact paths through the child environment", async () => {
  const calls = [];
  const recycleBin = createRecycleBin({
    platform: "win32",
    runCommand: async (executable, args, options) => { calls.push({ executable, args, options }); return { stdout: "", stderr: "" }; },
  });
  const result = await recycleBin.recycle([{ path: "D:\\backup\\IMG_0001.HEIC", relativePath: "2026/09/IMG_0001.HEIC", size: 4096 }]);
  assert.equal(result.status, "recycled");
  assert.equal(result.bytes, 4096);
  assert.equal(calls[0].executable, "powershell.exe");
  assert.equal(calls[0].args.includes("D:\\backup\\IMG_0001.HEIC"), false);
  assert.equal(calls[0].options.env.FRAMEBASE_RECYCLE_PATH, "D:\\backup\\IMG_0001.HEIC");
});

test("recycle adapter reports partial failures without deleting remaining files", async () => {
  let call = 0;
  const recycleBin = createRecycleBin({ platform: "win32", runCommand: async () => { call += 1; if (call === 2) throw new Error("locked"); return { stdout: "", stderr: "" }; } });
  const result = await recycleBin.recycle([
    { path: "D:\\backup\\one.jpg", relativePath: "one.jpg", size: 10 },
    { path: "D:\\backup\\two.jpg", relativePath: "two.jpg", size: 20 },
  ]);
  assert.equal(result.status, "partial");
  assert.equal(result.fileCount, 1);
  assert.deepEqual(result.results.map(item => item.status), ["recycled", "failed"]);
});
