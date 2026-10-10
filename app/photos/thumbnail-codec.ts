export async function encodeThumbnail(blob: Blob, width: number, quality: number): Promise<Blob> {
  const bitmap = await createImageBitmap(blob, { resizeWidth: width, resizeQuality: "medium" });
  let canvas: OffscreenCanvas | HTMLCanvasElement | undefined;
  try {
    canvas = typeof OffscreenCanvas !== "undefined"
      ? new OffscreenCanvas(bitmap.width, bitmap.height) : document.createElement("canvas");
    canvas.width = bitmap.width; canvas.height = bitmap.height;
    const context = canvas.getContext("2d") as OffscreenCanvasRenderingContext2D | CanvasRenderingContext2D | null;
    if (!context) throw new Error("thumbnail_canvas_unavailable");
    context.drawImage(bitmap, 0, 0);
    if ("convertToBlob" in canvas) return await canvas.convertToBlob({ type: "image/webp", quality });
    return await new Promise<Blob>((resolve, reject) => (canvas as HTMLCanvasElement).toBlob(result => result ? resolve(result) : reject(new Error("thumbnail_failed")), "image/webp", quality));
  } finally {
    bitmap.close();
    if (canvas) canvas.width = canvas.height = 1;
  }
}
