export type StoryboardFrame = { time: number; blob: Blob };
export const STORYBOARD_FRAME_COUNT = 24;
const STORYBOARD_FRAME_WIDTH = 320;
const STORYBOARD_WEBP_QUALITY = .58;

function waitForVideo(video: HTMLVideoElement, eventName: "loadedmetadata" | "seeked", timeout: number) {
  return new Promise<void>((resolve, reject) => {
    const timer = window.setTimeout(() => reject(new Error("视频读取超时")), timeout);
    const done = () => { window.clearTimeout(timer); resolve(); };
    video.addEventListener(eventName, done, { once: true });
    video.addEventListener("error", () => { window.clearTimeout(timer); reject(new Error("无法读取视频")); }, { once: true });
  });
}

export async function buildStoryboard(file: File, frameCount = STORYBOARD_FRAME_COUNT): Promise<StoryboardFrame[]> {
  const url = URL.createObjectURL(file);
  const video = document.createElement("video");
  video.muted = true;
  video.preload = "metadata";
  video.src = url;
  try {
    await waitForVideo(video, "loadedmetadata", 12_000);
    if (!Number.isFinite(video.duration) || video.duration <= 0) throw new Error("视频时长不可用");
    const width = video.videoWidth || 1280;
    const height = video.videoHeight || 720;
    const canvas = document.createElement("canvas");
    canvas.width = STORYBOARD_FRAME_WIDTH;
    canvas.height = Math.max(96, Math.round(canvas.width * height / width));
    const context = canvas.getContext("2d");
    if (!context) throw new Error("浏览器无法生成故事板");
    const frames: StoryboardFrame[] = [];
    for (let index = 0; index < frameCount; index++) {
      const time = video.duration * ((index + .5) / frameCount);
      video.currentTime = Math.min(time, Math.max(0, video.duration - .05));
      await waitForVideo(video, "seeked", 4_000);
      context.drawImage(video, 0, 0, canvas.width, canvas.height);
      const blob = await new Promise<Blob>((resolve, reject) => canvas.toBlob(value => value ? resolve(value) : reject(new Error("故事板帧生成失败")), "image/webp", STORYBOARD_WEBP_QUALITY));
      frames.push({ time, blob });
    }
    return frames;
  } finally {
    video.removeAttribute("src");
    video.load();
    URL.revokeObjectURL(url);
  }
}
