"use client";

/* eslint-disable @next/next/no-img-element, @next/next/no-html-link-for-pages, jsx-a11y/media-has-caption -- previews use local Blob URLs; Live Photo MOV files contain no caption track; hard navigation avoids losing File System Access state. */

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import AccountGate, { signOut } from "../account-gate";
import { accountDbName, accountKey } from "../account-storage";
import ThemeSelector from "../theme-selector";
import PhotoActionsMenu from "./photo-actions-menu";
import AppleSessionControls from "../apple-session-controls";
import styles from "./photos.module.css";
import actionStyles from "../media-actions.module.css";
import { collectCloudSelection, MAX_PHOTO_SELECTION } from "./bulk-selection";
import { viewerAfterRemoval } from "./viewer-navigation";
import { decodeHeicPreview } from "./heic-preview";
import type { HeicPreviewOptions } from "./heic-codec";
import { schedulePreview, setPreviewScrolling, type PreviewQueue } from "./preview-queue";
import { findPhotoCloudAsset } from "./cloud-match";
import { photoTimeKeys, timePeriodLabel, matchesPhotoTime, type TimeGranularity } from "./time-filter";
import { CloudDeleteProgress, waitForCloudDelete, type CloudDeleteJob } from "../icloud-delete-progress";

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
type DeleteJob = CloudDeleteJob & { result?: { localRecyclePlan?: { fileCount: number; bytes: number }; releaseResult?: { status: string; message: string; bytes: number; results?: Array<{ id: string; library: string; status: string; alreadyDeleted?: boolean }> }; recycleResult?: { status: string; message: string; results: Array<{ relativePath: string; status: string }> }; releaseHistory?: ReleaseCatalog["releaseHistory"]; timeline?: ReleaseCatalog["timeline"] } };

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
type ThumbnailManifest = { entries: Array<{ key: string; size: number }>; totalSize: number };
const regularPreviewQueue: PreviewQueue = { pending: [], active: 0, limit: 2 };
const heicPreviewQueue: PreviewQueue = { pending: [], active: 0, limit: 1 };
const thumbnailBlobCache = new Map<string, Blob>();
const fullHeicPreviewCache = new Map<string, Blob>();
const FULL_HEIC_PREVIEW_CACHE_BYTES = 32 * 1024 * 1024;
let thumbnailPersistence = Promise.resolve();

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
      return await decodeModernHeic(file);
    } catch {
      return convertLegacyHeic(file);
    }
  }
  if (BROWSER_PREVIEW_EXTENSIONS.has(item.extension)) return file;
  return null;
}

async function convertLegacyHeic(file: Blob) {
  const { default: heic2any } = await import("heic2any");
  const converted = await heic2any({ blob: file, toType: "image/jpeg", quality: 0.86 });
  return Array.isArray(converted) ? converted[0] : converted;
}

async function decodeModernHeic(file: Blob, options: HeicPreviewOptions = {}) {
  return decodeHeicPreview(file, options);
}

async function createPreviewObjectUrl(item: PhotoItem, cancelled: () => boolean) {
  const key = `${accountDbName()}:${thumbnailCacheKey(item)}`;
  const ready = HEIC_PREVIEW_EXTENSIONS.has(item.extension) ? fullHeicPreviewCache.get(key) : null;
  if (ready) { fullHeicPreviewCache.delete(key); fullHeicPreviewCache.set(key, ready); return URL.createObjectURL(ready); }
  const blob = HEIC_PREVIEW_EXTENSIONS.has(item.extension)
    ? await schedulePreview(heicPreviewQueue, async () => {
      const cached = fullHeicPreviewCache.get(key);
      if (cached) { fullHeicPreviewCache.delete(key); fullHeicPreviewCache.set(key, cached); return cached; }
      const created = await createPreviewBlob(item);
      if (created && created.size <= FULL_HEIC_PREVIEW_CACHE_BYTES) {
        fullHeicPreviewCache.set(key, created);
        let bytes = [...fullHeicPreviewCache.values()].reduce((total, entry) => total + entry.size, 0);
        while (fullHeicPreviewCache.size > 4 || bytes > FULL_HEIC_PREVIEW_CACHE_BYTES) {
          const oldest = fullHeicPreviewCache.keys().next().value!;
          bytes -= fullHeicPreviewCache.get(oldest)!.size; fullHeicPreviewCache.delete(oldest);
        }
      }
      return created;
    }, cancelled, true)
    : await createPreviewBlob(item);
  return blob ? URL.createObjectURL(blob) : null;
}

async function createThumbnailBlob(item: PhotoItem) {
    let blob: Blob | null;
    if (HEIC_PREVIEW_EXTENSIONS.has(item.extension)) {
      const file = await item.handle.getFile();
      try { return await decodeModernHeic(file, { width: THUMBNAIL_WIDTH, type: "image/webp", quality: THUMBNAIL_WEBP_QUALITY }); }
      catch { blob = await convertLegacyHeic(file); }
    } else blob = await createPreviewBlob(item);
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
    const cached = readThumbnailCache(item);
    if (cached) return cached;
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
    }, { rootMargin: "250px 0px" });
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

