import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

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
  assert.match(photos, /activeThumbnailJobs < 1/);
  assert.match(photoStyles, /content-visibility:auto/);
  assert.doesNotMatch(photos, /createWritable\(/);
  assert.doesNotMatch(photos, /removeEntry\(/);
  assert.match(videos, /href="\/photos"/);
  assert.match(videos, /VIDEO_EXTENSIONS/);
  assert.doesNotMatch(videos, /photo-source-folders-v1/);
  assert.doesNotMatch(photos, /"mp4"|"mov"|"m4v"/);
  assert.doesNotMatch(videos, /"heic"|"jpg"|"jpeg"/);
});
