import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("photo library remains isolated from the existing video library", async () => {
  const [photos, photoStyles, icloud, videos] = await Promise.all([
    readFile(new URL("../app/photos/page.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/photos/photos.module.css", import.meta.url), "utf8"),
    readFile(new URL("../app/icloud/page.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/page.tsx", import.meta.url), "utf8"),
  ]);
  assert.match(photos, /photo-source-folders-v1/);
  assert.match(photos, /photo-library:/);
  assert.match(photos, /framebase-photo-marks:/);
  assert.match(photos, /PHOTO_EXTENSIONS/);
  assert.match(photos, /heic/);
  assert.match(photos, /图片来源、索引和标记与原视频库彻底隔离/);
  assert.match(photos, /iCloud 照片与视频备份目录/);
  assert.match(photos, /loadSource\(source, next\)/);
  assert.match(photos, /<a href="\/">视频库<\/a>/);
  assert.match(photos, /<a href="\/icloud">iCloud 备份<\/a>/);
  assert.match(photos, /<a href="\/lan">局域网<\/a>/);
  assert.match(photos, /手机比例 9:16/);
  assert.match(photos, /styles\.cardActions/);
  assert.match(photoStyles, /\.phoneRatio \.thumb\{aspect-ratio:9\/16\}/);
  assert.match(icloud, /<a className=\{styles\.backLink\} href="\/">← 返回视频库<\/a>/);
  assert.match(icloud, /<a className=\{styles\.backLink\} href="\/photos">返回图片库<\/a>/);
  assert.match(photos, /import\("heic2any"\)/);
  assert.match(photos, /HEIC 预览生成失败/);
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
