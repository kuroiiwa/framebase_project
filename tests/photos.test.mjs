import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { findPhotoCloudAsset } from "../app/photos/cloud-match.ts";
import { nextCloudReleaseBatch, collectCloudSelection } from "../app/photos/bulk-selection.ts";
import vm from "node:vm";
import ts from "typescript";

for (const [file, functionName] of [["photos/page.tsx", "releaseAllFilteredCloudPhotos"], ["page.tsx", "releaseAllFilteredCloudVideos"]]) {
  for (const confirmed of [true, false]) test(`${functionName} ${confirmed ? 'submits every filtered matched asset once' : 'cancels without submitting'}`, async () => {
    const source = await readFile(new URL(`../app/${file}`, import.meta.url), "utf8");
    const ast = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
    let workflow;
    function find(node) {
      if (ts.isFunctionDeclaration(node) && node.name?.text === functionName) workflow = node.getText(ast);
      ts.forEachChild(node, find);
    }
    find(ast); assert.ok(workflow);
    const assets = Array.from({ length: 205 }, (_, id) => ({ id: String(id), library: "main" }));
    const calls = []; const prompts = []; let job;
    const catalog = { releasePlan: { id: "plan", assets } };
    const run = vm.runInNewContext(`${ts.transpileModule(workflow, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText}\n${functionName}`, {
      releasingAsset: null, appleSessionBusy: false, releaseCatalogLoading: false, releaseCatalogError: "", dialogItems: [],
      filtered: [...assets, { id: "unmatched" }], cloudAssetFor: item => item.library ? item : null, collectCloudSelection, releaseCatalog: catalog,
      window: { confirm: message => { prompts.push(message); return confirmed; } },
      requestCloudConfirmation: async prompt => { prompts.push(prompt.message); return confirmed ? "confirm" : "cancel"; },
      setReleasingAsset() {}, setError() {}, setNotice() {}, setDeleteJob: value => { job = value; }, setVideoDeleteJob: value => { job = value; },
      setReleaseCatalog: update => { if (typeof update === "function") catalog.releasePlan = update(catalog).releasePlan; },
      setSelected: update => update(new Set()), setSelectedIds: update => update([]), refreshReleaseCatalog: async () => {},
      deletePollAbort: { current: null }, videoDeleteAbort: { current: null },
      fetch: async (url, options) => {
        if (options?.method === "POST") { calls.push(JSON.parse(options.body)); return { ok: true, json: async () => ({ deleteJob: { id: "job", status: "running" } }) }; }
        return { ok: true, json: async () => catalog };
      },
      waitForCloudDelete: async (_id, progress) => { const completed = { status: "completed", result: { releaseResult: { results: assets.map(asset => ({ ...asset, status: "deleted" })) } } }; progress(completed); return completed; },
    });
    await run();
    assert.equal(prompts.length, 1); assert.match(prompts[0], /205/); assert.match(prompts[0], /本地/);
    assert.equal(calls.length, confirmed ? 1 : 0);
    if (confirmed) {
      assert.equal(calls[0].autoBatches, true); assert.equal(calls[0].confirmation, true); assert.equal(calls[0].recycleLocal, false);
      assert.equal(calls[0].assetKeys.length, 205); assert.ok(!calls[0].assetKeys.includes("main:unmatched"));
      assert.equal(job.status, "completed"); assert.equal(catalog.releasePlan.assets.length, 0);
    }
  });
}

test("next release batch skips released and unmatched items, deduplicates cloud assets and advances after success", () => {
  const items = Array.from({ length: 230 }, (_, id) => ({ id }));
  const pending = new Set(items.slice(10, 220).map(item => item.id));
  const match = item => pending.has(item.id) ? { id: String(item.id), library: "main" } : null;
  const first = nextCloudReleaseBatch([items[0], items[10], ...items], match);
  assert.equal(first.remaining, 210);
  assert.equal(first.batch.length, 100);
  assert.deepEqual(first.batch.map(item => item.id), items.slice(10, 110).map(item => item.id));
  first.batch.forEach(item => pending.delete(item.id));
  const second = nextCloudReleaseBatch(items, match);
  assert.equal(second.remaining, 110);
  assert.deepEqual(second.batch.map(item => item.id), items.slice(110, 210).map(item => item.id));
  // Failed or unconfirmed results remain eligible for the next review.
  second.batch.slice(0, 90).forEach(item => pending.delete(item.id));
  const last = nextCloudReleaseBatch(items, match);
  assert.equal(last.remaining, 20);
  assert.equal(last.batch[0].id, 200);
  assert.equal(nextCloudReleaseBatch(items.slice(210), match).remaining, 10);
  assert.deepEqual(nextCloudReleaseBatch(items, () => null), { batch: [], remaining: 0 });
});

