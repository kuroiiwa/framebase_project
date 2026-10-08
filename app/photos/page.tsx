"use client";

/* eslint-disable @next/next/no-img-element, @next/next/no-html-link-for-pages, jsx-a11y/media-has-caption -- previews use local Blob URLs; Live Photo MOV files contain no caption track; hard navigation avoids losing File System Access state. */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import AccountGate, { signOut } from "../account-gate";
import { accountDbName, accountKey } from "../account-storage";
import ThemeSelector from "../theme-selector";
import styles from "./photos.module.css";
import { findPhotoCloudAsset } from "./cloud-match";

type FsPermission = "granted" | "denied" | "prompt";
type FileHandle = { kind: "file"; name: string; getFile(): Promise<File> };
type DirectoryHandle = {
  kind: "directory";
  name: string;
  values(): AsyncIterableIterator<FileHandle | DirectoryHandle>;
  queryPermission?(options?: { mode: "read" }): Promise<FsPermission>;
  requestPermission?(options?: { mode: "read" }): Promise<FsPermission>;
  isSameEntry?(other: DirectoryHandle): Promise<boolean>;
};
type PickerWindow = Window & { showDirectoryPicker?: (options?: { mode: "read" }) => Promise<DirectoryHandle> };
type LivePhotoVideo = { name: string; path: string; extension: "mov"; handle: FileHandle };
type PhotoItem = {
  id: string;
  sourceId: string;
  sourceName: string;
  name: string;
  path: string;
  extension: string;
  size: number;
  modified: number;
  handle: FileHandle;
  liveVideo?: LivePhotoVideo | null;
  liked: boolean;
  cleanup: boolean;
};
type SourceFolder = { id: string; name: string; handle: DirectoryHandle; lastScan: number; photoCount: number; totalSize: number };
type PhotoMarks = Record<string, { liked?: boolean; cleanup?: boolean }>;
type Tab = "all" | "live" | "liked" | "cleanup";
type Sort = "newest" | "oldest" | "largest" | "smallest" | "name";
type PreviewRatio = "standard" | "phone";
type PhotoPreferences = { compact: boolean; previewRatio: PreviewRatio; sort: Sort };
type IcloudAsset = { id: string; library: string; name: string; created: string; mediaType: "photo" | "video"; originalBytes: number; mainBytes: number; livePhotoBytes: number; livePhoto: boolean; localFiles: string[] };
type ReleaseCatalog = { releasePlan: { id: string | null; status: string; assets: IcloudAsset[] } | null; releaseHistory: { movedCount: number; movedBytes: number; recycledFileCount: number; recycledBytes: number; lastReleasedAt: string | null }; timeline: { staleAt: string | null; staleReason: string | null } };

const PHOTO_EXTENSIONS = new Set(["jpg", "jpeg", "png", "gif", "webp", "bmp", "avif", "heic", "heif", "tif", "tiff", "dng", "cr2", "cr3", "nef", "arw", "raf", "orf", "rw2"]);
const BROWSER_PREVIEW_EXTENSIONS = new Set(["jpg", "jpeg", "png", "gif", "webp", "bmp", "avif"]);
const HEIC_PREVIEW_EXTENSIONS = new Set(["heic", "heif"]);
const LIVE_PHOTO_IMAGE_EXTENSIONS = new Set(["heic", "heif", "jpg", "jpeg"]);
const SOURCES_KEY = "photo-source-folders-v1";
const PHOTO_PREFERENCES_KEY = "framebase-photo-view";
const PAGE_SIZE = 48;
const THUMBNAIL_WIDTH = 384;
const THUMBNAIL_WEBP_QUALITY = 0.72;
const THUMBNAIL_CACHE_LIMIT = 160;
const PERSISTENT_THUMBNAIL_CACHE_BYTES = 48 * 1024 * 1024;
const PERSISTENT_THUMBNAIL_CACHE_ENTRIES = 800;
const PERSISTENT_THUMBNAIL_MANIFEST_KEY = "photo-thumbnail-manifest-v1";
const PERSISTENT_THUMBNAIL_PREFIX = "photo-thumbnail-v1:";
type PreviewJob = { cancelled: () => boolean; start: () => Promise<void>; skip: () => void };
type PreviewQueue = { pending: PreviewJob[]; active: number; limit: number };
type ThumbnailManifest = { entries: Array<{ key: string; size: number }>; totalSize: number };
const regularPreviewQueue: PreviewQueue = { pending: [], active: 0, limit: 3 };
const heicPreviewQueue: PreviewQueue = { pending: [], active: 0, limit: 1 };
const thumbnailBlobCache = new Map<string, Blob>();
let thumbnailPersistence = Promise.resolve();

function drainPreviewQueue(queue: PreviewQueue) {
  while (queue.pending.length && queue.active < queue.limit) {
    const job = queue.pending.shift()!;
    if (job.cancelled()) { job.skip(); continue; }
    queue.active += 1;
    void job.start().finally(() => { queue.active -= 1; drainPreviewQueue(queue); });
  }
}

function schedulePreview<T>(queue: PreviewQueue, task: () => Promise<T>, cancelled: () => boolean, priority = false) {
  return new Promise<T | null>((resolve, reject) => {
    const job: PreviewJob = {
      cancelled,
      skip: () => resolve(null),
      start: async () => {
        try {
          const result = await task();
          resolve(cancelled() ? null : result);
        } catch (error) { if (cancelled()) resolve(null); else reject(error); }
      },
    };
    if (priority) queue.pending.unshift(job); else queue.pending.push(job);
    drainPreviewQueue(queue);
  });
}

function thumbnailCacheKey(item: PhotoItem) { return `${item.id}:${item.modified}:${item.size}`; }
function persistentThumbnailKey(item: PhotoItem) { return `${PERSISTENT_THUMBNAIL_PREFIX}${thumbnailCacheKey(item)}`; }
function readThumbnailCache(item: PhotoItem) {
  const key = thumbnailCacheKey(item);
  const cached = thumbnailBlobCache.get(key) || null;
  if (cached) { thumbnailBlobCache.delete(key); thumbnailBlobCache.set(key, cached); }
  return cached;
}
function rememberThumbnail(item: PhotoItem, blob: Blob) {
  const key = thumbnailCacheKey(item);
  thumbnailBlobCache.delete(key);
  thumbnailBlobCache.set(key, blob);
  while (thumbnailBlobCache.size > THUMBNAIL_CACHE_LIMIT) thumbnailBlobCache.delete(thumbnailBlobCache.keys().next().value!);
}

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(accountDbName(), 1);
    request.onupgradeneeded = () => request.result.createObjectStore("cache");
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function dbGet<T>(key: string): Promise<T | undefined> {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const request = db.transaction("cache", "readonly").objectStore("cache").get(key);
    request.onsuccess = () => { db.close(); resolve(request.result as T | undefined); };
    request.onerror = () => { db.close(); reject(request.error); };
  });
}

