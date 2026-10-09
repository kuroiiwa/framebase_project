import assert from "node:assert/strict";
import test from "node:test";
import { createReleaseDeleteJobs } from "../server/framebase-release-jobs.mjs";

test("an exactly confirmed recently deleted cloud asset permits local recycling", async () => {
  const asset = { id: "trash", library: "PrimarySync", name: "IMG_0050.JPG", localFiles: ["IMG_0050.JPG"] };
  let recycled;
  const jobs = createReleaseDeleteJobs({
    icloud: { connectionContext: async () => ({}), prepareLocalRecycle: async () => ({ files: [{ relativePath: "IMG_0050.JPG" }] }), recordReleasedAssets: async () => ({}), readTimeline: async () => ({}) },
    provider: { deleteAssets: async () => ({ status: "deleted", message: "云端已在最近删除中", results: [{ id: asset.id, library: asset.library, status: "deleted", alreadyDeleted: true, bytes: 0 }] }) },
    recycleBin: { recycle: async files => { recycled = files; return { status: "recycled", message: "本地已回收" }; } },
  });
  const started = jobs.start("alice", { assets: [asset], recycleLocal: true });
  const done = await jobs.wait("alice", started.id);
  assert.equal(done.status, "completed");
  assert.deepEqual(recycled, [{ relativePath: "IMG_0050.JPG" }]);
});

test("confirmed deletion reports live progress before completion and makes only one guarded commit", async () => {
  let resolveCloud;
  let onProgress;
  let ready;
  const opened = new Promise(resolve => { ready = resolve; });
  const calls = [];
  const jobs = createReleaseDeleteJobs({
    icloud: { connectionContext: async () => ({}), recordReleasedAssets: async (_user, _assets, result) => { calls.push(result); return {}; }, readTimeline: async () => ({}) },
    provider: { deleteAssets: options => { assert.equal(options.commit, true); onProgress = options.onProgress; ready(); return new Promise(resolve => { resolveCloud = resolve; }); } },
    recycleBin: { recycle: () => assert.fail("cloud-only deletion must preserve local originals") },
  });
  const assets = [{ id: "one", library: "default", name: "one.jpg" }];
  const started = jobs.start("alice", { assets, recycleLocal: false });
  assert.equal(started.status, "running");
  assert.equal(jobs.read("bob").status, "idle");
  assert.throws(() => jobs.start("alice", { assets, recycleLocal: false }), { status: 409 });
  await opened;
  onProgress({ phase: "deleting", message: "Apple 已返回目标结果，工具仍在扫描", processed: 1, deleted: 1, total: 1 });
  assert.equal(jobs.read("alice").status, "running");
  assert.equal(jobs.read("alice").deleted, 1);
  resolveCloud({ status: "deleted", message: "已移入最近删除", results: [{ id: "one", library: "default", status: "deleted" }] });
  const completed = await jobs.wait("alice", started.id);
  assert.equal(completed.status, "completed");
  assert.equal(calls.length, 1);
  assert.equal(completed.result.releaseResult.status, "deleted");
  assert.match(completed.message, /本地原片已保留/);
});

test("cloud failure skips local recycling and reports failure without claiming success", async () => {
  const jobs = createReleaseDeleteJobs({
    icloud: { connectionContext: async () => ({}), prepareLocalRecycle: async () => ({ files: [] }), recordReleasedAssets: async () => ({}), readTimeline: async () => ({}) },
    provider: { deleteAssets: async () => ({ status: "network_error", message: "暂时无法连接 Apple", results: [] }) },
    recycleBin: { recycle: () => assert.fail("local files must survive failed cloud deletion") },
  });
  const started = jobs.start("alice", { assets: [{ name: "one.jpg" }], recycleLocal: true });
  const failed = await jobs.wait("alice", started.id);
  assert.equal(failed.status, "failed");
  assert.equal(failed.deleted, 0);
  assert.match(failed.message, /本地原片未回收/);
});


test("partial bulk cloud deletion recycles only the successful project's originals", async () => {
  const assets = [{id:"one",library:"default",name:"one.jpg",localFiles:["one.jpg"]}, {id:"two",library:"default",name:"two.jpg",localFiles:["two.jpg"]}];
  let recycled;
  const jobs = createReleaseDeleteJobs({
    icloud: { connectionContext: async () => ({}), prepareLocalRecycle: async () => ({files: assets.map(asset => ({relativePath: asset.name}))}), recordReleasedAssets: async () => ({}), readTimeline: async () => ({}) },
    provider: { deleteAssets: async () => ({status:"partial",message:"部分完成", results: [{id:"one",library:"default",status:"deleted"},{id:"two",library:"default",status:"failed"}]}) },
    recycleBin: { recycle: async files => { recycled=files; return {status:"recycled",message:"已回收"}; } },
  });
  const started=jobs.start("alice",{assets,recycleLocal:true});
  const done=await jobs.wait("alice",started.id);
  assert.equal(done.status,"partial");
  assert.equal(done.deleted,1);
  assert.deepEqual(recycled,[{relativePath:"one.jpg"}]);
});


test("background preview exposes progress and never deletes, recycles, or records a release", async () => {
  const jobs = createReleaseDeleteJobs({
    icloud: { connectionContext: async () => ({}), prepareLocalRecycle: async () => ({files:[],fileCount:2,bytes:42}), recordReleasedAssets: () => assert.fail("preview cannot record a deletion") },
    provider: { deleteAssets: async options => { assert.equal(options.commit,false); options.onProgress({processed:1,total:1}); return {status:"matched",message:"复核通过",results:[{status:"matched"}]}; } },
    recycleBin: { recycle: () => assert.fail("preview cannot recycle") },
  });
  const started=jobs.start("alice",{assets:[{name:"one.jpg"}],recycleLocal:true,preview:true});
  const done=await jobs.wait("alice",started.id);
  assert.equal(done.preview,true);
  assert.equal(done.status,"completed");
  assert.equal(done.deleted,0);
  assert.equal(done.result.localRecyclePlan.fileCount,2);
  assert.match(done.message,/尚未执行删除/);
});