test("next release batch distinguishes identical asset IDs in separate libraries", () => {
  const items = [{ id: "a", library: "one" }, { id: "a", library: "two" }];
  assert.equal(nextCloudReleaseBatch(items, item => item).remaining, 2);
});

test("confirmed cloud photos match backup paths independently of local download dates", () => {
  const asset = { id: "photo-1", name: "IMG_2548.HEIC", mediaType: "photo", mainBytes: 100, localFiles: ["2023/12/31/IMG_2548.HEIC"] };
  const plan = { status: "confirmed", assets: [asset] };
  const item = { name: asset.name, path: asset.localFiles[0], size: 100, sourceName: "zhang", modified: Date.now() };
  assert.equal(findPhotoCloudAsset(item, plan), asset);
  assert.equal(findPhotoCloudAsset({ ...item, sourceName: "2023", path: "12/31/IMG_2548.HEIC" }, plan), asset);
  assert.equal(findPhotoCloudAsset({ ...item, sourceName: "12", path: "31/IMG_2548.HEIC" }, plan), asset);
  assert.equal(findPhotoCloudAsset({ ...item, sourceName: "FrameBase-iCloud", path: "zhang/2023/12/31/IMG_2548.HEIC" }, plan, "E:\\FrameBase-iCloud\\zhang"), asset);
  assert.equal(findPhotoCloudAsset({ ...item, path: "2024/12/31/IMG_2548.HEIC" }, plan), null);
  assert.equal(findPhotoCloudAsset({ ...item, size: 101 }, plan), null);
  assert.equal(findPhotoCloudAsset(item, { ...plan, status: "ready" }), null);
  assert.equal(findPhotoCloudAsset(item, { ...plan, assets: [asset, { ...asset, id: "ambiguous" }] }), null);
});

test("cloud video GIFs match verified photos without weakening release guards", async () => {
  const asset = { id: "gif-1", library: "PrimarySync", name: "IMG_2342.GIF", mediaType: "video", mainBytes: 2341404, localFiles: ["2023/11/21/IMG_2342.GIF"] };
  const plan = { status: "confirmed", assets: [asset] };
  const item = { name: asset.name, path: asset.localFiles[0], size: asset.mainBytes, sourceName: "zhang" };
  assert.equal(findPhotoCloudAsset(item, plan), asset);
  assert.equal(findPhotoCloudAsset({ ...item, name: "img_2342.gif", sourceName: "11", path: "21/img_2342.gif" }, plan), asset);
  assert.equal(asset.mediaType, "video");
  assert.equal(findPhotoCloudAsset({ ...item, size: item.size - 1 }, plan), null);
  assert.equal(findPhotoCloudAsset({ ...item, path: "2023/11/22/IMG_2342.GIF" }, plan), null);
  assert.equal(findPhotoCloudAsset({ ...item, name: "OTHER.GIF" }, plan), null);
  assert.equal(findPhotoCloudAsset(item, { ...plan, status: "ready" }), null);
  assert.equal(findPhotoCloudAsset(item, { ...plan, assets: [asset, { ...asset, id: "duplicate" }] }), null);
  assert.equal(findPhotoCloudAsset(item, { ...plan, assets: [asset, { ...asset, id: "photo-copy", mediaType: "photo" }] }), null);
  for (const extension of ["MOV", "MP4", "M4V"]) {
    const video = { ...asset, name: `IMG_2342.${extension}`, localFiles: [`2023/11/21/IMG_2342.${extension}`] };
    assert.equal(findPhotoCloudAsset({ ...item, name: video.name, path: video.localFiles[0] }, { ...plan, assets: [video] }), null);
  }
  const { collectCloudSelection } = await import("../app/photos/bulk-selection.ts");
  const selection = collectCloudSelection([item], photo => findPhotoCloudAsset(photo, plan));
  assert.deepEqual(selection.assets, [asset]);
  assert.equal(selection.skipped.length, 0);
});

