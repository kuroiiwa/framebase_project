import assert from "node:assert/strict";
import test from "node:test";
import { createReleaseDeleteJobs } from "../server/framebase-release-jobs.mjs";

function automaticFixture(count, override) {
  const assets = Array.from({ length: count }, (_, id) => ({ id: String(id), library: "main", name: `${id}.jpg` }));
  const calls = [];
  const records = [];
  const jobs = createReleaseDeleteJobs({
    icloud: { connectionContext: async () => ({}), recordReleasedAssets: async (_user, batch, result) => { records.push({ batch, result }); return {}; }, readTimeline: async () => ({}) },
    provider: { deleteAssets: async options => {
      calls.push(options);
      const custom = await override?.(options, calls.length, jobs);
      return custom || { status: options.commit ? "deleted" : "matched", message: "done", results: options.assets.map(asset => ({ ...asset, status: options.commit ? "deleted" : "matched" })) };
    } }, recycleBin: { recycle: () => assert.fail("automatic release must retain local files") },
  });
  return { assets, calls, records, jobs, run: async () => { const started = jobs.start("alice", { assets, recycleLocal: false, autoBatches: true }); return jobs.wait("alice", started.id); } };
}

test("automatic release serially reviews and deletes batches of 100 and saves each result", async () => {
  const f = automaticFixture(205);
  const done = await f.run();
  assert.equal(done.status, "completed"); assert.equal(done.deleted, 205); assert.equal(done.total, 205);
  assert.deepEqual(f.calls.map(call => [call.commit, call.assets.length]), [[false, 100], [true, 100], [false, 100], [true, 100], [false, 5], [true, 5]]);
  assert.equal(f.records.length, 3); assert.equal(done.result.releaseResult.results.length, 205);
});

for (const status of ["indexing", "partial", "matched"]) test(`automatic release stops before committing an incomplete ${status} review`, async () => {
  const f = automaticFixture(205, (options, number) => number === 3 ? { status, message: "review unavailable", results: options.assets.slice(0, 99).map(asset => ({ ...asset, status: "matched" })) } : null);
  const done = await f.run();
  assert.equal(done.status, "partial"); assert.equal(done.deleted, 100);
  assert.equal(f.calls.length, 3); assert.equal(f.records.length, 1);
  assert.match(done.message, /本批未提交删除/);
});

test("automatic release stops after partial deletion and records only confirmed requested results", async () => {
  const f = automaticFixture(205, (options, number) => number === 2 ? { status: "partial", message: "partial", results: [{ ...options.assets[0], status: "deleted" }, { ...options.assets[0], status: "deleted" }, { id: "foreign", library: "main", status: "deleted" }] } : null);
  const done = await f.run();
  assert.equal(done.deleted, 1); assert.equal(done.status, "partial"); assert.equal(f.calls.length, 2);
  assert.equal(f.records[0].result.results.length, 1);
});

test("requesting stop during review never submits that batch", async () => {
  const f = automaticFixture(205, (_options, number, jobs) => { if (number === 1) jobs.stop("alice", jobs.read("alice").id); });
  const done = await f.run();
  assert.equal(done.deleted, 0); assert.equal(f.calls.length, 1); assert.equal(f.records.length, 0);
});

test("requesting stop during deletion saves the current batch and prevents later batches", async () => {
  const f = automaticFixture(205, (_options, number, jobs) => { if (number === 2) jobs.stop("alice", jobs.read("alice").id); });
  const done = await f.run();
  assert.equal(done.deleted, 100); assert.equal(f.calls.length, 2); assert.equal(f.records.length, 1);
});

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
    provider: { deleteAssets: async options => { assert.equal(options.commit,false); options.onProgress({processed:1,total:1}); return {status:"matched",message:"复核通过",results:[{id:"one",library:"default",status:"matched"}]}; } },
    recycleBin: { recycle: () => assert.fail("preview cannot recycle") },
  });
  const started=jobs.start("alice",{assets:[{id:"one",library:"default",name:"one.jpg"}],recycleLocal:true,preview:true});
  const done=await jobs.wait("alice",started.id);
  assert.equal(done.preview,true);
  assert.equal(done.status,"completed");
  assert.equal(done.deleted,0);
  assert.equal(done.result.localRecyclePlan.fileCount,2);
  assert.match(done.message,/尚未执行删除/);
});

for (const verified of [true, false]) {
  test(`incomplete preview reports ${verified ? 'partial' : 'failed'} without side effects`, async () => {
    const jobs = createReleaseDeleteJobs({
      icloud: { connectionContext: async () => ({}), recordReleasedAssets: () => assert.fail('preview cannot record deletion') },
      provider: { deleteAssets: async options => {
        assert.equal(options.commit, false);
        return { status: 'incomplete', message: 'Incomplete cloud results', results: [
          { id: 'one', library: 'main', status: verified ? 'matched' : 'mismatch' },
          { id: 'foreign', library: 'main', status: 'matched' },
        ] };
      } },
      recycleBin: { recycle: () => assert.fail('preview cannot recycle') },
    });
    const started = jobs.start('alice', { assets: [{ id: 'one', library: 'main', name: 'one.mov' }, { id: 'two', library: 'main', name: 'two.mov' }], recycleLocal: false, preview: true });
    const done = await jobs.wait('alice', started.id);
    assert.equal(done.status, verified ? 'partial' : 'failed');
    assert.equal(done.deleted, 0);
    assert.equal(done.result.releaseResult.status, 'incomplete');
  });
}
