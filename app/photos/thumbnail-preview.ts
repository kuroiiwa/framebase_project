import { encodeThumbnail } from "./thumbnail-codec";

let worker: Worker | null = null;
let unavailable = false;
let nextId = 0;
const requests = new Map<number, { resolve(blob: Blob): void; reject(error: Error): void; timer: ReturnType<typeof setTimeout> }>();
function failWorker() {
  unavailable = true;
  worker?.terminate(); worker = null;
  for (const request of requests.values()) {
    clearTimeout(request.timer); request.reject(new Error("thumbnail_worker_unavailable"));
  }
  requests.clear();
}

export async function createBrowserThumbnail(blob: Blob, width: number, quality: number) {
  if (!unavailable && typeof Worker !== "undefined" && typeof OffscreenCanvas !== "undefined") {
    try {
      if (!worker) {
        worker = new Worker(new URL("./thumbnail.worker.ts", import.meta.url), { type: "module" });
        worker.onmessage = ({ data }: MessageEvent<{ id: number; blob?: Blob; error?: string }>) => {
          const request = requests.get(data.id);
          if (!request) return;
          requests.delete(data.id); clearTimeout(request.timer);
          if (data.blob) request.resolve(data.blob);
          else request.reject(new Error(data.error || "thumbnail_failed"));
        };
        worker.onerror = failWorker; worker.onmessageerror = failWorker;
      }
      return await new Promise<Blob>((resolve, reject) => {
        const id = ++nextId;
        requests.set(id, { resolve, reject, timer: setTimeout(failWorker, 60_000) });
        try { worker!.postMessage({ id, blob, width, quality }); } catch { failWorker(); }
      });
    } catch (error) {
      if (worker && !unavailable) throw error;
      failWorker();
    }
  }
  return encodeThumbnail(blob, width, quality);
}
