// icloudpd's suffix policy stores HEIC Live Photo videos as <stem>_HEVC.MOV.
export function livePhotoVideoNames(imageName) {
  const name = imageName.toLowerCase();
  const stem = name.replace(/\.[^.]+$/, "");
  return /\.(heic|heif)$/.test(name) ? [`${stem}.mov`, `${stem}_hevc.mov`] : [`${stem}.mov`];
}

export function findLivePhotoVideo(imageName, files) {
  const names = new Set(livePhotoVideoNames(imageName));
  const matches = files.filter(file => names.has(file.name.toLowerCase()));
  return matches.length === 1 ? matches[0] : null;
}