test("photo library remains isolated from the existing video library", async () => {
  const [photos, photoStyles, icloud, videos, accountGate, globalStyles, heicCodec, thumbnailCodec, previewQueue] = await Promise.all([
    readFile(new URL("../app/photos/page.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/photos/photos.module.css", import.meta.url), "utf8"),
    readFile(new URL("../app/icloud/page.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/page.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/account-gate.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/globals.css", import.meta.url), "utf8"),
    readFile(new URL("../app/photos/heic-codec.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/photos/thumbnail-codec.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/photos/preview-queue.ts", import.meta.url), "utf8"),
  ]);
  assert.match(photos, /photo-source-folders-v1/);
  assert.match(photos, /photo-library:/);
  assert.match(photos, /framebase-photo-marks:/);
  assert.match(photos, /PHOTO_EXTENSIONS/);
  assert.match(photos, /heic/);
  assert.match(photos, /图片来源、索引和标记与原视频库彻底隔离/);
  assert.match(photos, /iCloud 照片与视频备份目录/);
  assert.match(photos, /loadSource\(source, next\)/);
  assert.match(photos, /<a className="media-header-button" href="\/\?library=video">视频库<\/a>/);
  assert.match(photos, /<a className="media-header-button" href="\/icloud">iCloud 备份<\/a>/);
  assert.match(photos, /<a className="media-header-button" href="\/lan">局域网<\/a>/);
  assert.match(photos, /手机比例 9:16/);
  assert.match(photos, /<PhotoActionsMenu/);
  assert.match(photoStyles, /\.phoneRatio \.thumb\{aspect-ratio:9\/16\}/);
  assert.match(icloud, /media-header-button.*href="\/\?library=video">← 返回视频库<\/a>/);
  assert.match(icloud, /media-header-button.*href="\/photos">返回图片库<\/a>/);
  assert.match(photos, /import\("heic2any"\)/);
  assert.match(heicCodec, /import\("libheif-js\/wasm-bundle\.js"\)/);
  assert.match(photos, /decodeModernHeic/);
  assert.match(photos, /HEIC 预览生成失败/);
  assert.match(photos, /framebase-photo-view/);
  assert.match(photos, /preferencesReady/);
  assert.match(photos, /framebase-last-library/);
  assert.match(videos, /framebase-last-library/);
  assert.match(accountGate, /localStorage\.getItem\(libraryPreferenceKey\) === "photos"/);
  assert.match(accountGate, /window\.location\.replace\("\/photos"\)/);
  assert.match(photos, /<nav className="media-header-actions">/);
  assert.match(icloud, /<div className="media-header-actions">/);
  assert.match(videos, /header-actions media-header-actions/);
  assert.match(globalStyles, /\.media-header-actions \.media-header-button/);
  assert.match(globalStyles, /height:34px;min-height:34px/);
  assert.match(photos, /IntersectionObserver/);
  assert.match(thumbnailCodec, /createImageBitmap/);
  assert.match(photos, /regularPreviewQueue: PreviewQueue = \{ pending: \[\], active: 0, limit: 2 \}/);
  assert.match(photos, /heicPreviewQueue: PreviewQueue = \{ pending: \[\], active: 0, limit: 1 \}/);
  assert.match(previewQueue, /if \(job\.cancelled\(\)\) \{ queue\.pending\.shift\(\); job\.skip\(\); continue; \}/);
  assert.match(photos, /thumbnailBlobCache/);
  assert.match(photos, /PERSISTENT_THUMBNAIL_CACHE_BYTES = 48 \* 1024 \* 1024/);
  assert.match(photos, /PERSISTENT_THUMBNAIL_PREFIX = "photo-thumbnail-v1:"/);
  assert.match(photos, /readPersistentThumbnail\(item\)/);
  assert.match(photos, /THUMBNAIL_WEBP_QUALITY = 0\.72/);
  assert.match(photos, /if \(HEIC_PREVIEW_EXTENSIONS\.has\(item\.extension\)\) persistThumbnail\(item, blob\)/);
  assert.match(photoStyles, /content-visibility:auto/);
  assert.match(photos, /LIVE_PHOTO_IMAGE_EXTENSIONS/);
  assert.match(photos, /findLivePhotoVideo\(entry.name, liveVideos\)/);
  assert.match(photos, /liveVideo: companion/);
  assert.match(photos, />实况<\/button>/);
  assert.match(photos, /<video src=\{liveUrl\} controls autoPlay playsInline/);
  assert.match(photos, /播放实况/);
  assert.match(photoStyles, /\.liveBadge\{/);
  assert.match(photoStyles, /\.liveToggle\{/);
  assert.doesNotMatch(photos, /createWritable\(/);
  assert.doesNotMatch(photos, /removeEntry\(/);
  assert.match(videos, /href="\/photos"/);
  assert.match(videos, /VIDEO_EXTENSIONS/);
  assert.doesNotMatch(videos, /photo-source-folders-v1/);
  const photoExtensions = photos.match(/const PHOTO_EXTENSIONS = new Set\(\[[^\]]+\]\)/)?.[0] || "";
  assert.doesNotMatch(photoExtensions, /"mp4"|"mov"|"m4v"/);
  assert.doesNotMatch(videos, /"heic"|"jpg"|"jpeg"/);
});


test("bulk cloud selection deduplicates assets and keeps unmatched photos", async () => {
  const { collectCloudSelection } = await import("../app/photos/bulk-selection.ts");
  const a = { id: "one", library: "default" };
  const b = { id: "one", library: "shared" };
  const photos = [a, a, b, null];
  const result = collectCloudSelection(photos, item => item);
  assert.deepEqual(result.assets, [a, b]);
  assert.equal(result.matched.length, 3);
  assert.deepEqual(result.skipped, [null]);
});