function PhotoViewer({ item, previous, next, onClose, onDelete, onFavorite, onCleanup, cloudAvailable, cloudLoading, cloudMessage, releaseBusy, taskNotice = "" }: { item: PhotoItem; previous: () => void; next: () => void; onClose: () => void; onDelete: (mode: "local" | "icloud" | "both") => void; onFavorite: () => void; onCleanup: () => void; cloudAvailable: boolean; cloudLoading: boolean; cloudMessage: string; releaseBusy: boolean; taskNotice?: string }) {
  const [previewItem] = useState(item);
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
  const [rotation, setRotation] = useState(0);
  const [imageSize, setImageSize] = useState({ width: 0, height: 0 });
  const [viewportSize, setViewportSize] = useState({ width: 0, height: 0 });
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const mediaRef = useRef<HTMLDivElement>(null);
  const dragRef = useRef<{ x: number; y: number; panX: number; panY: number } | null>(null);
  const changeZoom = (factor: number) => setZoom(value => Math.min(8, Math.max(1, value * factor)));
  const fitImage = () => { setZoom(1); setPan({ x: 0, y: 0 }); };
  const rotateImage = (direction: number) => { setRotation(value => (value + direction + 360) % 360); setPan({ x: 0, y: 0 }); };
  const rotatedFit = rotation % 180 !== 0 && imageSize.width && imageSize.height && viewportSize.width && viewportSize.height
    ? Math.min(viewportSize.width / imageSize.height, viewportSize.height / imageSize.width) / Math.min(viewportSize.width / imageSize.width, viewportSize.height / imageSize.height)
    : 1;
  useEffect(() => {
    const media = mediaRef.current;
    if (!media) return;
    const observer = new ResizeObserver(entries => { const box = entries[0].contentRect; setViewportSize({ width: box.width, height: box.height }); });
    observer.observe(media);
    return () => observer.disconnect();
  }, []);
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
    void createPreviewObjectUrl(previewItem, () => cancelled).then(createdUrl => {
      if (!createdUrl) return;
      if (cancelled) URL.revokeObjectURL(createdUrl);
      else {
        objectUrl = createdUrl;
        if (initialUrl) URL.revokeObjectURL(initialUrl);
        setUrl(createdUrl);
      }
    }).catch(() => { if (!cancelled) setFailed(true); });
    return () => { cancelled = true; if (objectUrl) URL.revokeObjectURL(objectUrl); if (initialUrl) URL.revokeObjectURL(initialUrl); };
  }, [initialUrl, previewItem]);
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
      const target = event.target;
      if (document.querySelector("dialog:modal") || (target instanceof HTMLElement && target.closest('dialog,input,select,textarea,summary,[contenteditable="true"]'))) return;
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
      {playingLive && liveUrl ? <video src={liveUrl} controls autoPlay playsInline preload="metadata" aria-label={item.name + " 实况视频"} onError={() => { setLiveFailed(true); setPlayingLive(false); }} onEnded={() => setPlayingLive(false)} /> : url && !failed ? <img src={url} alt={item.name} draggable={false} style={{ transform: `translate(${zoom === 1 ? 0 : pan.x}px,${zoom === 1 ? 0 : pan.y}px) scale(${zoom * rotatedFit}) rotate(${rotation}deg)` }} onLoad={event => setImageSize({ width: event.currentTarget.naturalWidth, height: event.currentTarget.naturalHeight })} onDoubleClick={() => { if (zoom > 1) fitImage(); else setZoom(2); }} onError={() => setFailed(true)} /> : <div className={styles.unsupported}><strong>{item.extension.toUpperCase()}</strong><span>{HEIC_PREVIEW_EXTENSIONS.has(item.extension) ? previewStatus(item.extension, failed) : "浏览器无法直接显示此原始格式，但文件仍已纳入图片库。"}</span></div>}
      {item.liveVideo && <button className={styles.liveToggle} onClick={() => { setLiveFailed(false); setPlayingLive(value => !value); }}>{playingLive ? liveUrl ? "显示照片" : "正在读取实况…" : "▶ 播放实况"}</button>}
      {liveFailed && <span className={styles.liveError}>实况视频无法播放，请检查 Windows HEVC 解码支持。</span>}
    </div><figcaption><strong title={item.path}>{item.name}</strong><span>{item.sourceName} · {item.extension.toUpperCase()} · {formatBytes(item.size)} · {formatDate(item.modified)}{item.liveVideo ? " · 实况 " + item.liveVideo.name : ""}</span>{taskNotice && <p className={styles.viewerTaskNotice} role="status">{taskNotice}</p>}</figcaption></figure>
    <button className={styles.viewerNext} onClick={next} aria-label="下一张">›</button>
    <aside className={styles.viewerSidebar} aria-label="图片操作">
      <h2>图片操作</h2><p>{item.name}</p>
      <section><h3>收藏与整理</h3><button aria-pressed={item.liked} className={item.liked ? styles.viewerMarked : ""} onClick={onFavorite}>{item.liked ? "♥ 已收藏 · 取消收藏" : "♡ 收藏图片"}</button><button aria-pressed={item.cleanup} className={item.cleanup ? styles.viewerMarked : ""} onClick={onCleanup}>{item.cleanup ? "✓ 已加入待整理 · 移除" : "加入待整理"}</button></section>
      <section><h3>旋转</h3><div className={styles.rotationControls}><button disabled={playingLive || !url || failed} onClick={() => rotateImage(-90)} aria-label="向左旋转 90 度">↶ 向左</button><button disabled={playingLive || !url || failed} onClick={() => rotateImage(90)} aria-label="向右旋转 90 度">↷ 向右</button></div><button disabled={playingLive || rotation === 0} onClick={() => { setRotation(0); fitImage(); }}>复位方向</button><small>仅调整本次查看方向</small></section>
      <section><h3>缩放</h3><div className={styles.zoomControls}><button disabled={playingLive || zoom <= 1} onClick={() => changeZoom(1 / 1.25)} aria-label="缩小">−</button><output>{Math.round(zoom * 100)}%</output><button disabled={playingLive || zoom >= 8} onClick={() => changeZoom(1.25)} aria-label="放大">＋</button></div><button disabled={playingLive} onClick={fitImage}>适应窗口</button><small>滚轮缩放 · 双击放大/复位 · 放大后拖动<br />键盘 + / − 缩放，0 复位</small></section>
      <section><h3>删除范围</h3><button disabled={releaseBusy} onClick={() => onDelete("local")}>仅删除本地</button><button disabled={releaseBusy || cloudLoading || !cloudAvailable} onClick={() => onDelete("icloud")}>仅删除 iCloud</button><button disabled={releaseBusy || cloudLoading || !cloudAvailable} onClick={() => onDelete("both")}>两边都删除</button><small>本地移入 Windows 回收站，云端移入“最近删除”。{item.liveVideo ? "包含配对实况视频。" : ""}</small><p className={styles.viewerCloudStatus}>{cloudLoading ? "正在读取云端匹配状态…" : cloudAvailable ? "此图片已完成精确云端匹配。" : cloudMessage}</p></section>
    </aside>
  </div>;
}

export default function PhotosPage() {
  return <AccountGate>{username => <PhotoLibrary key={username} username={username} />}</AccountGate>;
}

function PhotoPageJump({ page, pageCount, onChange }: { page: number; pageCount: number; onChange: (page: number) => void }) {
  return <form className={styles.pageJump} onSubmit={event => {
    event.preventDefault();
    const input = event.currentTarget.elements.namedItem("page") as HTMLInputElement;
    const nextPage = input.valueAsNumber;
    if (Number.isInteger(nextPage) && nextPage >= 1 && nextPage <= pageCount) onChange(nextPage);
  }}>
    <label>跳至 <input key={`${page}:${pageCount}`} name="page" type="number" min={1} max={pageCount} step={1} required defaultValue={page} aria-label="跳转到指定页码" /> 页</label>
    <button className={actionStyles.button} type="submit">跳转</button>
  </form>;
}

