import { decodeHeicBlob, type HeicPreviewOptions } from "./heic-codec";

type Request = { id: number; file: Blob; options: HeicPreviewOptions };
const scope = globalThis as unknown as { onmessage: ((event: MessageEvent<Request>) => void) | null; postMessage(message: unknown): void };
let pending = Promise.resolve();
scope.onmessage = ({ data }) => {
  // libheif owns one context: keep decoding serial even when callers overlap.
  pending = pending.then(async () => {
    try { scope.postMessage({ id: data.id, blob: await decodeHeicBlob(data.file, data.options) }); }
    catch (error) { scope.postMessage({ id: data.id, error: error instanceof Error ? error.message : "heic_decode_failed" }); }
  });
};