async function dbSet(key: string, value: unknown) {
  const db = await openDb();
  return new Promise<void>((resolve, reject) => {
    const transaction = db.transaction("cache", "readwrite");
    transaction.objectStore("cache").put(value, key);
    transaction.oncomplete = () => { db.close(); resolve(); };
    transaction.onerror = () => { db.close(); reject(transaction.error); };
  });
}

async function dbDelete(key: string) {
  const db = await openDb();
  return new Promise<void>((resolve, reject) => {
    const transaction = db.transaction("cache", "readwrite");
    transaction.objectStore("cache").delete(key);
    transaction.oncomplete = () => { db.close(); resolve(); };
    transaction.onerror = () => { db.close(); reject(transaction.error); };
  });
}

async function readPersistentThumbnail(item: PhotoItem) {
  const blob = await dbGet<Blob>(persistentThumbnailKey(item)).catch(() => undefined);
  if (!(blob instanceof Blob)) return null;
  rememberThumbnail(item, blob);
  return blob;
}

function persistThumbnail(item: PhotoItem, blob: Blob) {
  const key = persistentThumbnailKey(item);
  thumbnailPersistence = thumbnailPersistence.catch(() => undefined).then(async () => {
    const saved = await dbGet<ThumbnailManifest>(PERSISTENT_THUMBNAIL_MANIFEST_KEY).catch(() => undefined);
    const entries = Array.isArray(saved?.entries) ? saved.entries.filter(entry => entry.key !== key) : [];
    let totalSize = entries.reduce((sum, entry) => sum + entry.size, 0);
    entries.push({ key, size: blob.size });
    totalSize += blob.size;
    await dbSet(key, blob);
    while (entries.length > PERSISTENT_THUMBNAIL_CACHE_ENTRIES || totalSize > PERSISTENT_THUMBNAIL_CACHE_BYTES) {
      const expired = entries.shift();
      if (!expired) break;
      totalSize -= expired.size;
      await dbDelete(expired.key);
    }
    await dbSet(PERSISTENT_THUMBNAIL_MANIFEST_KEY, { entries, totalSize } satisfies ThumbnailManifest);
  }).catch(() => undefined);
}

function writeThumbnailCache(item: PhotoItem, blob: Blob) {
  rememberThumbnail(item, blob);
  if (HEIC_PREVIEW_EXTENSIONS.has(item.extension)) persistThumbnail(item, blob);
}

function marksKey(sourceId: string) { return accountKey(`framebase-photo-marks:${sourceId}`); }
function readMarks(sourceId: string): PhotoMarks {
  try { return JSON.parse(localStorage.getItem(marksKey(sourceId)) || "{}"); }
  catch { return {}; }
}

function formatBytes(bytes: number) {
  if (!bytes) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  const index = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  return `${(bytes / 1024 ** index).toFixed(index > 1 ? 1 : 0)} ${units[index]}`;
}

