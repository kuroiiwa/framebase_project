import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { realpath, stat } from "node:fs/promises";
import { basename, dirname, extname, isAbsolute, relative, resolve } from "node:path";

const imageExtensions = new Set(["jpg", "jpeg", "png", "gif", "webp", "bmp", "avif", "heic", "heif", "tif", "tiff", "dng", "cr2", "cr3", "nef", "arw", "raf", "orf", "rw2"]);
const invalid = message => Object.assign(new Error(message), { status: 409 });

export async function preparePhotoRecycle(root, requested) {
  if (!Array.isArray(requested) || requested.length < 1 || requested.length > 2) throw invalid("请选择一张图片及其配对实况视频。");
  const canonicalRoot = await realpath(root);
  const files = [];
  for (const [index, item] of requested.entries()) {
    if (!item || typeof item.relativePath !== "string" || !/^[a-f0-9]{64}$/.test(item.sha256 || "")) throw invalid("文件信息无效，请重新扫描图片来源。");
    const extension = extname(item.relativePath).slice(1).toLowerCase();
    if (index === 0 ? !imageExtensions.has(extension) : extension !== "mov") throw invalid("仅允许删除图片及配对 MOV 文件。");
    if (index === 1 && (dirname(item.relativePath) !== dirname(requested[0].relativePath) || basename(item.relativePath, extname(item.relativePath)).toLowerCase() !== basename(requested[0].relativePath, extname(requested[0].relativePath)).toLowerCase())) throw invalid("实况视频与图片不匹配。");
    const requestedPath = resolve(canonicalRoot, item.relativePath);
    const lexical = relative(canonicalRoot, requestedPath);
    if (!lexical || lexical.startsWith("..") || isAbsolute(lexical)) throw invalid("文件路径超出所选图片来源。");
    const actual = await realpath(requestedPath);
    const actualRelative = relative(canonicalRoot, actual);
    if (!actualRelative || actualRelative.startsWith("..") || isAbsolute(actualRelative)) throw invalid("文件链接超出所选图片来源。");
    const info = await stat(actual);
    if (!info.isFile() || info.size !== item.size) throw invalid("文件大小已变化，请重新扫描。");
    const hash = createHash("sha256");
    for await (const chunk of createReadStream(actual)) hash.update(chunk);
    if (hash.digest("hex") !== item.sha256) throw invalid("所选目录中的文件与当前图片不一致，没有执行删除。");
    files.push({ path: actual, relativePath: item.relativePath, size: info.size });
  }
  return { files, fileCount: files.length, bytes: files.reduce((sum, file) => sum + file.size, 0) };
}
