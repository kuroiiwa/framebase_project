import { decodeHeicBlob, type HeicPreviewOptions } from "./heic-codec";

let worker: Worker | null = null;
let workerUnavailable = false;
let nextId = 0;
const requests = new Map<number, { resolve(blob: Blob): void; reject(error: Error): void; timer: ReturnType<typeof setTimeout> }>();

function failWorker() {
  workerUnavailable = true;
  worker?.terminate(); worker = null;
  for (const request of requests.values()) { clearTimeout(request.timer); request.reject(new Error("heic_worker_unavailable")); }
  requests.clear();
}

export async function decodeHeicPreview(file: Blob, options: HeicPreviewOptions = {}) {
  if (!workerUnavailable && typeof Worker !== "undefined" && typeof OffscreenCanvas !== "undefined") {
    try {
      if (!worker) {
        try { worker = new Worker(new URL("./heic-preview.worker.ts", import.meta.url), { type: "module" }); }
        catch { failWorker(); throw new Error("heic_worker_unavailable"); }
        worker.onmessage = ({ data }: MessageEvent<{ id: number; blob?: Blob; error?: string }>) => {
          const request = requests.get(data.id);
          if (!request) return;
          clearTimeout(request.timer); requests.delete(data.id);
          if (data.blob) request.resolve(data.blob);
          else request.reject(new Error(data.error || "heic_decode_failed"));
        };
        worker.onerror = failWorker;
        worker.onmessageerror = failWorker;
      }
      return await new Promise<Blob>((resolve, reject) => {
        const id = ++nextId;
        requests.set(id, { resolve, reject, timer: setTimeout(failWorker, 60_000) });
        try { worker!.postMessage({ id, file, options }); }
        catch { failWorker(); }
      });
    } catch (error) {
      if (!workerUnavailable) throw error; // Invalid images use the legacy codec, not a second WASM decode.
    }
  }
  return decodeHeicBlob(file, options);
}
