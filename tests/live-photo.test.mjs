import assert from "node:assert/strict";
import test from "node:test";
import { findLivePhotoVideo, livePhotoVideoNames } from "../shared/live-photo.mjs";

test("HEIC companions recognize icloudpd suffix without matching other numbered photos", () => {
  const companion = { name: "IMG_4676_HEVC.MOV" };
  assert.equal(findLivePhotoVideo("IMG_4676.HEIC", [{ name: "IMG_46760.MOV" }, companion]), companion);
  assert.deepEqual(livePhotoVideoNames("IMG_4676.HEIF"), ["img_4676.mov", "img_4676_hevc.mov"]);
  assert.equal(findLivePhotoVideo("IMG_4676.JPG", [companion]), null);
});
test("original naming remains supported and ambiguous companions are rejected", () => {
  const original = { name: "IMG_4676.MOV" };
  assert.equal(findLivePhotoVideo("IMG_4676.heic", [original]), original);
  assert.equal(findLivePhotoVideo("IMG_4676.HEIC", [original, { name: "IMG_4676_HEVC.MOV" }]), null);
});