function PhotoLibrary({ username }: { username: string }) {
  useEffect(() => {
    let resumeTimer: ReturnType<typeof setTimeout>;
    const pausePreviews = () => {
      setPreviewScrolling(true);
      clearTimeout(resumeTimer);
      resumeTimer = setTimeout(() => setPreviewScrolling(false), 180);
    };
    window.addEventListener("scroll", pausePreviews, { passive: true, capture: true });
    window.addEventListener("wheel", pausePreviews, { passive: true });
    window.addEventListener("touchmove", pausePreviews, { passive: true });
    return () => {
      clearTimeout(resumeTimer);
      window.removeEventListener("scroll", pausePreviews, true);
      window.removeEventListener("wheel", pausePreviews);
      window.removeEventListener("touchmove", pausePreviews);
      setPreviewScrolling(false);
    };
  }, []);
  const [sources, setSources] = useState<SourceFolder[]>([]);
  const [photos, setPhotos] = useState<PhotoItem[]>([]);
  const libraryStateRef = useRef({ photos, sources, filtered: [] as PhotoItem[] });
  const [ready, setReady] = useState(false);
  const [loading, setLoading] = useState(false);
  const [progress, setProgress] = useState(0);
  const [query, setQuery] = useState("");
  const [sourceFilter, setSourceFilter] = useState("all");
  const [formatFilter, setFormatFilter] = useState("all");
  const [timeGranularity, setTimeGranularity] = useState<TimeGranularity>("years");
  const [selectedTimePeriods, setSelectedTimePeriods] = useState<string[]>([]);
  const [tab, setTab] = useState<Tab>("all");
  const [sort, setSort] = useState<Sort>("newest");
  const [compact, setCompact] = useState(false);
  const [previewRatio, setPreviewRatio] = useState<PreviewRatio>("standard");
  const [preferencesReady, setPreferencesReady] = useState(false);
  const [page, setPage] = useState(1);
  const paginationRef = useRef<HTMLDivElement>(null);
  const [paginationVisible, setPaginationVisible] = useState(true);
  const [viewerId, setViewerId] = useState<string | null>(null);
  const [icloudBackupDirectory, setIcloudBackupDirectory] = useState<string | null>(null);
  const [releaseCatalog, setReleaseCatalog] = useState<ReleaseCatalog | null>(null);
  const [releaseCatalogLoading, setReleaseCatalogLoading] = useState(false);
  const [releaseCatalogError, setReleaseCatalogError] = useState("");
  const [appleSessionBusy, setAppleSessionBusy] = useState(false);
  const [selectionMode, setSelectionMode] = useState(false);
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [bulkDeleteItems, setBulkDeleteItems] = useState<PhotoItem[]>([]);
  const [batchLocalProgress, setBatchLocalProgress] = useState<{ total: number; checked: number; recycled: number; message: string } | null>(null);
  const [deleteItem, setDeleteItem] = useState<PhotoItem | null>(null);
  const [deleteMode, setDeleteMode] = useState<"local" | "icloud" | "both">("local");
  const deleteDialogRef = useRef<HTMLDialogElement>(null);
  const [deleteMinimized, setDeleteMinimized] = useState(false);
  const [deleteFinished, setDeleteFinished] = useState(false);
  const [deleteConfirmation, setDeleteConfirmation] = useState<string | null>(null);
  const deleteConfirmationResolver = useRef<((confirmed: boolean) => void) | null>(null);
  const confirmationCancelRef = useRef<HTMLButtonElement>(null);
  const [deleteJob, setDeleteJob] = useState<DeleteJob | null>(null);
  const [deleteElapsed, setDeleteElapsed] = useState(0);
  const deletePollAbort = useRef<AbortController | null>(null);
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

  const handleSessionVerified = useCallback(() => {
    setError("");
    setNotice("Apple 会话与照片图库验证通过，可以重新复核所选图片。");
    setDeleteJob(current => current?.status === "failed" && current.result?.releaseResult?.status === "needs_auth" ? null : current);
    void refreshReleaseCatalog();
  }, [refreshReleaseCatalog]);

  useEffect(() => {
    void fetch("/api/icloud/config", { cache: "no-store" }).then(response => response.ok ? response.json() as Promise<{ backupDirectory?: string | null }> : null).then(config => setIcloudBackupDirectory(config?.backupDirectory || null)).catch(() => undefined);
    queueMicrotask(() => void refreshReleaseCatalog());
    const refresh = () => { void refreshReleaseCatalog(); };
    window.addEventListener("focus", refresh);
    return () => window.removeEventListener("focus", refresh);
  }, [refreshReleaseCatalog]);

  const cloudAssetFor = useCallback((item: PhotoItem) => findPhotoCloudAsset(item, releaseCatalog?.releasePlan, icloudBackupDirectory), [releaseCatalog, icloudBackupDirectory]);

  useEffect(() => {
    const dialog = deleteDialogRef.current;
    if (!dialog || (!deleteItem && !bulkDeleteItems.length)) return;
    if (dialog.open) dialog.close();
    if (deleteMinimized) dialog.show();
    else dialog.showModal();
  }, [deleteItem, bulkDeleteItems, deleteMinimized]);

  useEffect(() => {
    if (deleteConfirmation) confirmationCancelRef.current?.focus();
  }, [deleteConfirmation]);
  useEffect(() => () => { deleteConfirmationResolver.current?.(false); }, []);

  function requestDeleteConfirmation(message: string) {
    return new Promise<boolean>(resolve => {
      deleteConfirmationResolver.current = resolve;
      setDeleteConfirmation(message);
    });
  }
  function resolveDeleteConfirmation(confirmed: boolean) {
    const resolve = deleteConfirmationResolver.current;
    deleteConfirmationResolver.current = null;
    setDeleteConfirmation(null);
    resolve?.(confirmed);
  }

  useEffect(() => {
    const controller = new AbortController();
    deletePollAbort.current = controller;
    void fetch("/api/icloud/release/delete/status", { cache: "no-store", signal: controller.signal }).then(response => response.json() as Promise<{ deleteJob: DeleteJob }>).then(async data => {
      if (controller.signal.aborted || data.deleteJob?.status !== "running" || !data.deleteJob.id) return;
      setDeleteJob(data.deleteJob); setReleasingAsset(data.deleteJob.id);
      const completed = await waitForCloudDelete<DeleteJob>(data.deleteJob.id, setDeleteJob, controller.signal);
      setDeleteElapsed(completed.elapsedSeconds || 0); setReleasingAsset(null);
      void refreshReleaseCatalog();
    }).catch(reason => { if (!controller.signal.aborted) { setError(reason instanceof Error ? reason.message : "无法恢复删除进度。"); setReleasingAsset(null); } });
    return () => controller.abort();
  }, [refreshReleaseCatalog]);

  const deleteStartedAt = deleteJob?.startedAt;
  const deleteJobStatus = deleteJob?.status;
  useEffect(() => {
    if (deleteJobStatus !== "running" || !deleteStartedAt) return;
    const timer = setInterval(() => setDeleteElapsed(Math.max(0, Math.floor((Date.now() - deleteStartedAt) / 1000))), 1000);
    return () => clearInterval(timer);
  }, [deleteStartedAt, deleteJobStatus]);

  async function removeRecycledPhoto(item: PhotoItem) {
    await applyBatchRecycling([item], [{ item, mainDeleted: true, companionDeleted: Boolean(item.liveVideo) }]);
  }

  async function recycleLocalPhoto(item: PhotoItem) {
    setReleasingAsset(item.id); setError(""); setNotice(""); setDeleteJob(null);
    try {
      if (!await requestDeleteConfirmation('将“' + item.name + '”' + (item.liveVideo ? '及其配对实况视频' : '') + '移入 Windows 回收站？iCloud 内容会保留。接下来请选择图片来源文件夹“' + item.sourceName + '”。')) return false;
      setBatchLocalProgress({ total: 1, checked: 0, recycled: 0, message: "正在读取并校验本地图片…" });
      const entries = [{ relativePath: item.path, handle: item.handle }, ...(item.liveVideo ? [{ relativePath: item.liveVideo.path, handle: item.liveVideo.handle }] : [])];
      const files = await Promise.all(entries.map(async entry => {
        const file = await entry.handle.getFile();
        const digest = await crypto.subtle.digest("SHA-256", await file.arrayBuffer());
        return { relativePath: entry.relativePath, size: file.size, sha256: Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, "0")).join("") };
      }));
      const response = await fetch("/api/photos/recycle", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ sourceName: item.sourceName, files, confirmation: "移入本地回收站" }) });
      const data = await response.json() as { cancelled?: boolean; recycleResult?: { status: string; message: string; results: Array<{ relativePath: string; status: string }> }; error?: string };
      if (data.cancelled) { setBatchLocalProgress(null); return false; }
      if (!response.ok || !data.recycleResult) throw new Error(data.error || "本地删除失败。");
      if (data.recycleResult.results.some(result => result.relativePath === item.path && result.status === "recycled")) await removeRecycledPhoto(item);
      else if (item.liveVideo && data.recycleResult.results.some(result => result.relativePath === item.liveVideo?.path && result.status === "recycled")) {
        await applyBatchRecycling([item], [{ item, mainDeleted: false, companionDeleted: true }]);
      }
      const catalogResponse = await fetch("/api/icloud/release/catalog", { cache: "no-store" }).catch(() => null);
      if (catalogResponse?.ok) setReleaseCatalog(await catalogResponse.json() as ReleaseCatalog);
      if (data.recycleResult.status === "recycled") setNotice(data.recycleResult.message + " iCloud 内容已保留。");
      else setError(data.recycleResult.message + " iCloud 内容已保留。");
      setBatchLocalProgress({ total: 1, checked: 1, recycled: data.recycleResult.results.some(result => result.relativePath === item.path && result.status === "recycled") ? 1 : 0, message: data.recycleResult.message });
      return true;
    } catch (reason) { setError(reason instanceof Error ? reason.message : "本地删除失败。"); }
    finally { setReleasingAsset(null); }
  }

  async function applyBatchRecycling(items: PhotoItem[], results: Array<{ item: PhotoItem; mainDeleted: boolean; companionDeleted: boolean }>) {
    const current = libraryStateRef.current;
    const removed = new Set(results.filter(result => result.mainDeleted).map(result => result.item.id));
    const companions = new Set(results.filter(result => !result.mainDeleted && result.companionDeleted).map(result => result.item.id));
    const next = current.photos.filter(photo => !removed.has(photo.id)).map(photo => companions.has(photo.id) ? { ...photo, liveVideo: null } : photo);
    const nextSources = current.sources.map(source => ({ ...source, photoCount: next.filter(photo => photo.sourceId === source.id).length, totalSize: next.filter(photo => photo.sourceId === source.id).reduce((sum, photo) => sum + photo.size, 0) }));
    libraryStateRef.current = { photos: next, sources: nextSources, filtered: current.filtered.filter(photo => !removed.has(photo.id)) };
    setPhotos(next); setSources(nextSources); setSelectedIds(current => current.filter(id => !removed.has(id)));
    setViewerId(currentId => viewerAfterRemoval(currentId, current.filtered.map(photo => photo.id), new Set(next.map(photo => photo.id))));
    await Promise.all([dbSet(SOURCES_KEY, nextSources), ...[...new Set(items.map(item => item.sourceId))].map(sourceId => dbSet('photo-library:' + sourceId, next.filter(photo => photo.sourceId === sourceId)))]);
  }

  async function previewCloudDeletion(keys: string[], recycleLocal: boolean) {
    const response = await fetch("/api/icloud/release/delete/preview", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ planId: releaseCatalog?.releasePlan?.id, assetKeys: keys, recycleLocal, background: true }) });
    const started = await response.json() as { deleteJob?: DeleteJob; error?: string };
    if (!response.ok || !started.deleteJob?.id) throw new Error(started.error || "云端复核任务未启动，没有执行删除。");
    setDeleteJob(started.deleteJob);
    const completed = await waitForCloudDelete<DeleteJob>(started.deleteJob.id, setDeleteJob, deletePollAbort.current?.signal);
    setDeleteElapsed(completed.elapsedSeconds || 0);
    if (completed.result?.releaseResult?.status !== "matched") throw new Error(completed.message || "云端复核未通过，没有执行删除。");
    return completed.result;
  }

  async function deleteBatchPhotos(items: PhotoItem[]) {
    if (!items.length || items.length > MAX_PHOTO_SELECTION || releasingAsset !== null || appleSessionBusy) return;
    setReleasingAsset("batch"); setError(""); setNotice(""); setDeleteJob(null); setBatchLocalProgress(null);
    try {
      if (deleteMode === "local") {
        const bySource = new Map<string, PhotoItem[]>();
        for (const item of items) bySource.set(item.sourceId, [...(bySource.get(item.sourceId) || []), item]);
        if (!await requestDeleteConfirmation('将选中的 ' + items.length + ' 张图片及其配对实况视频移入 Windows 回收站？iCloud 内容会保留。接下来需要为 ' + bySource.size + ' 个图片来源分别选择对应文件夹。')) return;
        const outcomes: Array<{ item: PhotoItem; mainDeleted: boolean; companionDeleted: boolean }> = [];
        const issues: string[] = [];
        let checked = 0;
        for (const sourceItems of bySource.values()) {
          try {
            const groups = [];
            for (const item of sourceItems) {
              setBatchLocalProgress({ total: items.length, checked, recycled: outcomes.filter(result => result.mainDeleted).length, message: '正在读取并校验：' + item.name });
              const entries = [{ relativePath: item.path, handle: item.handle }, ...(item.liveVideo ? [{ relativePath: item.liveVideo.path, handle: item.liveVideo.handle }] : [])];
              const files = [];
              for (const entry of entries) { const file = await entry.handle.getFile(); const hash = await crypto.subtle.digest("SHA-256", await file.arrayBuffer()); files.push({ relativePath: entry.relativePath, size: file.size, sha256: Array.from(new Uint8Array(hash), byte => byte.toString(16).padStart(2, "0")).join("") }); }
              groups.push(files); checked += 1;
            }
            setBatchLocalProgress({ total: items.length, checked, recycled: outcomes.filter(result => result.mainDeleted).length, message: '请选择来源“' + sourceItems[0].sourceName + '”，随后将回收 ' + sourceItems.length + ' 张图片…' });
            const response = await fetch("/api/photos/recycle", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ sourceName: sourceItems[0].sourceName, groups, confirmation: "移入本地回收站" }) });
            const data = await response.json() as { cancelled?: boolean; error?: string; recycleResult?: { message: string; status: string; results: Array<{ relativePath: string; status: string }> } };
            if (data.cancelled) { issues.push(sourceItems[0].sourceName + "：已取消，该来源未删除。"); continue; }
            if (!response.ok || !data.recycleResult) throw new Error(data.error || "该来源回收失败。");
            const recycled = new Set(data.recycleResult.results.filter(result => result.status === "recycled").map(result => result.relativePath));
            for (const item of sourceItems) outcomes.push({ item, mainDeleted: recycled.has(item.path), companionDeleted: Boolean(item.liveVideo && recycled.has(item.liveVideo.path)) });
            if (data.recycleResult.status !== "recycled") issues.push(data.recycleResult.message);
          } catch (reason) { issues.push(sourceItems[0].sourceName + "：" + (reason instanceof Error ? reason.message : "回收失败")); }
        }
        await applyBatchRecycling(items, outcomes);
        const done = outcomes.filter(result => result.mainDeleted).length;
        setBatchLocalProgress({ total: items.length, checked, recycled: done, message: '批量本地删除结束：已回收 ' + done + '/' + items.length + ' 张图片；iCloud 内容保留。' });
        setNotice('本地已回收 ' + done + '/' + items.length + ' 张图片。');
        if (issues.length) setError(issues.join(" "));
      } else {
        const selection = collectCloudSelection(items, cloudAssetFor);
        if (!selection.assets.length) throw new Error("选中图片没有可精确匹配的云端项目。");
        const keys = selection.assets.map(asset => asset.library + ":" + asset.id);
        const recycleLocal = deleteMode === "both";
        setDeleteElapsed(0); setDeleteJob({ status: "running", phase: "preview", name: '批量删除 ' + selection.assets.length + ' 个云端项目', startedAt: Date.now(), total: selection.assets.length, message: "正在批量核对精确云端资产…" });
        const preview = await previewCloudDeletion(keys, recycleLocal);
        const confirmation = await requestDeleteConfirmation('将 ' + selection.assets.length + ' 个精确匹配云端项目移入“最近删除”。' + (recycleLocal ? '仅在云端删除成功或确认已在最近删除中后回收本地原片（最多 ' + (preview.localRecyclePlan?.fileCount || 0) + ' 个文件）。' : '本地原片保留。') + '跳过 ' + selection.skipped.length + ' 张未匹配图片。已在云端最近删除中的项目不会重复删除。确认继续？');
        if (!confirmation) { setDeleteJob(null); return; }
        const response = await fetch("/api/icloud/release/delete", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ planId: releaseCatalog?.releasePlan?.id, assetKeys: keys, recycleLocal, confirmation, background: true }) });
        const started = await response.json() as { deleteJob?: DeleteJob; error?: string };
        if (!response.ok || !started.deleteJob?.id) throw new Error(started.error || "批量任务未启动。");
        setDeleteJob(started.deleteJob); setDeleteElapsed(0);
        const completed = await waitForCloudDelete<DeleteJob>(started.deleteJob.id, setDeleteJob, deletePollAbort.current?.signal);
        setDeleteElapsed(completed.elapsedSeconds || 0);
        const data = completed.result;
        const deletedKeys = new Set((data?.releaseResult?.results || []).filter(result => result.status === "deleted").map(result => result.library + ":" + result.id));
        const recycledPaths = new Set((data?.recycleResult?.results || []).filter(result => result.status === "recycled").map(result => result.relativePath.replaceAll("\\", "/").toLowerCase()));
        const outcomes = selection.matched.map(({ item, asset }) => ({ item, mainDeleted: asset.localFiles.some(path => path.split(/[\\/]/).pop()?.toLowerCase() === item.name.toLowerCase() && recycledPaths.has(path.replaceAll("\\", "/").toLowerCase())), companionDeleted: Boolean(item.liveVideo && asset.localFiles.some(path => path.split(/[\\/]/).pop()?.toLowerCase() === item.liveVideo?.name.toLowerCase() && recycledPaths.has(path.replaceAll("\\", "/").toLowerCase()))) }));
        if (recycleLocal) await applyBatchRecycling(items, outcomes);
        else setSelectedIds(current => current.filter(id => !selection.matched.some(({ item, asset }) => item.id === id && deletedKeys.has(asset.library + ":" + asset.id))));
        setNotice(completed.message || "批量删除结束。");
        if (completed.status !== "completed") setError(completed.message || "部分项目未完成，失败项已保留。");
      }
      void refreshReleaseCatalog();
      setDeleteFinished(true);
    } catch (reason) { const message = reason instanceof Error ? reason.message : "批量删除失败。"; setError(message); setDeleteJob(current => current ? { ...current, status: (current.deleted || 0) > 0 ? "partial" : "failed", message } : current); }
    finally { setReleasingAsset(null); }
  }

  async function deleteSelectedPhoto() {
    if (deleteFinished || deleteConfirmation) return;
    if (bulkDeleteItems.length) { await deleteBatchPhotos(bulkDeleteItems); return; }
    if (!deleteItem || releasingAsset !== null || appleSessionBusy) return;
    const item = deleteItem;
    let completed: boolean | undefined;
    if (deleteMode === "local") completed = await recycleLocalPhoto(item);
    else {
      const asset = cloudAssetFor(item);
      if (!asset) { setError("请先在 iCloud 备份中心完成释放计划复核和确认。"); return; }
      completed = await releaseFromIcloud(item, asset, deleteMode === "both");
    }
    if (completed) setDeleteFinished(true);
  }

  async function releaseFromIcloud(item: PhotoItem, asset: IcloudAsset, recycleLocal: boolean) {
    const key = `${asset.library}:${asset.id}`;
    setReleasingAsset(key); setError(""); setNotice(""); setDeleteElapsed(0);
    setDeleteJob({ status: "running", phase: "preview", name: item.name, startedAt: Date.now(), total: 1, processed: 0, deleted: 0, message: "正在连接 Apple 并核对目标资产；图库较大时此步骤可能较慢…" });
    try {
      const preview = await previewCloudDeletion([key], recycleLocal);
      const localSummary = recycleLocal ? `同时将 ${preview.localRecyclePlan?.fileCount || 0} 个本地原文件（${formatBytes(preview.localRecyclePlan?.bytes || 0)}）移入 Windows 回收站。` : "本地备份会保留。";
      const confirmation = await requestDeleteConfirmation(`已精确匹配“${item.name}”。${preview.releaseResult?.results?.some(result => result.alreadyDeleted) ? "云端已在最近删除中，不会重复删除。" : `云端项目将移入“最近删除”，预计 ${formatBytes(asset.originalBytes)}。`}${localSummary}\n\n已在云端最近删除中的项目不会重复删除。确认继续？`);
      if (!confirmation) { setDeleteJob(null); return; }
      setDeleteJob({ status: "running", phase: "preparing", name: item.name, startedAt: Date.now(), total: 1, processed: 0, deleted: 0, message: "已确认删除，正在启动后台任务…" }); setDeleteElapsed(0);
      const response = await fetch("/api/icloud/release/delete", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ planId: releaseCatalog?.releasePlan?.id, assetKeys: [key], confirmation, recycleLocal, background: true }) });
      const started = await response.json() as { deleteJob?: DeleteJob; error?: string };
      if (!response.ok || !started.deleteJob?.id) throw new Error(started.error || "删除任务未能启动。");
      setDeleteJob(started.deleteJob); setDeleteElapsed(0);
      const completed = await waitForCloudDelete<DeleteJob>(started.deleteJob.id, setDeleteJob, deletePollAbort.current?.signal);
      setDeleteElapsed(completed.elapsedSeconds || 0);
      const data = completed.result;
      void refreshReleaseCatalog();
      if (!data || data.releaseResult?.status !== "deleted") throw new Error(completed.message || data?.releaseResult?.message || "云端未返回删除成功，请确认云端状态后再重试。");
      setReleaseCatalog(current => current ? { ...current, releasePlan: current.releasePlan ? { ...current.releasePlan, assets: current.releasePlan.assets.filter(candidate => `${candidate.library}:${candidate.id}` !== key) } : null, releaseHistory: data.releaseHistory || current.releaseHistory, timeline: data.timeline || current.timeline } : current);
      if (data.recycleResult?.results?.some(result => result.status === "recycled" && result.relativePath.replaceAll("\\", "/").split("/").pop()?.toLowerCase() === item.name.toLowerCase())) {
        await removeRecycledPhoto(item);
      } else if (item.liveVideo && data.recycleResult?.results?.some(result => result.status === "recycled" && result.relativePath.replaceAll("\\", "/").split("/").pop()?.toLowerCase() === item.liveVideo?.name.toLowerCase())) {
        await applyBatchRecycling([item], [{ item, mainDeleted: false, companionDeleted: true }]);
      }
      if (data.recycleResult && data.recycleResult.status !== "recycled") setError("iCloud 删除已成功。" + data.recycleResult.message);
      setNotice(data.recycleResult ? `“${item.name}”已移入 iCloud“最近删除”。${data.recycleResult.message}` : `“${item.name}”已移入 iCloud“最近删除”，本地文件未删除。预计可释放 ${formatBytes(asset.originalBytes)}；彻底释放需清空“最近删除”。`);
      return true;
    } catch (reason) { const message = reason instanceof Error ? reason.message : "iCloud 删除失败。"; setError(message); setDeleteJob(current => current ? { ...current, status: (current.deleted || 0) > 0 ? "partial" : "failed", message } : current); }
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

  function markSelectedForCleanup() {
    if (loading || !selectedIds.length) return;
    const selected = new Set(selectedIds);
    const current = libraryStateRef.current.photos;
    const selectedPhotos = current.filter(item => selected.has(item.id));
    if (!selectedPhotos.length) return;
    const updated = current.map(item => selected.has(item.id) ? { ...item, cleanup: true } : item);
    for (const sourceId of new Set(selectedPhotos.map(item => item.sourceId))) persistMarks(updated, sourceId);
    libraryStateRef.current = { ...libraryStateRef.current, photos: updated };
    setPhotos(updated);
    setNotice(`已将选中的 ${selectedPhotos.length} 张图片批量加入待整理，可在“待整理”分类查看。`);
  }

  const formats = useMemo(() => [...new Set(photos.map(item => item.extension))].sort(), [photos]);
  const photoTimes = useMemo(() => new Map(photos.map(item => [item.id, photoTimeKeys(item)])), [photos]);
  const timePeriods = useMemo(() => {
    const counts = new Map<string, number>();
    for (const keys of photoTimes.values()) {
      const key = keys?.[timeGranularity] || "unknown";
      counts.set(key, (counts.get(key) || 0) + 1);
    }
    return [...counts].sort(([left], [right]) => left === "unknown" ? 1 : right === "unknown" ? -1 : right.localeCompare(left));
  }, [photoTimes, timeGranularity]);
  const filtered = useMemo(() => {
    const normalized = query.trim().toLocaleLowerCase("zh-CN");
    const result = photos.filter(item => {
      if (sourceFilter !== "all" && item.sourceId !== sourceFilter) return false;
      if (formatFilter !== "all" && item.extension !== formatFilter) return false;
      if (!matchesPhotoTime(photoTimes.get(item.id) || null, timeGranularity, selectedTimePeriods)) return false;
      if (tab === "live" && !item.liveVideo) return false;
      if (tab === "liked" && !item.liked) return false;
      if (tab === "cleanup" && !item.cleanup) return false;
      return !normalized || `${item.name} ${item.path}`.toLocaleLowerCase("zh-CN").includes(normalized);
    });
    return result.sort((left, right) => sort === "oldest" ? left.modified - right.modified : sort === "largest" ? right.size - left.size : sort === "smallest" ? left.size - right.size : sort === "name" ? left.name.localeCompare(right.name, "zh-CN") : right.modified - left.modified);
  }, [formatFilter, photos, photoTimes, query, selectedTimePeriods, sort, sourceFilter, tab, timeGranularity]);
  useLayoutEffect(() => { libraryStateRef.current = { photos, sources, filtered }; }, [photos, sources, filtered]);
  const pageCount = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
  const currentPage = Math.min(page, pageCount);
  useEffect(() => {
    const target = paginationRef.current;
    if (!target) return;
    const observer = new IntersectionObserver(entries => {
      setPaginationVisible(entries.some(entry => entry.isIntersecting));
    });
    observer.observe(target);
    return () => observer.disconnect();
  }, [pageCount]);
  function changePhotoPage(nextPage: number) {
    setPage(Math.max(1, Math.min(pageCount, nextPage)));
  }
  const visible = filtered.slice((currentPage - 1) * PAGE_SIZE, currentPage * PAGE_SIZE);
  const viewerIndex = viewerId ? filtered.findIndex(item => item.id === viewerId) : -1;
  const viewer = viewerId ? photos.find(item => item.id === viewerId) : null;
  const moveViewer = useCallback((direction: -1 | 1) => {
    if (!filtered.length) return;
    if (viewerIndex < 0) { setViewerId(filtered[direction === 1 ? 0 : filtered.length - 1].id); return; }
    setViewerId(filtered[(viewerIndex + direction + filtered.length) % filtered.length].id);
  }, [filtered, viewerIndex]);
  const selectedPhotos = photos.filter(item => selectedIds.includes(item.id));
  const dialogItems = bulkDeleteItems.length ? bulkDeleteItems : deleteItem ? [deleteItem] : [];
  const dialogCloudSelection = collectCloudSelection(dialogItems, cloudAssetFor);
  const cloudDeleteAvailable = !releaseCatalogLoading && !releaseCatalogError && dialogCloudSelection.assets.length > 0;
  function toggleSelection(id: string) {
    if (!selectedIds.includes(id) && selectedPhotos.length >= MAX_PHOTO_SELECTION) { setNotice(`每批最多选择 ${MAX_PHOTO_SELECTION} 张图片。`); return; }
    setSelectedIds(current => current.includes(id) ? current.filter(value => value !== id) : [...current, id]);
  }
  function selectAllFiltered() {
    if (loading || !filtered.length) return;
    setSelectionMode(true);
    setSelectedIds(filtered.slice(0, MAX_PHOTO_SELECTION).map(item => item.id));
    if (filtered.length > MAX_PHOTO_SELECTION) setNotice(`当前筛选共 ${filtered.length} 张图片，每批最多 ${MAX_PHOTO_SELECTION} 张，已选中排序靠前的 ${MAX_PHOTO_SELECTION} 张（支持跨页）。`);
  }
  function closeDeleteDialog() {
    if (releasingAsset !== null) return;
    resolveDeleteConfirmation(false);
    deleteDialogRef.current?.close();
    setDeleteItem(null); setBulkDeleteItems([]); setDeleteMinimized(false); setDeleteFinished(false);
    setDeleteJob(null); setBatchLocalProgress(null);
  }
  function openDeleteDialog(items: PhotoItem[], mode: "local" | "icloud" | "both" = "local") {
    if (releasingAsset !== null || appleSessionBusy) return;
    setDeleteMinimized(false); setDeleteFinished(false); setDeleteConfirmation(null);
    setViewerId(null);
    setBulkDeleteItems(items.length > 1 ? items : []); setDeleteItem(items.length === 1 ? items[0] : null);
    setDeleteMode(mode); setBatchLocalProgress(null); setDeleteJob(null); setError(""); setNotice("");
    void refreshReleaseCatalog();
  }
  function minimizeDeleteWindow() { setSelectionMode(false); setDeleteMinimized(true); }
  const totalSize = photos.reduce((sum, item) => sum + item.size, 0);

  return <main className={styles.page}>
    <header className={styles.topbar}>
      <a href="/?library=video"><span>F</span>Framebase</a>
      <label><span>⌕</span><input value={query} onChange={event => { setQuery(event.target.value); setPage(1); }} placeholder="搜索图片名称或路径…" aria-label="搜索图片" /></label>
      <nav className="media-header-actions"><a className="media-header-button" href="/?library=video">视频库</a><a className="media-header-button" href="/icloud">iCloud 备份</a><a className="media-header-button" href="/lan">局域网</a><b className="media-account">{username}</b><button className="media-logout" onClick={() => void signOut()}>退出</button><ThemeSelector /></nav>
    </header>
    {error && <div className={styles.error} role="alert">{error}<button onClick={() => setError("")}>×</button></div>}
    {notice && <div className={styles.notice} role="status">{notice}<button onClick={() => setNotice("")}>×</button></div>}
    <section className={styles.hero}><div><p>独立图片库</p><h1>图片浏览与整理</h1><span>图片来源、索引和标记与原视频库彻底隔离；移除来源不会删除文件。</span></div><button onClick={() => void chooseFolder()} disabled={loading || releasingAsset !== null}>{loading ? `正在扫描 ${progress} 张…` : "添加图片文件夹"}</button></section>
    {icloudBackupDirectory && <aside className={styles.icloudHint}><div><strong>iCloud 照片与视频备份目录</strong><span>{icloudBackupDirectory}</span></div><p>{releaseCatalog?.releaseHistory.movedCount ? `云端已移入“最近删除” ${releaseCatalog.releaseHistory.movedCount} 个项目，预计 ${formatBytes(releaseCatalog.releaseHistory.movedBytes)}；本地已回收 ${releaseCatalog.releaseHistory.recycledFileCount || 0} 个文件，共 ${formatBytes(releaseCatalog.releaseHistory.recycledBytes || 0)}。` : "可将这个目录同时添加到图片库和视频库；两套标记和索引互不影响。"}</p></aside>}
    {releaseCatalog?.timeline.staleAt && <aside className={styles.timelineStale}><strong>iCloud 统计需要确认</strong><span>{releaseCatalog.timeline.staleReason || "云端内容已变化，请到 iCloud 备份中心重新统计。"}</span><a href="/icloud">立即重新统计</a></aside>}
    <section className={styles.stats}><div><span>图片</span><strong>{photos.length}</strong></div><div><span>来源</span><strong>{sources.length}</strong></div><div><span>收藏</span><strong>{photos.filter(item => item.liked).length}</strong></div><div><span>占用</span><strong>{formatBytes(totalSize)}</strong></div></section>
    <section className={styles.sources} aria-label="图片来源">
      {sources.length === 0 && ready ? <p>尚未添加图片文件夹。这里不会读取视频库已经选择的目录。</p> : sources.map(source => <article key={source.id}><button onClick={() => { setSourceFilter(source.id); setPage(1); }} className={sourceFilter === source.id ? styles.activeSource : ""}><strong>{source.name}</strong><span>{source.photoCount} 张 · {formatBytes(source.totalSize)}</span></button><button onClick={() => void loadSource(source)} disabled={loading || releasingAsset !== null}>重扫</button><button onClick={() => void removeSource(source)} disabled={loading || releasingAsset !== null}>移除</button></article>)}
    </section>
    <section className={styles.toolbar}>
      <div><button className={tab === "all" ? styles.active : ""} onClick={() => { setTab("all"); setPage(1); }}>全部</button><button className={tab === "live" ? styles.active : ""} onClick={() => { setTab("live"); setPage(1); }}>实况</button><button className={tab === "liked" ? styles.active : ""} onClick={() => { setTab("liked"); setPage(1); }}>收藏</button><button className={tab === "cleanup" ? styles.active : ""} onClick={() => { setTab("cleanup"); setPage(1); }}>待整理</button></div>
      <div><select value={sourceFilter} onChange={event => { setSourceFilter(event.target.value); setPage(1); }} aria-label="来源"><option value="all">全部来源</option>{sources.map(source => <option value={source.id} key={source.id}>{source.name}</option>)}</select><select value={formatFilter} onChange={event => { setFormatFilter(event.target.value); setPage(1); }} aria-label="格式"><option value="all">全部格式</option>{formats.map(format => <option value={format} key={format}>{format.toUpperCase()}</option>)}</select><select value={sort} onChange={event => { setSort(event.target.value as Sort); setPage(1); }} aria-label="排序"><option value="newest">最新优先</option><option value="oldest">最早优先</option><option value="largest">最大优先</option><option value="smallest">最小优先</option><option value="name">按名称</option></select><select value={previewRatio} onChange={event => setPreviewRatio(event.target.value as PreviewRatio)} aria-label="预览比例"><option value="standard">标准比例</option><option value="phone">手机比例 9:16</option></select><button onClick={() => setCompact(value => !value)}>{compact ? "舒适视图" : "紧凑视图"}</button></div>
    </section>
    <details className={styles.timeFilter}>
      <summary>时间筛选 · {selectedTimePeriods.length ? `已选 ${selectedTimePeriods.length} 个${timeGranularity === "years" ? "年份" : timeGranularity === "quarters" ? "季度" : "月份"}` : "全部时间"}</summary>
      <div className={styles.timeFilterControls}>
        <label>按时间范围筛选 <select aria-label="时间筛选粒度" value={timeGranularity} onChange={event => { setTimeGranularity(event.target.value as TimeGranularity); setSelectedTimePeriods([]); setPage(1); }}><option value="years">按年</option><option value="quarters">按季度</option><option value="months">按月</option></select></label>
        <button className={actionStyles.button} disabled={!selectedTimePeriods.length} onClick={() => { setSelectedTimePeriods([]); setPage(1); }}>全部时间</button>
        <span>可选择多个范围，与来源、格式和分类一起筛选。</span>
      </div>
      <div className={styles.timePeriods} role="group" aria-label="选择图片时间范围">
        {timePeriods.map(([key, count]) => <label key={key} className={selectedTimePeriods.includes(key) ? styles.selectedTimePeriod : ""}><input type="checkbox" checked={selectedTimePeriods.includes(key)} onChange={() => { setSelectedTimePeriods(current => current.includes(key) ? current.filter(value => value !== key) : [...current, key]); setPage(1); }} /><span>{timePeriodLabel(key, timeGranularity)}</span><small>{count} 张</small></label>)}
        {!timePeriods.length && <span>添加图片后可选择时间范围。</span>}
      </div>
      <p>优先使用备份目录中的年、月；其他图片使用文件修改时间。范围数量为整个图片库的图片数。</p>
    </details>
    <section className={styles.selectionToolbar} aria-label="批量选择图片">
      <button className={actionStyles.button} onClick={() => { setSelectionMode(value => !value); setSelectedIds([]); }}>{selectionMode ? "退出多选" : "批量选择"}</button>
      <button className={`${actionStyles.button} ${styles.quickSelectAll}`} disabled={loading || !filtered.length} title={`选择当前筛选结果，包含其他分页，每批最多 ${MAX_PHOTO_SELECTION} 张`} onClick={selectAllFiltered}>{filtered.length > MAX_PHOTO_SELECTION ? `全选前 ${MAX_PHOTO_SELECTION} 张` : "快捷全选"}</button>
      {selectionMode && <><div className={styles.selectionSummary}><strong>已选 {selectedPhotos.length} 张</strong><span>每批最多 {MAX_PHOTO_SELECTION} 张 · 可跨页选择</span></div><div className={styles.selectionActions}><button className={actionStyles.button} onClick={() => setSelectedIds([...new Set([...selectedPhotos.map(item => item.id), ...visible.map(item => item.id)])].slice(0, MAX_PHOTO_SELECTION))}>选择本页</button><button className={actionStyles.button} disabled={!selectedPhotos.length} onClick={() => setSelectedIds([])}>清空选择</button><button className={`${actionStyles.button} ${styles.bulkCleanup}`} disabled={loading || !selectedPhotos.length} onClick={markSelectedForCleanup}>批量加入待整理{selectedPhotos.length ? ` · ${selectedPhotos.length} 张` : ""}</button><button className={`${actionStyles.button} ${actionStyles.dangerButton}`} disabled={loading || releasingAsset !== null || !selectedPhotos.length} onClick={() => openDeleteDialog(selectedPhotos)}>删除选中的 {selectedPhotos.length} 张</button></div></>}
    </section>
    <section className={styles.libraryHead}><p>显示 <strong>{filtered.length}</strong> 张图片</p>{pageCount > 1 && <div ref={paginationRef}><button disabled={currentPage === 1} onClick={() => changePhotoPage(currentPage - 1)}>上一页</button><span>{currentPage} / {pageCount}</span><button disabled={currentPage === pageCount} onClick={() => changePhotoPage(currentPage + 1)}>下一页</button><PhotoPageJump page={currentPage} pageCount={pageCount} onChange={changePhotoPage} /></div>}</section>
    {pageCount > 1 && !paginationVisible && !viewer && (dialogItems.length === 0 || deleteMinimized) && <nav className={`${styles.floatingPagination} ${dialogItems.length > 0 && deleteMinimized ? styles.floatingPaginationWithTask : ""}`} aria-label="悬浮图片翻页"><button className={actionStyles.button} disabled={currentPage === 1} onClick={() => changePhotoPage(currentPage - 1)}>← 上一页</button><span aria-live="polite">{currentPage} / {pageCount}</span><button className={actionStyles.button} disabled={currentPage === pageCount} onClick={() => changePhotoPage(currentPage + 1)}>下一页 →</button><PhotoPageJump page={currentPage} pageCount={pageCount} onChange={changePhotoPage} /></nav>}
    {visible.length ? <section className={`${styles.grid} ${compact ? styles.compact : ""} ${previewRatio === "phone" ? styles.phoneRatio : ""}`}>{visible.map(item => { return <article className={`${styles.card} ${selectionMode && selectedIds.includes(item.id) ? styles.selectedCard : ""}`} key={item.id}><div className={styles.preview}>{selectionMode && <label className={styles.selectionCheckbox}><input type="checkbox" aria-label={`选择 ${item.name}`} checked={selectedIds.includes(item.id)} onChange={() => toggleSelection(item.id)} /></label>}<PhotoThumb item={item} onOpen={() => { if (selectionMode) toggleSelection(item.id); else { setViewerId(item.id); void refreshReleaseCatalog(); } }} />{item.liveVideo && <span className={styles.liveBadge} title={`配对视频：${item.liveVideo.name}`}>● 实况</span>}{item.cleanup && <span className={styles.cleanupBadge} title="已加入待整理">✓ 待整理</span>}<PhotoActionsMenu name={item.name} liked={item.liked} cleanup={item.cleanup} busy={releasingAsset !== null} onOpen={() => { setViewerId(item.id); void refreshReleaseCatalog(); }} onFavorite={() => toggleMark(item.id, "liked")} onCleanup={() => toggleMark(item.id, "cleanup")} onDelete={() => openDeleteDialog([item])} /></div><div className={styles.cardMeta}><h2 title={item.path}>{item.name}</h2><p title={`${item.sourceName} · ${item.extension.toUpperCase()} · ${formatBytes(item.size)} · ${formatDate(item.modified)}`}><span>{item.sourceName}</span> · {item.extension.toUpperCase()} · {formatBytes(item.size)} · {formatDate(item.modified)}</p></div></article>; })}</section> : <section className={styles.empty}><strong>{ready ? "没有符合条件的图片" : "正在读取图片库…"}</strong><span>{sources.length ? "可以调整筛选条件或重新扫描来源。" : "点击“添加图片文件夹”开始建立独立图片库。"}</span></section>}
    <footer><span>图片来源来自你授权的本地文件夹；删除前需单独确认</span><a href="/?library=video">返回视频库 →</a></footer>
    {!dialogItems.length && deleteJob?.status === "failed" && <aside className={styles.deleteProgress}><AppleSessionControls disabled={releasingAsset !== null} onBusyChange={setAppleSessionBusy} onVerified={handleSessionVerified} /></aside>}
    {dialogItems.length === 0 && deleteJob && deleteJob.status !== "idle" && <aside className={styles.deleteToast}><CloudDeleteProgress job={deleteJob} elapsedSeconds={deleteElapsed} />{deleteJob.status !== "running" && <button onClick={() => setDeleteJob(null)} aria-label="关闭删除结果">关闭</button>}</aside>}
    {dialogItems.length > 0 && <dialog ref={deleteDialogRef} className={`${styles.deleteDialog} ${deleteMinimized ? styles.deleteMini : ""}`} aria-modal={!deleteMinimized} aria-labelledby="delete-photo-title" onCancel={event => { event.preventDefault(); if (deleteConfirmation) resolveDeleteConfirmation(false); else if (releasingAsset !== null) minimizeDeleteWindow(); else closeDeleteDialog(); }}>
      <header className={styles.deleteHeader}><div><h2 id="delete-photo-title">{bulkDeleteItems.length ? `批量删除 ${dialogItems.length} 张图片` : "删除这张图片"}</h2><p>{deleteConfirmation ? "等待确认 · 尚未执行此次删除" : deleteFinished ? "操作已结束，可查看结果后关闭" : releasingAsset !== null ? "任务继续进行，可缩小后浏览图片库" : "确认图片与删除范围，再继续复核"}</p></div><button className={actionStyles.button} onClick={() => { if (deleteMinimized) setDeleteMinimized(false); else minimizeDeleteWindow(); }} aria-label={deleteMinimized ? "恢复删除大窗" : "缩小删除窗口"}>{deleteMinimized ? "恢复" : "缩小"}</button></header>
      <div className={styles.deleteBody}>
      {deleteConfirmation && <section className={styles.confirmationPanel} role="alert" aria-labelledby="delete-confirm-title"><span>!</span><h3 id="delete-confirm-title">确认删除</h3><p>{deleteConfirmation}</p><small>只有点击下方“确认删除”才会继续执行。</small></section>}
      {!deleteFinished && <div className={styles.deleteSetup}><ul className={styles.deleteItemList}>{dialogItems.map(item => <li key={item.id}>{item.name}{item.liveVideo ? " · 包含配对实况视频" : ""}</li>)}</ul>{bulkDeleteItems.length > 0 && <p>精确匹配 {dialogCloudSelection.matched.length} 张图片，对应 {dialogCloudSelection.assets.length} 个云端项目；云端操作跳过 {dialogCloudSelection.skipped.length} 张未匹配图片。失败及跳过的图片保留选择。</p>}
      <fieldset disabled={releasingAsset !== null}>
        <legend>选择删除范围</legend>
        <label htmlFor="photo-delete-local" aria-label="仅删除本地"><input id="photo-delete-local" type="radio" name="photo-delete-mode" checked={deleteMode === "local"} onChange={() => setDeleteMode("local")} /><span><strong>仅删除本地</strong><small>移入 Windows 回收站，保留 iCloud 内容。</small></span></label>
        <label htmlFor="photo-delete-icloud" aria-label="仅删除 iCloud"><input id="photo-delete-icloud" type="radio" name="photo-delete-mode" checked={deleteMode === "icloud"} disabled={!cloudDeleteAvailable} onChange={() => setDeleteMode("icloud")} /><span><strong>仅删除 iCloud</strong><small>移入 iCloud“最近删除”，保留本地原片。</small></span></label>
        <label htmlFor="photo-delete-both" aria-label="两边都删除"><input id="photo-delete-both" type="radio" name="photo-delete-mode" checked={deleteMode === "both"} disabled={!cloudDeleteAvailable} onChange={() => setDeleteMode("both")} /><span><strong>两边都删除</strong><small>云端成功移入“最近删除”后，再将本地原片移入回收站。</small></span></label>
      </fieldset>
      {releaseCatalogLoading ? <p>正在刷新云端释放计划…</p> : releaseCatalogError ? <p>{releaseCatalogError}</p> : !dialogCloudSelection.assets.length && <p>{releaseCatalog?.releasePlan?.status === "confirmed" ? "释放计划已确认，但此图片未能唯一匹配计划中的云端项目。请确认图片来源和本地文件大小，或重新生成释放计划。" : "请到 iCloud 备份中心复核并确认释放计划后，再操作 iCloud。"}</p>}
      <div className={styles.sessionControls}><AppleSessionControls disabled={releasingAsset !== null} onBusyChange={setAppleSessionBusy} onVerified={handleSessionVerified} /></div>
      </div>}
      {deleteMinimized && !deleteConfirmation && !deleteFinished && releasingAsset === null && <p>已暂存 {dialogItems.length} 张图片 · {deleteMode === "local" ? "仅删除本地" : deleteMode === "icloud" ? "仅删除 iCloud" : "两边都删除"}。可恢复大窗调整范围，或点击“继续”开始复核。</p>}
      {batchLocalProgress && <section className={styles.localDeleteProgress} role="status"><strong>{deleteFinished ? "本地回收已结束" : "正在校验 / 回收本地"}</strong><p>{batchLocalProgress.message}</p><progress max={batchLocalProgress.total} value={batchLocalProgress.checked} aria-label="本地校验进度" /><span>已校验 {batchLocalProgress.checked}/{batchLocalProgress.total} 张 · 已回收 {batchLocalProgress.recycled} 张</span></section>}
      {deleteJob && deleteJob.status !== "idle" && <section className={styles.deleteProgress}><CloudDeleteProgress job={deleteJob} elapsedSeconds={deleteElapsed} /></section>}
      {error && <p className={styles.taskError} role="alert">{error}</p>}
      {deleteFinished && notice && <p className={styles.taskResult} role="status">{notice}</p>}
      </div><div className={styles.deleteActions}>{deleteConfirmation ? <><button ref={confirmationCancelRef} className={actionStyles.button} onClick={() => resolveDeleteConfirmation(false)}>暂不删除</button><button className={`${actionStyles.button} ${actionStyles.dangerButton}`} onClick={() => resolveDeleteConfirmation(true)}>确认删除</button></> : deleteFinished ? <button className={actionStyles.button} onClick={closeDeleteDialog}>关闭</button> : <><button className={actionStyles.button} disabled={releasingAsset !== null || appleSessionBusy} onClick={closeDeleteDialog}>取消</button><button className={`${actionStyles.button} ${actionStyles.dangerButton}`} disabled={appleSessionBusy || releasingAsset !== null || (deleteMode !== "local" && (!cloudDeleteAvailable))} onClick={() => void deleteSelectedPhoto()}>{releasingAsset !== null ? deleteMode === "local" ? "正在校验/回收本地…" : deleteJob?.phase === "preview" ? "正在核对云端…" : deleteJob?.phase === "recycling" ? "正在回收本地…" : "等待云端结果…" : "继续"}</button></>}</div>
    </dialog>}
    {viewer && <PhotoViewer key={`${viewer.id}:${viewer.liveVideo?.path || ""}`} item={viewer} taskNotice={releasingAsset !== null && dialogItems.some(item => item.id === viewer.id) ? deleteMode === "icloud" ? "当前照片在云端删除任务中，本地图片仍可继续浏览。" : "当前照片在删除任务范围内；本地回收成功后将自动切换到其他照片。" : ""} previous={() => moveViewer(-1)} next={() => moveViewer(1)} onClose={() => setViewerId(null)} onFavorite={() => toggleMark(viewer.id, "liked")} onCleanup={() => toggleMark(viewer.id, "cleanup")} onDelete={mode => openDeleteDialog([viewer], mode)} cloudAvailable={Boolean(cloudAssetFor(viewer)) && !releaseCatalogError} cloudLoading={releaseCatalogLoading} releaseBusy={releasingAsset !== null} cloudMessage={releaseCatalogError || (releaseCatalog?.releasePlan?.status === "confirmed" ? "此图片未能唯一匹配已确认计划中的云端项目。" : "请先到 iCloud 备份中心生成计划并启用逐项删除。")} />}
  </main>;
}
