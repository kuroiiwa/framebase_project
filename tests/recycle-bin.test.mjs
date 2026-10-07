import assert from "node:assert/strict";
import test from "node:test";
import { createRecycleBin } from "../server/framebase-recycle-bin.mjs";

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