function formatDate(timestamp: number) {
  return new Intl.DateTimeFormat("zh-CN", { year: "numeric", month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" }).format(timestamp);
}

async function scanDirectory(source: SourceFolder, progress: (count: number) => void) {
  const marks = readMarks(source.id);
  const found: PhotoItem[] = [];
  async function walk(directory: DirectoryHandle, parts: string[]) {
    const entries: Array<FileHandle | DirectoryHandle> = [];
    for await (const entry of directory.values()) entries.push(entry);
    const files = entries.filter((entry): entry is FileHandle => entry.kind === "file");
    const liveVideos = new Map(files.filter(entry => entry.name.split(".").pop()?.toLowerCase() === "mov").map(entry => [entry.name.replace(/\.[^.]+$/, "").toLocaleLowerCase(), entry]));
    for (const entry of files) {
      const extension = entry.name.split(".").pop()?.toLowerCase() || "";
      if (!PHOTO_EXTENSIONS.has(extension)) continue;
      const file = await entry.getFile();
      const path = [...parts, entry.name].join("/");
      const stem = entry.name.replace(/\.[^.]+$/, "").toLocaleLowerCase();
      const companion = LIVE_PHOTO_IMAGE_EXTENSIONS.has(extension) ? liveVideos.get(stem) : undefined;
      found.push({
        id: `${source.id}:${path}`,
        sourceId: source.id,
        sourceName: source.name,
        name: entry.name,
        path,
        extension,
        size: file.size,
        modified: file.lastModified,
        handle: entry,
        liveVideo: companion ? { name: companion.name, path: [...parts, companion.name].join("/"), extension: "mov", handle: companion } : null,
        liked: Boolean(marks[path]?.liked),
        cleanup: Boolean(marks[path]?.cleanup),
      });
      if (found.length % 25 === 0) progress(found.length);
    }
    for (const entry of entries) if (entry.kind === "directory") await walk(entry, [...parts, entry.name]);
  }
  await walk(source.handle, []);
  progress(found.length);
  return found;
}

async function createPreviewBlob(item: PhotoItem) {
  const file = await item.handle.getFile();
  if (HEIC_PREVIEW_EXTENSIONS.has(item.extension)) {
    try {
      const { default: heic2any } = await import("heic2any");
      const converted = await heic2any({ blob: file, toType: "image/jpeg", quality: 0.86 });
      return Array.isArray(converted) ? converted[0] : converted;
    } catch {
      return decodeModernHeic(file);
    }
  }
  if (BROWSER_PREVIEW_EXTENSIONS.has(item.extension)) return file;
  return null;
}

async function decodeModernHeic(file: Blob) {
  const { default: libheif } = await import("libheif-js/wasm-bundle.js");
  const images = new libheif.HeifDecoder().decode(await file.arrayBuffer());
  const image = images.find(candidate => candidate.is_primary?.()) || images[0];
  if (!image) throw new Error("heic_no_image");
  const width = image.get_width();
  const height = image.get_height();
  if (!width || !height || width * height > 100_000_000) throw new Error("heic_invalid_dimensions");
  const imageData = new ImageData(width, height);
  try {
    await new Promise<void>((resolve, reject) => image.display(imageData, result => result ? resolve() : reject(new Error("heic_decode_failed"))));
    if (typeof OffscreenCanvas !== "undefined") {
      const canvas = new OffscreenCanvas(width, height);
      const context = canvas.getContext("2d");
      if (!context) throw new Error("heic_canvas_unavailable");
      context.putImageData(imageData, 0, 0);
      return canvas.convertToBlob({ type: "image/jpeg", quality: 0.86 });
    }
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext("2d");
    if (!context) throw new Error("heic_canvas_unavailable");
    context.putImageData(imageData, 0, 0);
    return await new Promise<Blob>((resolve, reject) => canvas.toBlob(result => result ? resolve(result) : reject(new Error("heic_canvas_failed")), "image/jpeg", 0.86));
  } finally {
    image.free?.();
  }
}

async function createPreviewObjectUrl(item: PhotoItem, cancelled: () => boolean) {
  const blob = HEIC_PREVIEW_EXTENSIONS.has(item.extension)
    ? await schedulePreview(heicPreviewQueue, () => createPreviewBlob(item), cancelled, true)
    : await createPreviewBlob(item);
  return blob ? URL.createObjectURL(blob) : null;
}

async function createThumbnailBlob(item: PhotoItem) {
    const blob = await createPreviewBlob(item);
    if (!blob) return null;
    const bitmap = await createImageBitmap(blob, { resizeWidth: THUMBNAIL_WIDTH, resizeQuality: "medium" });
    try {
      if (typeof OffscreenCanvas !== "undefined") {
        const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
        canvas.getContext("2d")?.drawImage(bitmap, 0, 0);
        return await canvas.convertToBlob({ type: "image/webp", quality: THUMBNAIL_WEBP_QUALITY });
      }
      const canvas = document.createElement("canvas");
      canvas.width = bitmap.width;
      canvas.height = bitmap.height;
      canvas.getContext("2d")?.drawImage(bitmap, 0, 0);
      return await new Promise<Blob>((resolve, reject) => canvas.toBlob(result => result ? resolve(result) : reject(new Error("thumbnail_failed")), "image/webp", THUMBNAIL_WEBP_QUALITY));
    } finally {
      bitmap.close();
    }
}

async function createThumbnailObjectUrl(item: PhotoItem, cancelled: () => boolean) {
  const cached = readThumbnailCache(item)
    || (HEIC_PREVIEW_EXTENSIONS.has(item.extension) ? await readPersistentThumbnail(item) : null);
  if (cached) return URL.createObjectURL(cached);
  const queue = HEIC_PREVIEW_EXTENSIONS.has(item.extension) ? heicPreviewQueue : regularPreviewQueue;
  const thumbnail = await schedulePreview(queue, async () => {
    const created = await createThumbnailBlob(item);
    if (created) writeThumbnailCache(item, created);
    return created;
  }, cancelled);
  return thumbnail ? URL.createObjectURL(thumbnail) : null;
}

function previewStatus(extension: string, failed: boolean) {
  if (failed) return HEIC_PREVIEW_EXTENSIONS.has(extension) ? "HEIC 预览生成失败" : "预览读取失败";
  if (HEIC_PREVIEW_EXTENSIONS.has(extension)) return "正在生成 HEIC 预览";
  if (BROWSER_PREVIEW_EXTENSIONS.has(extension)) return "正在读取预览";
  return "浏览器暂不支持预览";
}

function PhotoThumb({ item, onOpen }: { item: PhotoItem; onOpen: () => void }) {
  const buttonRef = useRef<HTMLButtonElement>(null);
  const [nearViewport, setNearViewport] = useState(false);
  const [url, setUrl] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    const button = buttonRef.current;
    if (!button) return;
    if (!("IntersectionObserver" in window)) {
      queueMicrotask(() => setNearViewport(true));
      return;
    }
    const observer = new IntersectionObserver(entries => {
      if (!entries.some(entry => entry.isIntersecting)) return;
      setNearViewport(true);
      observer.disconnect();
    }, { rootMargin: "600px 0px" });
    observer.observe(button);
    return () => observer.disconnect();
  }, []);
  useEffect(() => {
    if (!nearViewport) return;
    let cancelled = false;
    let objectUrl = "";
    void createThumbnailObjectUrl(item, () => cancelled).then(createdUrl => {
      if (!createdUrl) return;
      if (cancelled) URL.revokeObjectURL(createdUrl);
      else { objectUrl = createdUrl; setUrl(createdUrl); }
    }).catch(() => { if (!cancelled) setFailed(true); });
    return () => { cancelled = true; if (objectUrl) URL.revokeObjectURL(objectUrl); };
  }, [item, nearViewport]);
  return <button ref={buttonRef} className={styles.thumb} onClick={onOpen} aria-label={`查看 ${item.name}`}>
    {url && !failed ? <img src={url} alt="" loading="lazy" decoding="async" onError={() => setFailed(true)} /> : <span><b>{item.extension.toUpperCase()}</b><small>{nearViewport ? previewStatus(item.extension, failed) : "接近时加载预览"}</small></span>}
  </button>;
}

