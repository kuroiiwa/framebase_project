export type HeicPreviewOptions = { width?: number; type?: "image/jpeg" | "image/webp"; quality?: number };

let decoder: import("libheif-js/wasm-bundle.js").HeifDecoder | undefined;

export async function decodeHeicBlob(file: Blob, options: HeicPreviewOptions = {}): Promise<Blob> {
  const { default: libheif } = await import("libheif-js/wasm-bundle.js");
  decoder ??= new libheif.HeifDecoder();
  const images = decoder.decode(await file.arrayBuffer());
  try {
    const image = images.find(candidate => candidate.is_primary?.()) || images[0];
    if (!image) throw new Error("heic_no_image");
    const width = image.get_width();
    const height = image.get_height();
    if (!width || !height || width * height > 100_000_000) throw new Error("heic_invalid_dimensions");
    const imageData = new ImageData(width, height);
    await new Promise<void>((resolve, reject) => image.display(imageData, result => result ? resolve() : reject(new Error("heic_decode_failed"))));
    const outputWidth = Math.min(width, options.width || width);
    const outputHeight = Math.max(1, Math.round(height * outputWidth / width));
    const type = options.type || "image/jpeg";
    const quality = options.quality ?? .86;
    if (typeof OffscreenCanvas !== "undefined") {
      const source = new OffscreenCanvas(width, height);
      const target = outputWidth === width ? source : new OffscreenCanvas(outputWidth, outputHeight);
      try {
        const sourceContext = source.getContext("2d");
        const targetContext = target.getContext("2d");
        if (!sourceContext || !targetContext) throw new Error("heic_canvas_unavailable");
        sourceContext.putImageData(imageData, 0, 0);
        if (target !== source) targetContext.drawImage(source, 0, 0, outputWidth, outputHeight);
        return await target.convertToBlob({ type, quality });
      } finally { source.width = source.height = target.width = target.height = 1; }
    }
    const source = document.createElement("canvas");
    const target = outputWidth === width ? source : document.createElement("canvas");
    try {
      source.width = width; source.height = height;
      target.width = outputWidth; target.height = outputHeight;
      const sourceContext = source.getContext("2d");
      const targetContext = target.getContext("2d");
      if (!sourceContext || !targetContext) throw new Error("heic_canvas_unavailable");
      sourceContext.putImageData(imageData, 0, 0);
      if (target !== source) targetContext.drawImage(source, 0, 0, outputWidth, outputHeight);
      return await new Promise<Blob>((resolve, reject) => target.toBlob(result => result ? resolve(result) : reject(new Error("heic_canvas_failed")), type, quality));
    } finally { source.width = source.height = target.width = target.height = 1; }
  } finally { images.forEach(image => image.free?.()); }
}
