import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { findPhotoCloudAsset } from "../app/photos/cloud-match.ts";

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

test("photo library remains isolated from the existing video library", async () => {
  const [photos, photoStyles, icloud, videos, accountGate, globalStyles] = await Promise.all([
    readFile(new URL("../app/photos/page.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/photos/photos.module.css", import.meta.url), "utf8"),
    readFile(new URL("../app/icloud/page.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/page.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/account-gate.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/globals.css", import.meta.url), "utf8"),
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
  assert.match(photos, /styles\.cardActions/);
  assert.match(photoStyles, /\.phoneRatio \.thumb\{aspect-ratio:9\/16\}/);
  assert.match(icloud, /media-header-button.*href="\/\?library=video">← 返回视频库<\/a>/);
  assert.match(icloud, /media-header-button.*href="\/photos">返回图片库<\/a>/);
  assert.match(photos, /import\("heic2any"\)/);
  assert.match(photos, /import\("libheif-js\/wasm-bundle\.js"\)/);
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
  assert.match(photos, /createImageBitmap/);
  assert.match(photos, /regularPreviewQueue: PreviewQueue = \{ pending: \[\], active: 0, limit: 3 \}/);
  assert.match(photos, /heicPreviewQueue: PreviewQueue = \{ pending: \[\], active: 0, limit: 1 \}/);
  assert.match(photos, /if \(job\.cancelled\(\)\) \{ job\.skip\(\); continue; \}/);
  assert.match(photos, /thumbnailBlobCache/);
  assert.match(photos, /PERSISTENT_THUMBNAIL_CACHE_BYTES = 48 \* 1024 \* 1024/);
  assert.match(photos, /PERSISTENT_THUMBNAIL_PREFIX = "photo-thumbnail-v1:"/);
  assert.match(photos, /readPersistentThumbnail\(item\)/);
  assert.match(photos, /THUMBNAIL_WEBP_QUALITY = 0\.72/);
  assert.match(photos, /if \(HEIC_PREVIEW_EXTENSIONS\.has\(item\.extension\)\) persistThumbnail\(item, blob\)/);
  assert.match(photoStyles, /content-visibility:auto/);
  assert.match(photos, /LIVE_PHOTO_IMAGE_EXTENSIONS/);
  assert.match(photos, /const liveVideos = new Map/);
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