function PhotoViewer({ item, previous, next, onClose, onDelete, cloudAvailable, cloudLoading, cloudMessage, releaseBusy }: { item: PhotoItem; previous: () => void; next: () => void; onClose: () => void; onDelete: (mode: "local" | "icloud" | "both") => void; cloudAvailable: boolean; cloudLoading: boolean; cloudMessage: string; releaseBusy: boolean }) {
  const [initialUrl] = useState<string | null>(() => {
    const thumbnail = readThumbnailCache(item);
    return thumbnail ? URL.createObjectURL(thumbnail) : null;
  });
  const [url, setUrl] = useState<string | null>(initialUrl);
  const [failed, setFailed] = useState(false);
  const [playingLive, setPlayingLive] = useState(false);
  const [liveUrl, setLiveUrl] = useState<string | null>(null);
  const [liveFailed, setLiveFailed] = useState(false);
  const [zoom, setZoom] = useState(1);
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const mediaRef = useRef<HTMLDivElement>(null);
  const dragRef = useRef<{ x: number; y: number; panX: number; panY: number } | null>(null);
  const changeZoom = (factor: number) => setZoom(value => Math.min(8, Math.max(1, value * factor)));
  const fitImage = () => { setZoom(1); setPan({ x: 0, y: 0 }); };
  useEffect(() => {
    const media = mediaRef.current;
    if (!media || playingLive) return;
    const wheel = (event: WheelEvent) => {
      event.preventDefault();
      setZoom(value => Math.min(8, Math.max(1, value * (event.deltaY < 0 ? 1.15 : 1 / 1.15))));
    };
    media.addEventListener("wheel", wheel, { passive: false });
    return () => media.removeEventListener("wheel", wheel);
  }, [playingLive]);
  useEffect(() => {
    let cancelled = false;
    let objectUrl = "";
    void createPreviewObjectUrl(item, () => cancelled).then(createdUrl => {
      if (!createdUrl) return;
      if (cancelled) URL.revokeObjectURL(createdUrl);
      else {
        objectUrl = createdUrl;
        if (initialUrl) URL.revokeObjectURL(initialUrl);
        setUrl(createdUrl);
      }
    }).catch(() => { if (!cancelled) setFailed(true); });
    return () => { cancelled = true; if (objectUrl) URL.revokeObjectURL(objectUrl); if (initialUrl) URL.revokeObjectURL(initialUrl); };
  }, [initialUrl, item]);
  useEffect(() => {
    if (!playingLive || !item.liveVideo || liveUrl) return;
    let cancelled = false;
    let objectUrl = "";
    void item.liveVideo.handle.getFile().then(file => {
      objectUrl = URL.createObjectURL(file);
      if (cancelled) URL.revokeObjectURL(objectUrl);
      else setLiveUrl(objectUrl);
    }).catch(() => { if (!cancelled) { setLiveFailed(true); setPlayingLive(false); } });
    return () => { cancelled = true; };
  }, [item.liveVideo, liveUrl, playingLive]);
  useEffect(() => () => { if (liveUrl) URL.revokeObjectURL(liveUrl); }, [liveUrl]);
  useEffect(() => {
    const keydown = (event: KeyboardEvent) => {
      if (document.querySelector("dialog[open]")) return;
      if (event.key === "Escape") onClose();
      if (event.key === "+" || event.key === "=") setZoom(value => Math.min(8, value * 1.25));
      if (event.key === "-") setZoom(value => Math.max(1, value / 1.25));
      if (event.key === "0") { setZoom(1); setPan({ x: 0, y: 0 }); }
      if (event.key === "ArrowLeft") previous();
      if (event.key === "ArrowRight") next();
    };
    window.addEventListener("keydown", keydown);
    return () => window.removeEventListener("keydown", keydown);
  }, [next, onClose, previous]);
  return <div className={styles.viewer} role="dialog" aria-modal="true" aria-label={item.name}>
    <button className={styles.viewerClose} onClick={onClose} aria-label="关闭">×</button>
    <button className={styles.viewerPrevious} onClick={previous} aria-label="上一张">‹</button>
    <figure><div ref={mediaRef} className={styles.viewerMedia} style={{ cursor: zoom > 1 && !playingLive ? "grab" : "default" }} onPointerDown={event => {
      if (zoom <= 1 || playingLive || (event.target as HTMLElement).closest("button,video")) return;
      dragRef.current = { x: event.clientX, y: event.clientY, panX: pan.x, panY: pan.y };
      event.currentTarget.setPointerCapture(event.pointerId);
    }} onPointerMove={event => { const drag = dragRef.current; if (drag) setPan({ x: drag.panX + event.clientX - drag.x, y: drag.panY + event.clientY - drag.y }); }} onPointerUp={() => { dragRef.current = null; }} onPointerCancel={() => { dragRef.current = null; }}>
      {playingLive && liveUrl ? <video src={liveUrl} controls autoPlay playsInline preload="metadata" aria-label={item.name + " 实况视频"} onError={() => { setLiveFailed(true); setPlayingLive(false); }} onEnded={() => setPlayingLive(false)} /> : url && !failed ? <img src={url} alt={item.name} draggable={false} style={{ transform: "translate(" + (zoom === 1 ? 0 : pan.x) + "px," + (zoom === 1 ? 0 : pan.y) + "px) scale(" + zoom + ")" }} onDoubleClick={() => { if (zoom > 1) fitImage(); else setZoom(2); }} onError={() => setFailed(true)} /> : <div className={styles.unsupported}><strong>{item.extension.toUpperCase()}</strong><span>{HEIC_PREVIEW_EXTENSIONS.has(item.extension) ? previewStatus(item.extension, failed) : "浏览器无法直接显示此原始格式，但文件仍已纳入图片库。"}</span></div>}
      {item.liveVideo && <button className={styles.liveToggle} onClick={() => { setLiveFailed(false); setPlayingLive(value => !value); }}>{playingLive ? liveUrl ? "显示照片" : "正在读取实况…" : "▶ 播放实况"}</button>}
      {liveFailed && <span className={styles.liveError}>实况视频无法播放，请检查 Windows HEVC 解码支持。</span>}
    </div><figcaption><strong title={item.path}>{item.name}</strong><span>{item.sourceName} · {item.extension.toUpperCase()} · {formatBytes(item.size)} · {formatDate(item.modified)}{item.liveVideo ? " · 实况 " + item.liveVideo.name : ""}</span></figcaption></figure>
    <button className={styles.viewerNext} onClick={next} aria-label="下一张">›</button>
    <aside className={styles.viewerSidebar} aria-label="图片操作">
      <h2>图片操作</h2><p>{item.name}</p>
      <section><h3>缩放</h3><div className={styles.zoomControls}><button disabled={playingLive || zoom <= 1} onClick={() => changeZoom(1 / 1.25)} aria-label="缩小">−</button><output>{Math.round(zoom * 100)}%</output><button disabled={playingLive || zoom >= 8} onClick={() => changeZoom(1.25)} aria-label="放大">＋</button></div><button disabled={playingLive} onClick={fitImage}>适应窗口</button><small>滚轮缩放 · 双击放大/复位 · 放大后拖动<br />键盘 + / − 缩放，0 复位</small></section>
      <section><h3>删除范围</h3><button disabled={releaseBusy} onClick={() => onDelete("local")}>仅删除本地</button><button disabled={releaseBusy || cloudLoading || !cloudAvailable} onClick={() => onDelete("icloud")}>仅删除 iCloud</button><button disabled={releaseBusy || cloudLoading || !cloudAvailable} onClick={() => onDelete("both")}>两边都删除</button><small>本地移入 Windows 回收站，云端移入“最近删除”。{item.liveVideo ? "包含配对实况视频。" : ""}</small><p className={styles.viewerCloudStatus}>{cloudLoading ? "正在读取云端匹配状态…" : cloudAvailable ? "此图片已完成精确云端匹配。" : cloudMessage}</p></section>
    </aside>
  </div>;
}

export default function PhotosPage() {
  return <AccountGate>{username => <PhotoLibrary key={username} username={username} />}</AccountGate>;
}

