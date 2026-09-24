import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("photo library remains isolated from the existing video library", async () => {
  const [photos, videos] = await Promise.all([
    readFile(new URL("../app/photos/page.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/page.tsx", import.meta.url), "utf8"),
  ]);
  assert.match(photos, /photo-source-folders-v1/);
  assert.match(photos, /photo-library:/);
  assert.match(photos, /framebase-photo-marks:/);
  assert.match(photos, /PHOTO_EXTENSIONS/);
  assert.match(photos, /heic/);
  assert.match(photos, /图片来源、索引和标记与原视频库彻底隔离/);
  assert.match(photos, /iCloud 照片与视频备份目录/);
  assert.doesNotMatch(photos, /removeEntry\(/);
  assert.match(videos, /href="\/photos"/);
  assert.match(videos, /VIDEO_EXTENSIONS/);
  assert.doesNotMatch(videos, /photo-source-folders-v1/);
  assert.doesNotMatch(photos, /"mp4"|"mov"|"m4v"/);
  assert.doesNotMatch(videos, /"heic"|"jpg"|"jpeg"/);
});
