import { encodeThumbnail } from "./thumbnail-codec";

self.onmessage = async ({ data }: MessageEvent<{ id: number; blob: Blob; width: number; quality: number }>) => {
  try {
    const blob = await encodeThumbnail(data.blob, data.width, data.quality);
    self.postMessage({ id: data.id, blob });
  } catch (error) {
    self.postMessage({ id: data.id, error: error instanceof Error ? error.message : "thumbnail_failed" });
  }
};