function PhotoLibrary({ username }: { username: string }) {
  const [sources, setSources] = useState<SourceFolder[]>([]);
  const [photos, setPhotos] = useState<PhotoItem[]>([]);
  const [ready, setReady] = useState(false);
  const [loading, setLoading] = useState(false);
  const [progress, setProgress] = useState(0);
  const [query, setQuery] = useState("");
  const [sourceFilter, setSourceFilter] = useState("all");
  const [formatFilter, setFormatFilter] = useState("all");
  const [tab, setTab] = useState<Tab>("all");
  const [sort, setSort] = useState<Sort>("newest");
  const [compact, setCompact] = useState(false);
  const [previewRatio, setPreviewRatio] = useState<PreviewRatio>("standard");
  const [preferencesReady, setPreferencesReady] = useState(false);
  const [page, setPage] = useState(1);
  const [viewerId, setViewerId] = useState<string | null>(null);
  const [icloudBackupDirectory, setIcloudBackupDirectory] = useState<string | null>(null);
  const [releaseCatalog, setReleaseCatalog] = useState<ReleaseCatalog | null>(null);
  const [releaseCatalogLoading, setReleaseCatalogLoading] = useState(false);
  const [releaseCatalogError, setReleaseCatalogError] = useState("");
  const [deleteItem, setDeleteItem] = useState<PhotoItem | null>(null);
  const [deleteMode, setDeleteMode] = useState<"local" | "icloud" | "both">("local");
  const deleteDialogRef = useRef<HTMLDialogElement>(null);
  const [releasingAsset, setReleasingAsset] = useState<string | null>(null);
  const [notice, setNotice] = useState("");
  const [error, setError] = useState("");

  useEffect(() => { localStorage.setItem(accountKey("framebase-last-library"), "photos"); }, []);

  useEffect(() => {
    let saved: Partial<PhotoPreferences> = {};
    try {
      const parsed = JSON.parse(localStorage.getItem(accountKey(PHOTO_PREFERENCES_KEY)) || "{}");
      if (parsed && typeof parsed === "object") saved = parsed as Partial<PhotoPreferences>;
    }
    catch { /* Invalid preferences fall back to the defaults. */ }
    queueMicrotask(() => {
      if (typeof saved.compact === "boolean") setCompact(saved.compact);
      if (saved.previewRatio === "standard" || saved.previewRatio === "phone") setPreviewRatio(saved.previewRatio);
      if (["newest", "oldest", "largest", "smallest", "name"].includes(saved.sort || "")) setSort(saved.sort as Sort);
      setPreferencesReady(true);
    });
  }, []);

  useEffect(() => {
    if (!preferencesReady) return;
    const preferences: PhotoPreferences = { compact, previewRatio, sort };
    localStorage.setItem(accountKey(PHOTO_PREFERENCES_KEY), JSON.stringify(preferences));
  }, [compact, preferencesReady, previewRatio, sort]);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const savedSources = await dbGet<SourceFolder[]>(SOURCES_KEY).catch(() => undefined) || [];
      const savedLibraries = await Promise.all(savedSources.map(source => dbGet<PhotoItem[]>(`photo-library:${source.id}`).catch(() => undefined)));
      if (cancelled) return;
      setSources(savedSources);
      setPhotos(savedLibraries.flatMap((items, index) => {
        const source = savedSources[index];
        const marks = readMarks(source.id);
        return (items || []).map(item => ({ ...item, liked: Boolean(marks[item.path]?.liked), cleanup: Boolean(marks[item.path]?.cleanup) }));
      }));
      setReady(true);
    })();
    return () => { cancelled = true; };
  }, []);

  const refreshReleaseCatalog = useCallback(async () => {
    setReleaseCatalogLoading(true);
    try {
      const response = await fetch("/api/icloud/release/catalog", { cache: "no-store" });
      if (!response.ok) throw new Error("无法读取云端释放计划，请刷新后重试。");
      setReleaseCatalog(await response.json() as ReleaseCatalog);
      setReleaseCatalogError("");
    } catch (reason) { setReleaseCatalogError(reason instanceof Error ? reason.message : "无法读取释放计划。"); }
    finally { setReleaseCatalogLoading(false); }
  }, []);

  useEffect(() => {
    void fetch("/api/icloud/config", { cache: "no-store" }).then(response => response.ok ? response.json() as Promise<{ backupDirectory?: string | null }> : null).then(config => setIcloudBackupDirectory(config?.backupDirectory || null)).catch(() => undefined);
    queueMicrotask(() => void refreshReleaseCatalog());
    const refresh = () => { void refreshReleaseCatalog(); };
    window.addEventListener("focus", refresh);
    return () => window.removeEventListener("focus", refresh);
  }, [refreshReleaseCatalog]);

  const cloudAssetFor = useCallback((item: PhotoItem) => findPhotoCloudAsset(item, releaseCatalog?.releasePlan, icloudBackupDirectory), [releaseCatalog, icloudBackupDirectory]);

  useEffect(() => {
    if (deleteItem && !deleteDialogRef.current?.open) deleteDialogRef.current?.showModal();
  }, [deleteItem]);

  async function removeRecycledPhoto(item: PhotoItem) {
    const nextPhotos = photos.filter(photo => photo.id !== item.id);
    const nextSources = sources.map(source => source.id === item.sourceId ? { ...source, photoCount: Math.max(0, source.photoCount - 1), totalSize: Math.max(0, source.totalSize - item.size) } : source);
    setPhotos(nextPhotos); setSources(nextSources);
    if (viewerId === item.id) setViewerId(null);
    await Promise.all([dbSet('photo-library:' + item.sourceId, nextPhotos.filter(photo => photo.sourceId === item.sourceId)), dbSet(SOURCES_KEY, nextSources)]);
  }

  async function recycleLocalPhoto(item: PhotoItem) {
    setReleasingAsset(item.id); setError(""); setNotice("");
    try {
      if (!window.confirm('将“' + item.name + '”' + (item.liveVideo ? '及其配对实况视频' : '') + '移入 Windows 回收站？iCloud 内容会保留。接下来请选择图片来源文件夹“' + item.sourceName + '”。')) return;
      const entries = [{ relativePath: item.path, handle: item.handle }, ...(item.liveVideo ? [{ relativePath: item.liveVideo.path, handle: item.liveVideo.handle }] : [])];
      const files = await Promise.all(entries.map(async entry => {
        const file = await entry.handle.getFile();
        const digest = await crypto.subtle.digest("SHA-256", await file.arrayBuffer());
        return { relativePath: entry.relativePath, size: file.size, sha256: Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, "0")).join("") };
      }));
      const response = await fetch("/api/photos/recycle", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ sourceName: item.sourceName, files, confirmation: "移入本地回收站" }) });
      const data = await response.json() as { cancelled?: boolean; recycleResult?: { status: string; message: string; results: Array<{ relativePath: string; status: string }> }; error?: string };
      if (data.cancelled) return;
      if (!response.ok || !data.recycleResult) throw new Error(data.error || "本地删除失败。");
      if (data.recycleResult.results.some(result => result.relativePath === item.path && result.status === "recycled")) await removeRecycledPhoto(item);
      else if (item.liveVideo && data.recycleResult.results.some(result => result.relativePath === item.liveVideo?.path && result.status === "recycled")) {
        const next = photos.map(photo => photo.id === item.id ? { ...photo, liveVideo: null } : photo);
        setPhotos(next); await dbSet('photo-library:' + item.sourceId, next.filter(photo => photo.sourceId === item.sourceId));
      }
      const catalogResponse = await fetch("/api/icloud/release/catalog", { cache: "no-store" }).catch(() => null);
      if (catalogResponse?.ok) setReleaseCatalog(await catalogResponse.json() as ReleaseCatalog);
      if (data.recycleResult.status === "recycled") setNotice(data.recycleResult.message + " iCloud 内容已保留。");
      else setError(data.recycleResult.message + " iCloud 内容已保留。");
    } catch (reason) { setError(reason instanceof Error ? reason.message : "本地删除失败。"); }
    finally { setReleasingAsset(null); }
  }

  async function deleteSelectedPhoto() {
    if (!deleteItem || releasingAsset !== null) return;
    const item = deleteItem;
    if (deleteMode === "local") await recycleLocalPhoto(item);
    else {
      const asset = cloudAssetFor(item);
      if (!asset) { setError("请先在 iCloud 备份中心完成释放计划复核和确认。"); return; }
      await releaseFromIcloud(item, asset, deleteMode === "both");
    }
    setDeleteItem(null);
  }

  async function releaseFromIcloud(item: PhotoItem, asset: IcloudAsset, recycleLocal: boolean) {
    const key = `${asset.library}:${asset.id}`;
    setReleasingAsset(key); setError(""); setNotice("");
    try {
      const previewResponse = await fetch("/api/icloud/release/delete/preview", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ planId: releaseCatalog?.releasePlan?.id, assetKeys: [key], recycleLocal }) });
      const preview = await previewResponse.json() as { releaseResult?: { status: string; bytes: number }; localRecyclePlan?: { fileCount: number; bytes: number }; error?: string };
      if (!previewResponse.ok || preview.releaseResult?.status !== "matched") throw new Error(preview.error || "云端项目复核失败，没有执行删除。");
      const localSummary = recycleLocal ? `同时将 ${preview.localRecyclePlan?.fileCount || 0} 个本地原文件（${formatBytes(preview.localRecyclePlan?.bytes || 0)}）移入 Windows 回收站。` : "本地备份会保留。";
      const confirmation = window.prompt(`已精确匹配“${item.name}”。云端项目将移入“最近删除”，预计 ${formatBytes(asset.originalBytes)}。${localSummary}\n\n请输入“移入最近删除”继续：`, "");
      if (confirmation === null) return;
      if (confirmation !== "移入最近删除") throw new Error("确认文字不正确，没有执行删除。");
      const response = await fetch("/api/icloud/release/delete", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ planId: releaseCatalog?.releasePlan?.id, assetKeys: [key], confirmation, recycleLocal }) });
      const data = await response.json() as { releaseResult?: { status: string; message: string; bytes: number }; recycleResult?: { status: string; message: string; results: Array<{ relativePath: string; status: string }> }; releaseHistory?: ReleaseCatalog["releaseHistory"]; timeline?: ReleaseCatalog["timeline"]; error?: string };
      if (!response.ok || data.releaseResult?.status !== "deleted") throw new Error(data.error || data.releaseResult?.message || "iCloud 删除失败。");
      setReleaseCatalog(current => current ? { ...current, releasePlan: current.releasePlan ? { ...current.releasePlan, assets: current.releasePlan.assets.filter(candidate => `${candidate.library}:${candidate.id}` !== key) } : null, releaseHistory: data.releaseHistory || current.releaseHistory, timeline: data.timeline || current.timeline } : current);
      if (data.recycleResult?.results?.some(result => result.status === "recycled" && result.relativePath.replaceAll("\\", "/").split("/").pop()?.toLowerCase() === item.name.toLowerCase())) {
        await removeRecycledPhoto(item);
      }
      if (data.recycleResult && data.recycleResult.status !== "recycled") setError("iCloud 删除已成功。" + data.recycleResult.message);
      setNotice(data.recycleResult ? `“${item.name}”已移入 iCloud“最近删除”。${data.recycleResult.message}` : `“${item.name}”已移入 iCloud“最近删除”，本地文件未删除。预计可释放 ${formatBytes(asset.originalBytes)}；彻底释放需清空“最近删除”。`);
    } catch (reason) { setError(reason instanceof Error ? reason.message : "iCloud 删除失败。"); }
    finally { setReleasingAsset(null); }
  }

  const persistMarks = useCallback((items: PhotoItem[], sourceId: string) => {
    const marks = Object.fromEntries(items.filter(item => item.sourceId === sourceId).map(item => [item.path, { liked: item.liked, cleanup: item.cleanup }]));
    localStorage.setItem(marksKey(sourceId), JSON.stringify(marks));
  }, []);

  const loadSource = useCallback(async (source: SourceFolder, knownSources?: SourceFolder[]) => {
    setLoading(true); setProgress(0); setError(""); setNotice("");
    try {
      const current = await source.handle.queryPermission?.({ mode: "read" });
      const permission = current === "granted" ? current : await source.handle.requestPermission?.({ mode: "read" });
      if (permission !== "granted") throw new Error(`需要“${source.name}”的读取权限。`);
      const found = await scanDirectory(source, setProgress);
      const updatedSource = { ...source, lastScan: Date.now(), photoCount: found.length, totalSize: found.reduce((sum, item) => sum + item.size, 0) };
      const baseSources = knownSources || sources;
      const nextSources = baseSources.some(item => item.id === source.id)
        ? baseSources.map(item => item.id === source.id ? updatedSource : item)
        : [...baseSources, updatedSource];
      setSources(nextSources);
      setPhotos(currentPhotos => [...currentPhotos.filter(item => item.sourceId !== source.id), ...found]);
      await Promise.all([dbSet(SOURCES_KEY, nextSources), dbSet(`photo-library:${source.id}`, found)]);
      setNotice(`“${source.name}”已扫描，共 ${found.length} 张图片。`);
    } catch (reason) { setError(reason instanceof Error ? reason.message : "图片扫描失败。"); }
    finally { setLoading(false); }
  }, [sources]);

  async function chooseFolder() {
    if (!(window as PickerWindow).showDirectoryPicker) { setError("当前浏览器不支持文件夹访问，请使用最新版 Chrome 或 Edge。"); return; }
    try {
      const handle = await (window as PickerWindow).showDirectoryPicker!({ mode: "read" });
      let existing: SourceFolder | undefined;
      for (const source of sources) if (source.handle.isSameEntry && await source.handle.isSameEntry(handle)) { existing = source; break; }
      const source = existing || { id: crypto.randomUUID(), name: handle.name, handle, lastScan: 0, photoCount: 0, totalSize: 0 };
      if (!existing) {
        const next = [...sources, source];
        setSources(next);
        await dbSet(SOURCES_KEY, next);
        await loadSource(source, next);
        return;
      }
      await loadSource(source);
    } catch (reason) { if ((reason as DOMException)?.name !== "AbortError") setError("未能打开文件夹，请确认已授予读取权限。"); }
  }

  async function removeSource(source: SourceFolder) {
    const nextSources = sources.filter(item => item.id !== source.id);
    setSources(nextSources);
    setPhotos(current => current.filter(item => item.sourceId !== source.id));
    await Promise.all([dbSet(SOURCES_KEY, nextSources), dbDelete(`photo-library:${source.id}`)]);
    localStorage.removeItem(marksKey(source.id));
    if (sourceFilter === source.id) setSourceFilter("all");
    setNotice(`已从图片库移除“${source.name}”，源文件没有被删除。`);
  }

  function toggleMark(id: string, key: "liked" | "cleanup") {
    setPhotos(current => {
      const next = current.map(item => item.id === id ? { ...item, [key]: !item[key] } : item);
      const changed = next.find(item => item.id === id);
      if (changed) persistMarks(next, changed.sourceId);
      return next;
    });
  }

  const formats = useMemo(() => [...new Set(photos.map(item => item.extension))].sort(), [photos]);
  const filtered = useMemo(() => {
    const normalized = query.trim().toLocaleLowerCase("zh-CN");
    const result = photos.filter(item => {
      if (sourceFilter !== "all" && item.sourceId !== sourceFilter) return false;
      if (formatFilter !== "all" && item.extension !== formatFilter) return false;
      if (tab === "live" && !item.liveVideo) return false;
      if (tab === "liked" && !item.liked) return false;
      if (tab === "cleanup" && !item.cleanup) return false;
      return !normalized || `${item.name} ${item.path}`.toLocaleLowerCase("zh-CN").includes(normalized);
    });
    return result.sort((left, right) => sort === "oldest" ? left.modified - right.modified : sort === "largest" ? right.size - left.size : sort === "smallest" ? left.size - right.size : sort === "name" ? left.name.localeCompare(right.name, "zh-CN") : right.modified - left.modified);
  }, [formatFilter, photos, query, sort, sourceFilter, tab]);
  const pageCount = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
  const currentPage = Math.min(page, pageCount);
  const visible = filtered.slice((currentPage - 1) * PAGE_SIZE, currentPage * PAGE_SIZE);
  const viewerIndex = viewerId ? filtered.findIndex(item => item.id === viewerId) : -1;
  const viewer = viewerIndex >= 0 ? filtered[viewerIndex] : null;
  const moveViewer = useCallback((direction: -1 | 1) => {
    if (!filtered.length || viewerIndex < 0) return;
    setViewerId(filtered[(viewerIndex + direction + filtered.length) % filtered.length].id);
  }, [filtered, viewerIndex]);
  const totalSize = photos.reduce((sum, item) => sum + item.size, 0);

  return <main className={styles.page}>
    <header className={styles.topbar}>
      <a href="/?library=video"><span>F</span>Framebase</a>
      <label><span>⌕</span><input value={query} onChange={event => { setQuery(event.target.value); setPage(1); }} placeholder="搜索图片名称或路径…" aria-label="搜索图片" /></label>
      <nav className="media-header-actions"><a className="media-header-button" href="/?library=video">视频库</a><a className="media-header-button" href="/icloud">iCloud 备份</a><a className="media-header-button" href="/lan">局域网</a><b className="media-account">{username}</b><button className="media-logout" onClick={() => void signOut()}>退出</button><ThemeSelector /></nav>
    </header>
    {error && <div className={styles.error} role="alert">{error}<button onClick={() => setError("")}>×</button></div>}
    {notice && <div className={styles.notice} role="status">{notice}<button onClick={() => setNotice("")}>×</button></div>}
    <section className={styles.hero}><div><p>独立图片库</p><h1>图片浏览与整理</h1><span>图片来源、索引和标记与原视频库彻底隔离；移除来源不会删除文件。</span></div><button onClick={() => void chooseFolder()} disabled={loading}>{loading ? `正在扫描 ${progress} 张…` : "添加图片文件夹"}</button></section>
    {icloudBackupDirectory && <aside className={styles.icloudHint}><div><strong>iCloud 照片与视频备份目录</strong><span>{icloudBackupDirectory}</span></div><p>{releaseCatalog?.releaseHistory.movedCount ? `云端已移入“最近删除” ${releaseCatalog.releaseHistory.movedCount} 个项目，预计 ${formatBytes(releaseCatalog.releaseHistory.movedBytes)}；本地已回收 ${releaseCatalog.releaseHistory.recycledFileCount || 0} 个文件，共 ${formatBytes(releaseCatalog.releaseHistory.recycledBytes || 0)}。` : "可将这个目录同时添加到图片库和视频库；两套标记和索引互不影响。"}</p></aside>}
    {releaseCatalog?.timeline.staleAt && <aside className={styles.timelineStale}><strong>iCloud 统计需要确认</strong><span>{releaseCatalog.timeline.staleReason || "云端内容已变化，请到 iCloud 备份中心重新统计。"}</span><a href="/icloud">立即重新统计</a></aside>}
    <section className={styles.stats}><div><span>图片</span><strong>{photos.length}</strong></div><div><span>来源</span><strong>{sources.length}</strong></div><div><span>收藏</span><strong>{photos.filter(item => item.liked).length}</strong></div><div><span>占用</span><strong>{formatBytes(totalSize)}</strong></div></section>
    <section className={styles.sources} aria-label="图片来源">
      {sources.length === 0 && ready ? <p>尚未添加图片文件夹。这里不会读取视频库已经选择的目录。</p> : sources.map(source => <article key={source.id}><button onClick={() => { setSourceFilter(source.id); setPage(1); }} className={sourceFilter === source.id ? styles.activeSource : ""}><strong>{source.name}</strong><span>{source.photoCount} 张 · {formatBytes(source.totalSize)}</span></button><button onClick={() => void loadSource(source)} disabled={loading}>重扫</button><button onClick={() => void removeSource(source)} disabled={loading}>移除</button></article>)}
    </section>
    <section className={styles.toolbar}>
      <div><button className={tab === "all" ? styles.active : ""} onClick={() => { setTab("all"); setPage(1); }}>全部</button><button className={tab === "live" ? styles.active : ""} onClick={() => { setTab("live"); setPage(1); }}>实况</button><button className={tab === "liked" ? styles.active : ""} onClick={() => { setTab("liked"); setPage(1); }}>收藏</button><button className={tab === "cleanup" ? styles.active : ""} onClick={() => { setTab("cleanup"); setPage(1); }}>待整理</button></div>
      <div><select value={sourceFilter} onChange={event => { setSourceFilter(event.target.value); setPage(1); }} aria-label="来源"><option value="all">全部来源</option>{sources.map(source => <option value={source.id} key={source.id}>{source.name}</option>)}</select><select value={formatFilter} onChange={event => { setFormatFilter(event.target.value); setPage(1); }} aria-label="格式"><option value="all">全部格式</option>{formats.map(format => <option value={format} key={format}>{format.toUpperCase()}</option>)}</select><select value={sort} onChange={event => { setSort(event.target.value as Sort); setPage(1); }} aria-label="排序"><option value="newest">最新优先</option><option value="oldest">最早优先</option><option value="largest">最大优先</option><option value="smallest">最小优先</option><option value="name">按名称</option></select><select value={previewRatio} onChange={event => setPreviewRatio(event.target.value as PreviewRatio)} aria-label="预览比例"><option value="standard">标准比例</option><option value="phone">手机比例 9:16</option></select><button onClick={() => setCompact(value => !value)}>{compact ? "舒适视图" : "紧凑视图"}</button></div>
    </section>
    <section className={styles.libraryHead}><p>显示 <strong>{filtered.length}</strong> 张图片</p>{pageCount > 1 && <div><button disabled={currentPage === 1} onClick={() => setPage(value => Math.max(1, value - 1))}>上一页</button><span>{currentPage} / {pageCount}</span><button disabled={currentPage === pageCount} onClick={() => setPage(value => Math.min(pageCount, value + 1))}>下一页</button></div>}</section>
    {visible.length ? <section className={`${styles.grid} ${compact ? styles.compact : ""} ${previewRatio === "phone" ? styles.phoneRatio : ""}`}>{visible.map(item => { return <article className={styles.card} key={item.id}><div className={styles.preview}><PhotoThumb item={item} onOpen={() => { setViewerId(item.id); void refreshReleaseCatalog(); }} />{item.liveVideo && <span className={styles.liveBadge} title={`配对视频：${item.liveVideo.name}`}>● 实况</span>}<nav className={styles.cardActions}><button title="删除这张图片：仅本地、仅 iCloud 或两边都删除" aria-label="删除这张图片" className={styles.cloudRelease} disabled={releasingAsset !== null} onClick={() => { setDeleteMode("local"); setDeleteItem(item); void refreshReleaseCatalog(); }}>⌫</button><button title={item.liked ? "取消收藏" : "收藏"} aria-label={item.liked ? "取消收藏" : "收藏"} className={item.liked ? styles.marked : ""} onClick={() => toggleMark(item.id, "liked")}>{item.liked ? "♥" : "♡"}</button><button title={item.cleanup ? "移出待整理" : "加入待整理"} aria-label={item.cleanup ? "移出待整理" : "加入待整理"} className={item.cleanup ? styles.cleanupMarked : ""} onClick={() => toggleMark(item.id, "cleanup")}>{item.cleanup ? "✓" : "⌁"}</button></nav></div><div className={styles.cardMeta}><h2 title={item.path}>{item.name}</h2><p title={`${item.sourceName} · ${item.extension.toUpperCase()} · ${formatBytes(item.size)} · ${formatDate(item.modified)}`}><span>{item.sourceName}</span> · {item.extension.toUpperCase()} · {formatBytes(item.size)} · {formatDate(item.modified)}</p></div></article>; })}</section> : <section className={styles.empty}><strong>{ready ? "没有符合条件的图片" : "正在读取图片库…"}</strong><span>{sources.length ? "可以调整筛选条件或重新扫描来源。" : "点击“添加图片文件夹”开始建立独立图片库。"}</span></section>}
    <footer><span>图片来源来自你授权的本地文件夹；删除前需单独确认</span><a href="/?library=video">返回视频库 →</a></footer>
    {deleteItem && <dialog ref={deleteDialogRef} className={styles.deleteDialog} aria-labelledby="delete-photo-title" onCancel={event => { if (releasingAsset !== null) event.preventDefault(); else setDeleteItem(null); }}>
      <h2 id="delete-photo-title">删除这张图片</h2><p>{deleteItem.name}{deleteItem.liveVideo ? " · 包含配对实况视频" : ""}</p>
      <fieldset disabled={releasingAsset !== null}>
        <legend>选择删除范围</legend>
        <label htmlFor="photo-delete-local" aria-label="仅删除本地"><input id="photo-delete-local" type="radio" name="photo-delete-mode" checked={deleteMode === "local"} onChange={() => setDeleteMode("local")} /><span><strong>仅删除本地</strong><small>移入 Windows 回收站，保留 iCloud 内容。</small></span></label>
        <label htmlFor="photo-delete-icloud" aria-label="仅删除 iCloud"><input id="photo-delete-icloud" type="radio" name="photo-delete-mode" checked={deleteMode === "icloud"} disabled={releaseCatalogLoading || Boolean(releaseCatalogError) || !cloudAssetFor(deleteItem)} onChange={() => setDeleteMode("icloud")} /><span><strong>仅删除 iCloud</strong><small>移入 iCloud“最近删除”，保留本地原片。</small></span></label>
        <label htmlFor="photo-delete-both" aria-label="两边都删除"><input id="photo-delete-both" type="radio" name="photo-delete-mode" checked={deleteMode === "both"} disabled={releaseCatalogLoading || Boolean(releaseCatalogError) || !cloudAssetFor(deleteItem)} onChange={() => setDeleteMode("both")} /><span><strong>两边都删除</strong><small>云端成功移入“最近删除”后，再将本地原片移入回收站。</small></span></label>
      </fieldset>
      {releaseCatalogLoading ? <p>正在刷新云端释放计划…</p> : releaseCatalogError ? <p>{releaseCatalogError}</p> : !cloudAssetFor(deleteItem) && <p>{releaseCatalog?.releasePlan?.status === "confirmed" ? "释放计划已确认，但此图片未能唯一匹配计划中的云端项目。请确认图片来源和本地文件大小，或重新生成释放计划。" : "请到 iCloud 备份中心复核并确认释放计划后，再操作 iCloud。"}</p>}
      <div><button disabled={releasingAsset !== null} onClick={() => setDeleteItem(null)}>取消</button><button disabled={releasingAsset !== null || (deleteMode !== "local" && (releaseCatalogLoading || Boolean(releaseCatalogError) || !cloudAssetFor(deleteItem)))} onClick={() => void deleteSelectedPhoto()}>{releasingAsset !== null ? "正在处理…" : "继续"}</button></div>
    </dialog>}
    {viewer && <PhotoViewer key={viewer.id} item={viewer} previous={() => moveViewer(-1)} next={() => moveViewer(1)} onClose={() => setViewerId(null)} onDelete={mode => { setDeleteMode(mode); setDeleteItem(viewer); void refreshReleaseCatalog(); }} cloudAvailable={Boolean(cloudAssetFor(viewer)) && !releaseCatalogError} cloudLoading={releaseCatalogLoading} releaseBusy={releasingAsset !== null} cloudMessage={releaseCatalogError || (releaseCatalog?.releasePlan?.status === "confirmed" ? "此图片未能唯一匹配已确认计划中的云端项目。" : "请先到 iCloud 备份中心生成计划并启用逐项删除。")} />}
  </main>;
}
