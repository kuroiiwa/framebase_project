"use client";

import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import ThemeSelector from "./theme-selector";
import { ScanControl, selectRange } from "./library-controls";
import { usePlayerShortcuts } from "./player-shortcuts";

type FsPermission = "granted" | "denied" | "prompt";
type FileHandle = {
  kind: "file";
  name: string;
  getFile(): Promise<File>;
};
type DirectoryHandle = {
  kind: "directory";
  name: string;
  values(): AsyncIterableIterator<FileHandle | DirectoryHandle>;
  getDirectoryHandle(name: string): Promise<DirectoryHandle>;
  removeEntry(name: string, options?: { recursive?: boolean }): Promise<void>;
  queryPermission?(options?: { mode: "readwrite" }): Promise<FsPermission>;
  requestPermission?(options?: { mode: "readwrite" }): Promise<FsPermission>;
  isSameEntry?(other: DirectoryHandle): Promise<boolean>;
};
type PickerWindow = Window & { showDirectoryPicker?: (options?: { mode: "readwrite" }) => Promise<DirectoryHandle> };

type VideoItem = {
  id: string;
  sourceId: string;
  sourceName: string;
  name: string;
  path: string;
  ext: string;
  size: number;
  modified: number;
  duration: number | null;
  width: number | null;
  height: number | null;
  thumb: string | null;
  cacheSize: number;
  handle: FileHandle;
  parent: DirectoryHandle;
  liked: boolean;
  cleanup: boolean;
  tagIds: string[];
  clicks: number;
};

type SourceFolder = {
  id: string;
  name: string;
  handle: DirectoryHandle;
  lastScan: number;
  videoCount: number;
  totalSize: number;
};
type StoredVideo = Omit<VideoItem, "thumb" | "cacheSize">;

type CachedInfo = { duration: number; width: number; height: number; thumb: Blob };
type VideoMarks = { liked?: boolean; cleanup?: boolean; tagIds?: string[]; clicks?: number };
type CustomTag = { id: string; name: string; color: string };
type TagMatch = "any" | "all";
type Tab = "all" | "liked" | "cleanup";
type DurationFilter = "all" | "short" | "medium" | "long";
type ResolutionFilter = "all" | "480p" | "720p" | "1080p" | "2k" | "4k" | "8k" | "unknown";
type Sort = "newest" | "oldest" | "largest" | "smallest" | "name" | "random" | "popular" | "leastPopular";
type LayoutMode = "comfortable" | "compact" | "list";
type FontSize = "small" | "medium" | "large";
type PageSize = 20 | 50 | 100;

const VIDEO_EXTENSIONS = new Set(["mp4", "mov", "m4v", "webm", "mkv", "avi", "wmv", "flv", "mpeg", "mpg"]);
const DB_NAME = "framebase-local-v1";
const DB_STORE = "cache";
const TAGS_KEY = "framebase-custom-tags";
const DEFAULT_TAG_COLOR = "#7f9f39";

function resolutionTier(video: Pick<VideoItem, "width" | "height">): Exclude<ResolutionFilter, "all"> {
  if (!video.width || !video.height) return "unknown";
  const shortEdge = Math.min(video.width, video.height);
  if (shortEdge < 600) return "480p";
  if (shortEdge < 900) return "720p";
  if (shortEdge < 1260) return "1080p";
  if (shortEdge < 1800) return "2k";
  if (shortEdge < 3240) return "4k";
  return "8k";
}

function resolutionLabel(video: Pick<VideoItem, "width" | "height">) {
  const tier = resolutionTier(video);
  return tier === "unknown" ? null : tier === "2k" || tier === "4k" || tier === "8k" ? tier.toUpperCase() : tier;
}

function MarkIcon({ type }: { type: "liked" | "cleanup" }) {
  return type === "liked" ? (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="M20.8 4.7a5.5 5.5 0 0 0-7.8 0L12 5.8l-1.1-1.1a5.5 5.5 0 0 0-7.8 7.8l1.1 1.1L12 21l7.8-7.4 1.1-1.1a5.5 5.5 0 0 0-.1-7.8Z" />
    </svg>
  ) : (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="M4 7h16M9 7V4h6v3m3 0-1 13H7L6 7m4 4v5m4-5v5" />
    </svg>
  );
}

function TagIcon() {
  return <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M20.6 13.4 13.4 20.6a2 2 0 0 1-2.8 0L3.4 13.4A2 2 0 0 1 3 12V5a2 2 0 0 1 2-2h7a2 2 0 0 1 1.4.6l7.2 7.2a2 2 0 0 1 0 2.6Z" /><path d="M8 8h.01" /></svg>;
}

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, 1);
    request.onupgradeneeded = () => request.result.createObjectStore(DB_STORE);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function dbGet<T>(key: string): Promise<T | undefined> {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const request = db.transaction(DB_STORE, "readonly").objectStore(DB_STORE).get(key);
    request.onsuccess = () => resolve(request.result as T | undefined);
    request.onerror = () => reject(request.error);
  });
}

async function dbSet(key: string, value: unknown) {
  const db = await openDb();
  return new Promise<void>((resolve, reject) => {
    const tx = db.transaction(DB_STORE, "readwrite");
    tx.objectStore(DB_STORE).put(value, key);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

async function dbDelete(key: string) {
  const db = await openDb();
  return new Promise<void>((resolve, reject) => {
    const tx = db.transaction(DB_STORE, "readwrite");
    tx.objectStore(DB_STORE).delete(key);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

async function dbDeletePrefix(prefix: string) {
  const db = await openDb();
  return new Promise<void>((resolve, reject) => {
    const tx = db.transaction(DB_STORE, "readwrite");
    const store = tx.objectStore(DB_STORE);
    const request = store.openCursor();
    request.onsuccess = () => {
      const cursor = request.result;
      if (!cursor) return;
      if (String(cursor.key).startsWith(prefix)) cursor.delete();
      cursor.continue();
    };
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

function marksKey(sourceId: string) { return `framebase-marks:${sourceId}`; }
function readMarks(sourceId: string, legacyName?: string): Record<string, VideoMarks> {
  try {
    return JSON.parse(localStorage.getItem(marksKey(sourceId)) || (legacyName ? localStorage.getItem(marksKey(legacyName)) : null) || "{}");
  } catch { return {}; }
}

function storedVideo(item: VideoItem): StoredVideo {
  const { thumb: _thumb, cacheSize: _cacheSize, ...stored } = item;
  void _thumb; void _cacheSize;
  return stored;
}

function formatBytes(bytes: number) {
  if (!bytes) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  const index = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  return `${(bytes / 1024 ** index).toFixed(index > 2 ? 1 : 0)} ${units[index]}`;
}

function formatDuration(seconds: number | null) {
  if (seconds == null || !Number.isFinite(seconds)) return "--:--";
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);
  return h ? `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}` : `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}

function formatDate(timestamp: number) {
  return new Intl.DateTimeFormat("zh-CN", { year: "numeric", month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" }).format(timestamp);
}

function randomRank(value: string, seed: number) {
  let hash = 2166136261 ^ seed;
  for (let index = 0; index < value.length; index++) hash = Math.imul(hash ^ value.charCodeAt(index), 16777619);
  return hash >>> 0;
}

async function scanDirectory(source: SourceFolder, marks: Record<string, VideoMarks>, control: ScanControl, progress: (count: number) => void) {
  const found: VideoItem[] = [];
  async function walk(directory: DirectoryHandle, parts: string[]) {
    for await (const entry of directory.values()) {
      await control.checkpoint();
      if (entry.kind === "directory") {
        await walk(entry, [...parts, entry.name]);
      } else {
        const ext = entry.name.split(".").pop()?.toLowerCase() || "";
        if (!VIDEO_EXTENSIONS.has(ext)) continue;
        const file = await entry.getFile();
        const path = [...parts, entry.name].join("/");
        const cacheKey = `media:${source.id}:${path}:${file.size}:${file.lastModified}`;
        const cached = await dbGet<CachedInfo>(cacheKey).catch(() => undefined) ?? await dbGet<CachedInfo>(`media:${path}:${file.size}:${file.lastModified}`).catch(() => undefined);
        found.push({
          id: `${source.id}:${path}`,
          sourceId: source.id,
          sourceName: source.name,
          name: entry.name,
          path,
          ext,
          size: file.size,
          modified: file.lastModified,
          duration: cached?.duration ?? null,
          width: cached?.width ?? null,
          height: cached?.height ?? null,
          thumb: cached?.thumb ? URL.createObjectURL(cached.thumb) : null,
          cacheSize: cached?.thumb.size ?? 0,
          handle: entry,
          parent: directory,
          liked: Boolean(marks[path]?.liked),
          cleanup: Boolean(marks[path]?.cleanup),
          tagIds: Array.isArray(marks[path]?.tagIds) ? marks[path].tagIds : [],
          clicks: Number(marks[path]?.clicks || 0),
        });
        if (found.length % 25 === 0) progress(found.length);
      }
    }
  }
  try { await walk(source.handle, []); await control.checkpoint(); progress(found.length); return found; }
  catch (reason) { found.forEach(item => item.thumb && URL.revokeObjectURL(item.thumb)); throw reason; }
}

async function buildPreview(item: VideoItem): Promise<CachedInfo> {
  const file = await item.handle.getFile();
  const url = URL.createObjectURL(file);
  const video = document.createElement("video");
  video.preload = "metadata";
  video.muted = true;
  video.src = url;
  try {
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("读取视频元数据超时")), 10000);
      video.onloadedmetadata = () => { clearTimeout(timer); resolve(); };
      video.onerror = () => { clearTimeout(timer); reject(new Error("无法读取视频元数据")); };
    });
    const seekTo = Math.min(Math.max(video.duration * 0.12, 0.2), Math.max(video.duration - 0.1, 0.2));
    if (Number.isFinite(seekTo)) {
      video.currentTime = seekTo;
      await new Promise<void>((resolve) => { video.onseeked = () => resolve(); setTimeout(resolve, 2200); });
    }
    const width = video.videoWidth || 1280;
    const height = video.videoHeight || 720;
    const canvas = document.createElement("canvas");
    canvas.width = 480;
    canvas.height = Math.round(480 * Math.min(height / width, 0.75));
    canvas.getContext("2d")?.drawImage(video, 0, 0, canvas.width, canvas.height);
    const thumb = await new Promise<Blob>((resolve, reject) => canvas.toBlob(blob => blob ? resolve(blob) : reject(new Error("缩略图生成失败")), "image/webp", .76));
    return { duration: video.duration || 0, width, height, thumb };
  } finally {
    video.pause();
    video.removeAttribute("src");
    video.load();
    URL.revokeObjectURL(url);
  }
}

function HoverPreview({ item, onOpen }: { item: VideoItem; onOpen: (extend?: boolean) => void }) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const urlRef = useRef<string | null>(null);
  const activeRef = useRef(false);
  const segmentTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const segmentIndexRef = useRef(0);
  const [hovering, setHovering] = useState(false);
  const [segment, setSegment] = useState(0);
  const segmentFractions = useRef([0.06, 0.27, 0.49, 0.71, 0.9]);

  function playSegment(index: number) {
    const video = videoRef.current;
    if (!video || !Number.isFinite(video.duration) || video.duration <= 0) return;
    const target = Math.min(video.duration * segmentFractions.current[index], Math.max(video.duration - .25, 0));
    video.currentTime = target;
    segmentIndexRef.current = index;
    setSegment(index);
    void video.play().catch(() => undefined);
  }

  async function start() {
    activeRef.current = true;
    setHovering(true);
    const video = videoRef.current;
    if (!video || urlRef.current) return;
    let file: File;
    try { file = await item.handle.getFile(); } catch { stop(); return; }
    if (!activeRef.current) return;
    urlRef.current = URL.createObjectURL(file);
    video.src = urlRef.current;
    video.onloadedmetadata = () => {
      playSegment(0);
      segmentTimerRef.current = setInterval(() => {
        const next = (segmentIndexRef.current + 1) % segmentFractions.current.length;
        playSegment(next);
      }, 2600);
    };
  }
  function stop() {
    activeRef.current = false;
    setHovering(false);
    segmentIndexRef.current = 0;
    setSegment(0);
    if (segmentTimerRef.current) clearInterval(segmentTimerRef.current);
    segmentTimerRef.current = null;
    const video = videoRef.current;
    if (video) { video.pause(); video.removeAttribute("src"); video.load(); }
    if (urlRef.current) URL.revokeObjectURL(urlRef.current);
    urlRef.current = null;
  }
  useEffect(() => stop, []);

  return (
    <div className="thumb real-thumb" onMouseEnter={start} onMouseLeave={stop} onClick={event => onOpen(event.shiftKey)} role="button" tabIndex={0} onKeyDown={event => event.key === "Enter" && onOpen(event.shiftKey)}>
      {/* Blob URLs are local cache entries and cannot be optimized by next/image. */}
      {/* eslint-disable-next-line @next/next/no-img-element */}
      {item.thumb ? <img src={item.thumb} alt="" /> : <div className="thumb-placeholder"><span>{item.ext.toUpperCase()}</span></div>}
      <video ref={videoRef} className={hovering ? "hover-video visible" : "hover-video"} muted playsInline preload="none" />
      <span className="play">▶</span>
      {resolutionLabel(item) && <span className="resolution-badge">{resolutionLabel(item)}</span>}
      <span className="duration">{formatDuration(item.duration)}</span>
      {hovering && <span className="hover-hint">节选 {segment + 1}/5</span>}
    </div>
  );
}

export default function Home() {
  const [sources, setSources] = useState<SourceFolder[]>([]);
  const [sourceFilter, setSourceFilter] = useState("all");
  const [videos, setVideos] = useState<VideoItem[]>([]);
  const [loading, setLoading] = useState(false);
  const scanControlRef = useRef<ScanControl | null>(null);
  const [scanTask, setScanTask] = useState<{ name: string; phase: string; count: number; total: number; failed: number; paused: boolean; active: boolean } | null>(null);
  const selectionAnchor = useRef<string | null>(null);
  const [shortcutHelp, setShortcutHelp] = useState(false);
  const [queueMode, setQueueMode] = useState<"sequence" | "random" | "repeat">("sequence");
  const [autoAdvance, setAutoAdvance] = useState(false);
  const [queueQuery, setQueueQuery] = useState("");
  useEffect(() => () => { if (scanControlRef.current) scanControlRef.current.cancelled = true; }, []);
  const [previewFailures, setPreviewFailures] = useState<Set<string>>(new Set());
  const [retryingPreviews, setRetryingPreviews] = useState(false);
  const visiblePreviewIds = useRef<Set<string>>(new Set());
  const [tab, setTab] = useState<Tab>("all");
  const [query, setQuery] = useState("");
  const [format, setFormat] = useState("all");
  const [durationFilter, setDurationFilter] = useState<DurationFilter>("all");
  const [resolutionFilter, setResolutionFilter] = useState<ResolutionFilter>("all");
  const [sort, setSort] = useState<Sort>("newest");
  const [randomSeed, setRandomSeed] = useState(0);
  const [popularitySeed, setPopularitySeed] = useState(0);
  const [pageSize, setPageSize] = useState<PageSize>(50);
  const [currentPage, setCurrentPage] = useState(1);
  const [layout, setLayout] = useState<LayoutMode>("comfortable");
  const [fontSize, setFontSize] = useState<FontSize>("medium");
  const [customTags, setCustomTags] = useState<CustomTag[]>([]);
  const [selectedTagIds, setSelectedTagIds] = useState<Set<string>>(new Set());
  const [tagMatch, setTagMatch] = useState<TagMatch>("any");
  const [tagManagerOpen, setTagManagerOpen] = useState(false);
  const [tagFilterOpen, setTagFilterOpen] = useState(false);
  const [taggingVideoId, setTaggingVideoId] = useState<string | null>(null);
  const [newTagName, setNewTagName] = useState("");
  const [newTagColor, setNewTagColor] = useState(DEFAULT_TAG_COLOR);
  const [editingTagId, setEditingTagId] = useState<string | null>(null);
  const [editingTagName, setEditingTagName] = useState("");
  const [preferencesReady, setPreferencesReady] = useState(false);
  const [selecting, setSelecting] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [player, setPlayer] = useState<VideoItem | null>(null);
  const [playQueue, setPlayQueue] = useState<string[]>([]);
  const originalQueueRef = useRef<string[]>([]);
  const [switchingVideo, setSwitchingVideo] = useState(false);
  const playRequestRef = useRef(0);
  const [playerUrl, setPlayerUrl] = useState<string | null>(null);
  const [playerFeedback, setPlayerFeedback] = useState("");
  const [playerTime, setPlayerTime] = useState(0);
  const [playerDuration, setPlayerDuration] = useState(0);
  const [sourceDetails, setSourceDetails] = useState<string | null>(null);
  const [sourcePanelOpen, setSourcePanelOpen] = useState(false);
  const feedbackTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const playerVideoRef = useRef<HTMLVideoElement>(null);
  const savedVolumeRef = useRef({ volume: 1, muted: false });
  const playerOpenRef = useRef(false);
  const playerUrlRef = useRef<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (window.location.hostname === "127.0.0.1") {
      const originalStorageUrl = new URL(window.location.href);
      originalStorageUrl.hostname = "localhost";
      window.location.replace(originalStorageUrl);
    }
  }, []);

  useEffect(() => {
    const savedLayout = localStorage.getItem("framebase-layout");
    const savedFontSize = localStorage.getItem("framebase-font-size");
    const savedPageSize = Number(localStorage.getItem("framebase-page-size"));
    let savedTags: CustomTag[] = [];
    try {
      const parsed = JSON.parse(localStorage.getItem(TAGS_KEY) || "[]") as CustomTag[];
      if (Array.isArray(parsed)) savedTags = parsed.filter(tag => tag && typeof tag.id === "string" && typeof tag.name === "string" && typeof tag.color === "string");
    } catch { /* Invalid saved tags are ignored. */ }
    try {
      const savedVolume = JSON.parse(localStorage.getItem("framebase-player-volume") || "null") as { volume?: number; muted?: boolean } | null;
      if (savedVolume && typeof savedVolume.volume === "number") savedVolumeRef.current = { volume: Math.min(1, Math.max(0, savedVolume.volume)), muted: Boolean(savedVolume.muted) };
    } catch { /* Invalid old preferences fall back to the browser default. */ }
    queueMicrotask(() => {
      if (savedLayout === "compact" || savedLayout === "list") setLayout(savedLayout);
      if (savedFontSize === "small" || savedFontSize === "large") setFontSize(savedFontSize);
      if (savedPageSize === 20 || savedPageSize === 50 || savedPageSize === 100) setPageSize(savedPageSize);
      setCustomTags(savedTags);
      setPreferencesReady(true);
    });
  }, []);

  useEffect(() => { if (preferencesReady) { document.documentElement.dataset.fontSize = fontSize; localStorage.setItem("framebase-font-size", fontSize); } }, [fontSize, preferencesReady]);
  useEffect(() => { if (preferencesReady) localStorage.setItem("framebase-layout", layout); }, [layout, preferencesReady]);
  useEffect(() => { if (preferencesReady) localStorage.setItem("framebase-page-size", String(pageSize)); }, [pageSize, preferencesReady]);

  const dismissPlayer = useCallback(() => {
    playRequestRef.current += 1;
    setSwitchingVideo(false);
    if (playerUrlRef.current) URL.revokeObjectURL(playerUrlRef.current);
    playerUrlRef.current = null;
    playerOpenRef.current = false;
    setPlayer(null);
    setPlayerUrl(null);
    setPlayerFeedback("");
    setPlayerTime(0);
    setPlayerDuration(0);
  }, []);

  useEffect(() => {
    const handleBack = () => { if (playerOpenRef.current) dismissPlayer(); };
    window.addEventListener("popstate", handleBack);
    return () => window.removeEventListener("popstate", handleBack);
  }, [dismissPlayer]);

  usePlayerShortcuts(Boolean(player), playerVideoRef, () => {
    if (shortcutHelp) setShortcutHelp(false); else requestClosePlayer();
  });
  useEffect(() => {
    if (!shortcutHelp || player) return;
    const close = (event: KeyboardEvent) => { if (event.key === "Escape") setShortcutHelp(false); };
    window.addEventListener("keydown", close);
    return () => window.removeEventListener("keydown", close);
  }, [shortcutHelp, player]);

  const persistMarks = useCallback((next: VideoItem[]) => {
    sources.forEach(source => {
      const marks: Record<string, VideoMarks> = {};
      next.filter(video => video.sourceId === source.id).forEach(video => {
        if (video.liked || video.cleanup || video.clicks || video.tagIds.length) marks[video.path] = { liked: video.liked, cleanup: video.cleanup, tagIds: video.tagIds, clicks: video.clicks };
      });
      localStorage.setItem(marksKey(source.id), JSON.stringify(marks));
    });
  }, [sources]);

  const buildCache = useCallback(async (items: VideoItem[], retryIds?: Set<string>, control?: ScanControl) => {
    const pending = items.filter(item => !item.thumb && (!retryIds || retryIds.has(item.id)));
    let cursor = 0;
    setScanTask(current => current && control ? { ...current, phase: "生成预览", count: 0, total: pending.length } : current);
    async function worker() {
      while (cursor < pending.length) {
        await control?.checkpoint();
        if (cursor >= pending.length) break;
        const item = pending[cursor++];
        try {
          const info = await buildPreview(item);
          await control?.checkpoint();
          const file = await item.handle.getFile();
          await dbSet(`media:${item.sourceId}:${item.path}:${file.size}:${file.lastModified}`, info);
          const thumbUrl = URL.createObjectURL(info.thumb);
          item.duration = info.duration; item.width = info.width; item.height = info.height; item.thumb = thumbUrl; item.cacheSize = info.thumb.size;
          setVideos(current => current.map(video => video.id === item.id ? { ...video, duration: info.duration, width: info.width, height: info.height, thumb: thumbUrl, cacheSize: info.thumb.size } : video));
          setPreviewFailures(current => { const next = new Set(current); next.delete(item.id); return next; });
        } catch (reason) {
          if (control?.cancelled) throw reason;
          setPreviewFailures(current => new Set(current).add(item.id));
          setScanTask(current => current && control ? { ...current, failed: current.failed + 1 } : current);
        }
        setScanTask(current => current && control ? { ...current, count: current.count + 1 } : current);
        await new Promise(resolve => setTimeout(resolve, 20));
      }
    }
    const results = await Promise.allSettled([worker(), worker()]);
    const rejected = results.find(result => result.status === "rejected");
    if (rejected?.status === "rejected") throw rejected.reason;
    const bySource = new Map<string, VideoItem[]>();
    items.forEach(item => bySource.set(item.sourceId, [...(bySource.get(item.sourceId) || []), item]));
    await Promise.all([...bySource].map(([sourceId, sourceItems]) => {
      const marks = readMarks(sourceId);
      return dbSet(`library:${sourceId}`, sourceItems.map(item => ({ ...storedVideo(item), liked: Boolean(marks[item.path]?.liked), cleanup: Boolean(marks[item.path]?.cleanup), tagIds: marks[item.path]?.tagIds ?? [], clicks: marks[item.path]?.clicks ?? 0 })));
    }));
  }, []);

  const hydrateCachedPreviews = useCallback(async (items: VideoItem[]) => {
    const ordered = [...items].sort((a, b) => b.modified - a.modified);
    let cursor = 0;
    async function worker() {
      while (cursor < items.length) {
        const preferred = ordered.findIndex((item, index) => index >= cursor && visiblePreviewIds.current.has(item.id));
        if (preferred > cursor) [ordered[cursor], ordered[preferred]] = [ordered[preferred], ordered[cursor]];
        const item = ordered[cursor++];
        const cached = await dbGet<CachedInfo>(`media:${item.sourceId}:${item.path}:${item.size}:${item.modified}`).catch(() => undefined)
          ?? await dbGet<CachedInfo>(`media:${item.path}:${item.size}:${item.modified}`).catch(() => undefined);
        if (cached) {
          const url = URL.createObjectURL(cached.thumb);
          setVideos(current => current.map(video => video.id === item.id ? { ...video, thumb: url, cacheSize: cached.thumb.size, duration: cached.duration, width: cached.width, height: cached.height } : video));
        } else {
          setPreviewFailures(current => new Set(current).add(item.id));
        }
      }
    }
    await Promise.all(Array.from({ length: Math.min(6, Math.max(items.length, 1)) }, () => worker()));
  }, []);

  const loadSource = useCallback(async (source: SourceFolder) => {
    if (scanControlRef.current) return false;
    const control = new ScanControl();
    scanControlRef.current = control;
    setLoading(true); setError(null);
    setScanTask({ name: source.name, phase: "扫描目录", count: 0, total: 0, failed: 0, paused: false, active: true });
    try {
      const items = await scanDirectory(source, readMarks(source.id, source.name), control, count => setScanTask(current => current && ({ ...current, count })));
      const latestMarks = readMarks(source.id, source.name);
      items.forEach(item => { const mark = latestMarks[item.path]; item.liked = Boolean(mark?.liked); item.cleanup = Boolean(mark?.cleanup); item.tagIds = mark?.tagIds ?? []; item.clicks = mark?.clicks ?? 0; });
      const updatedSource = { ...source, lastScan: Date.now(), videoCount: items.length, totalSize: items.reduce((sum, item) => sum + item.size, 0) };
      await dbSet(`library:${source.id}`, items.map(storedVideo));
      setSources(current => {
        const next = current.some(item => item.id === source.id) ? current.map(item => item.id === source.id ? updatedSource : item) : [...current, updatedSource];
        void dbSet("source-folders", next);
        return next;
      });
      setVideos(current => [...current.filter(video => video.sourceId !== source.id), ...items]);
      setSelected(current => new Set([...current].filter(id => !id.startsWith(`${source.id}:`) || items.some(item => item.id === id))));
      setLoading(false);
      await buildCache(items, undefined, control);
      setScanTask(current => current && ({ ...current, phase: "已完成", active: false, paused: false }));
      return true;
    } catch (reason) {
      setScanTask(current => current && ({ ...current, phase: control.cancelled ? "已取消" : "任务失败", active: false, paused: false }));
      if (!control.cancelled) setError(reason instanceof Error ? reason.message : "无法读取这个文件夹");
      return false;
    } finally { setLoading(false); scanControlRef.current = null; }
  }, [buildCache]);

  async function retryPreviews(all = false) {
    if (scanControlRef.current) return;
    const control = new ScanControl(); scanControlRef.current = control;
    setRetryingPreviews(true);
    setScanTask({ name: all ? "未完成预览" : "失败预览", phase: "生成预览", count: 0, total: failedPreviews.length, failed: 0, paused: false, active: true });
    try {
      await buildCache(videos, all ? undefined : new Set(failedPreviews.map(video => video.id)), control);
      setScanTask(current => current && ({ ...current, phase: "已完成", active: false, paused: false }));
    } catch (reason) {
      setScanTask(current => current && ({ ...current, phase: control.cancelled ? "已取消" : "任务失败", active: false, paused: false }));
      if (!control.cancelled) setError(reason instanceof Error ? reason.message : "无法保存预览缓存");
    } finally { scanControlRef.current = null; setRetryingPreviews(false); }
  }

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      let savedSources = await dbGet<SourceFolder[]>("source-folders").catch(() => undefined) || [];
      if (!savedSources.length) {
        const legacyHandle = await dbGet<DirectoryHandle>("root-handle").catch(() => undefined);
        if (legacyHandle) {
          savedSources = [{ id: crypto.randomUUID(), name: legacyHandle.name, handle: legacyHandle, lastScan: 0, videoCount: 0, totalSize: 0 }];
          await dbSet("source-folders", savedSources);
        }
      }
      if (cancelled) return;
      setSources(savedSources);
      const cachedLibraries = await Promise.all(savedSources.map(source => dbGet<StoredVideo[]>(`library:${source.id}`).catch(() => undefined)));
      const restored = cachedLibraries.flatMap((records, index) => {
        const source = savedSources[index];
        const marks = readMarks(source.id, source.name);
        return (records || []).map(record => ({ ...record, thumb: null, cacheSize: 0, liked: Boolean(marks[record.path]?.liked), cleanup: Boolean(marks[record.path]?.cleanup), tagIds: Array.isArray(marks[record.path]?.tagIds) ? (marks[record.path].tagIds ?? []) : Array.isArray(record.tagIds) ? record.tagIds : [], clicks: Number(marks[record.path]?.clicks ?? record.clicks ?? 0) }));
      });
      if (cancelled) return;
      setVideos(restored);
      if (restored.length) void hydrateCachedPreviews(restored);
      for (let index = 0; index < savedSources.length; index++) {
        if (cachedLibraries[index]?.length) continue;
        const permission = await savedSources[index].handle.queryPermission?.({ mode: "readwrite" });
        if (permission === "granted" && !cancelled && !await loadSource(savedSources[index])) break;
      }
    })();
    return () => { cancelled = true; };
  }, [hydrateCachedPreviews, loadSource]);

  async function chooseFolder() {
    if (scanControlRef.current) { setNotice("请先完成或取消当前扫描任务。"); return; }
    if (!(window as PickerWindow).showDirectoryPicker) { setError("当前浏览器不支持文件夹访问。请使用最新版 Chrome 或 Edge 打开此页面。"); return; }
    try {
      const handle = await (window as PickerWindow).showDirectoryPicker!({ mode: "readwrite" });
      let existing: SourceFolder | undefined;
      for (const source of sources) {
        if (source.handle.isSameEntry && await source.handle.isSameEntry(handle)) { existing = source; break; }
      }
      if (!existing) existing = sources.find(source => source.name === handle.name && source.handle === handle);
      const source = existing || { id: crypto.randomUUID(), name: handle.name, handle, lastScan: 0, videoCount: 0, totalSize: 0 };
      if (!existing) {
        const next = [...sources, source];
        setSources(next);
        await dbSet("source-folders", next);
      }
      await loadSource(source);
    } catch (reason) {
      if ((reason as DOMException)?.name !== "AbortError") setError("未能打开文件夹，请确认已授予读写权限。");
    }
  }

  async function rescanSource(source: SourceFolder) {
    if (scanControlRef.current) return false;
    const currentPermission = await source.handle.queryPermission?.({ mode: "readwrite" });
    const permission = currentPermission === "granted" ? currentPermission : await source.handle.requestPermission?.({ mode: "readwrite" });
    if (permission === "granted") return await loadSource(source); else setError(`需要“${source.name}”的读写权限才能重新扫描。`);
  }

  async function rescanAllSources() {
    for (const source of sources) { if (!await rescanSource(source)) break; }
  }

  async function removeSource(source: SourceFolder) {
    if (scanControlRef.current) { setNotice("请先完成或取消扫描再移除来源。"); return; }
    const nextSources = sources.filter(item => item.id !== source.id);
    setSources(nextSources);
    await dbSet("source-folders", nextSources);
    setVideos(current => {
      current.filter(video => video.sourceId === source.id).forEach(video => video.thumb && URL.revokeObjectURL(video.thumb));
      return current.filter(video => video.sourceId !== source.id);
    });
    await dbDelete(`library:${source.id}`);
    localStorage.removeItem(marksKey(source.id));
    if (sourceFilter === source.id) setSourceFilter("all");
    if (sourceDetails === source.id) setSourceDetails(null);
    setNotice(`已从视频库移除“${source.name}”，源文件没有被删除。`);
  }

  function updateMark(id: string, key: "liked" | "cleanup") {
    setVideos(current => {
      const next = current.map(video => video.id === id ? { ...video, [key]: !video[key] } : video);
      persistMarks(next);
      return next;
    });
  }

  function saveCustomTags(next: CustomTag[]) {
    setCustomTags(next);
    localStorage.setItem(TAGS_KEY, JSON.stringify(next));
  }

  function createTag() {
    const name = newTagName.trim();
    if (!name) { setError("请输入标签名称。"); return; }
    if (customTags.some(tag => tag.name.toLocaleLowerCase("zh-CN") === name.toLocaleLowerCase("zh-CN"))) { setError("已经存在同名标签。"); return; }
    const next = [...customTags, { id: crypto.randomUUID(), name: name.slice(0, 24), color: newTagColor }];
    saveCustomTags(next);
    setNewTagName("");
    setNotice(`已创建标签“${name.slice(0, 24)}”。`);
  }

  function beginRenameTag(tag: CustomTag) {
    setEditingTagId(tag.id);
    setEditingTagName(tag.name);
  }

  function saveRenamedTag() {
    if (!editingTagId) return;
    const name = editingTagName.trim().slice(0, 24);
    if (!name) { setError("标签名称不能为空。"); return; }
    if (customTags.some(tag => tag.id !== editingTagId && tag.name.toLocaleLowerCase("zh-CN") === name.toLocaleLowerCase("zh-CN"))) { setError("已经存在同名标签。"); return; }
    saveCustomTags(customTags.map(tag => tag.id === editingTagId ? { ...tag, name } : tag));
    setEditingTagId(null);
    setEditingTagName("");
  }

  function changeTagColor(id: string, color: string) {
    saveCustomTags(customTags.map(tag => tag.id === id ? { ...tag, color } : tag));
  }

  function deleteTag(id: string) {
    const removed = customTags.find(tag => tag.id === id);
    saveCustomTags(customTags.filter(tag => tag.id !== id));
    setSelectedTagIds(current => { const next = new Set(current); next.delete(id); return next; });
    setVideos(current => {
      const next = current.map(video => video.tagIds.includes(id) ? { ...video, tagIds: video.tagIds.filter(tagId => tagId !== id) } : video);
      persistMarks(next);
      return next;
    });
    setPlayer(current => current?.tagIds.includes(id) ? { ...current, tagIds: current.tagIds.filter(tagId => tagId !== id) } : current);
    if (editingTagId === id) setEditingTagId(null);
    if (removed) setNotice(`已删除标签“${removed.name}”，视频文件未受影响。`);
  }

  function toggleVideoTag(videoId: string, tagId: string) {
    const enabled = !videos.find(video => video.id === videoId)?.tagIds.includes(tagId);
    setVideos(current => {
      const next = current.map(video => {
        if (video.id !== videoId) return video;
        return { ...video, tagIds: enabled ? [...video.tagIds, tagId] : video.tagIds.filter(id => id !== tagId) };
      });
      persistMarks(next);
      return next;
    });
    setPlayer(current => current?.id === videoId ? { ...current, tagIds: enabled ? [...current.tagIds, tagId] : current.tagIds.filter(id => id !== tagId) } : current);
  }

  function toggleTagFilter(id: string) {
    setSelectedTagIds(current => { const next = new Set(current); if (next.has(id)) next.delete(id); else next.add(id); return next; });
    setCurrentPage(1);
  }

  function updatePlayerMark(key: "liked" | "cleanup") {
    if (!player) return;
    const enabled = !player[key];
    updateMark(player.id, key);
    setPlayer(current => current ? { ...current, [key]: enabled } : current);
    setPlayerFeedback(key === "liked" ? (enabled ? "已点赞并保存" : "已取消点赞") : (enabled ? "已加入待清理" : "已移出待清理"));
    if (feedbackTimerRef.current) clearTimeout(feedbackTimerRef.current);
    feedbackTimerRef.current = setTimeout(() => setPlayerFeedback(""), 1800);
  }

  async function openPlayer(item: VideoItem, switching = false, queue: string[] = []) {
    if (switchingVideo) return;
    const requestId = ++playRequestRef.current;
    setSwitchingVideo(true);
    try {
      const file = await item.handle.getFile();
      if (requestId !== playRequestRef.current) return;
      const url = URL.createObjectURL(file);
      if (playerUrlRef.current) URL.revokeObjectURL(playerUrlRef.current);
      playerOpenRef.current = true;
      playerUrlRef.current = url;
      const currentState = typeof history.state === "object" && history.state ? history.state : {};
      if (!switching) {
        setPlayQueue(queue); originalQueueRef.current = queue; setQueueMode("sequence"); setQueueQuery("");
        history.pushState({ ...currentState, framebasePlayer: true }, "");
      }
      const openedItem = { ...item, clicks: item.clicks + 1 };
      setVideos(current => {
        const next = current.map(video => video.id === item.id ? { ...video, clicks: video.clicks + 1 } : video);
        persistMarks(next);
        return next;
      });
      if (sort === "popular" || sort === "leastPopular") setPopularitySeed(crypto.getRandomValues(new Uint32Array(1))[0]);
      setPlayerTime(0);
      setPlayerFeedback("");
      setPlayerDuration(item.duration || 0);
      setPlayer(openedItem); setPlayerUrl(url);
    } catch {
      if (requestId !== playRequestRef.current) return;
      if (switching) { setPlayerFeedback(`无法打开“${item.name}”，请重新授权来源文件夹。`); return; }
      setError(`需要重新授权“${item.sourceName}”后才能播放，请点击来源卡片上的重新扫描按钮。`);
    } finally {
      if (requestId === playRequestRef.current) setSwitchingVideo(false);
    }
  }

  function requestClosePlayer() {
    if (history.state?.framebasePlayer) history.back();
    else dismissPlayer();
  }

  function applySavedVolume(video: HTMLVideoElement) {
    video.volume = savedVolumeRef.current.volume;
    video.muted = savedVolumeRef.current.muted;
  }

  function savePlayerVolume(video: HTMLVideoElement) {
    const preference = { volume: video.volume, muted: video.muted };
    savedVolumeRef.current = preference;
    localStorage.setItem("framebase-player-volume", JSON.stringify(preference));
  }

  function shuffleVideos() {
    setRandomSeed(crypto.getRandomValues(new Uint32Array(1))[0]);
    setSort("random");
    setCurrentPage(1);
  }

  function sortByClicks(direction: "popular" | "leastPopular") {
    setPopularitySeed(crypto.getRandomValues(new Uint32Array(1))[0]);
    setSort(direction);
    setCurrentPage(1);
  }

  function reshuffleEqualClicks() {
    setPopularitySeed(crypto.getRandomValues(new Uint32Array(1))[0]);
  }

  const filtered = useMemo(() => {
    const lower = query.trim().toLowerCase();
    return videos.filter(video => {
      if (sourceFilter !== "all" && video.sourceId !== sourceFilter) return false;
      if (tab === "liked" && !video.liked) return false;
      if (tab === "cleanup" && !video.cleanup) return false;
      const videoTagNames = video.tagIds.map(id => customTags.find(tag => tag.id === id)?.name.toLowerCase() || "");
      if (lower && !video.name.toLowerCase().includes(lower) && !video.path.toLowerCase().includes(lower) && !video.sourceName.toLowerCase().includes(lower) && !videoTagNames.some(name => name.includes(lower))) return false;
      if (selectedTagIds.size) {
        const matches = [...selectedTagIds].filter(id => video.tagIds.includes(id)).length;
        if (tagMatch === "all" ? matches !== selectedTagIds.size : matches === 0) return false;
      }
      if (format !== "all" && video.ext !== format) return false;
      if (resolutionFilter !== "all" && resolutionTier(video) !== resolutionFilter) return false;
      if (durationFilter === "short" && (video.duration ?? Infinity) >= 60) return false;
      if (durationFilter === "medium" && ((video.duration ?? 0) < 60 || (video.duration ?? Infinity) > 600)) return false;
      if (durationFilter === "long" && (video.duration ?? 0) <= 600) return false;
      return true;
    }).sort((a, b) => sort === "newest" ? b.modified - a.modified : sort === "oldest" ? a.modified - b.modified : sort === "largest" ? b.size - a.size : sort === "smallest" ? a.size - b.size : sort === "name" ? a.name.localeCompare(b.name, "zh-CN") : sort === "popular" ? b.clicks - a.clicks || randomRank(a.id, popularitySeed) - randomRank(b.id, popularitySeed) : sort === "leastPopular" ? a.clicks - b.clicks || randomRank(a.id, popularitySeed) - randomRank(b.id, popularitySeed) : randomRank(a.id, randomSeed) - randomRank(b.id, randomSeed));
  }, [videos, sourceFilter, tab, query, customTags, selectedTagIds, tagMatch, format, resolutionFilter, durationFilter, sort, randomSeed, popularitySeed]);

  const selectedVideos = videos.filter(video => selected.has(video.id));
  const videoById = useMemo(() => new Map(videos.map(video => [video.id, video])), [videos]);
  const availableQueue = playQueue.filter(id => videoById.has(id));
  const queuePosition = player ? availableQueue.indexOf(player.id) : -1;
  const previousVideo = queuePosition > 0 ? videos.find(video => video.id === availableQueue[queuePosition - 1]) : undefined;
  const nextVideo = queuePosition >= 0 ? videos.find(video => video.id === availableQueue[queuePosition + 1]) : undefined;
  const totalPages = Math.max(1, Math.ceil(filtered.length / pageSize));
  const visiblePage = Math.min(currentPage, totalPages);
  const pageStart = (visiblePage - 1) * pageSize;
  const paginatedVideos = filtered.slice(pageStart, pageStart + pageSize);
  const filteredIds = new Set(filtered.map(video => video.id));
  const pageIds = new Set(paginatedVideos.map(video => video.id));
  const hiddenSelectionCount = selectedVideos.filter(video => !filteredIds.has(video.id)).length;
  const offPageSelectionCount = selectedVideos.filter(video => !pageIds.has(video.id)).length;
  useEffect(() => {
    visiblePreviewIds.current = new Set(filtered.slice(pageStart, pageStart + pageSize).map(video => video.id));
  }, [filtered, pageStart, pageSize]);
  const totalSize = videos.reduce((sum, video) => sum + video.size, 0);
  const selectedSize = selectedVideos.reduce((sum, video) => sum + video.size, 0);
  const formats = [...new Set(videos.map(video => video.ext))].sort();
  const cachedCount = videos.filter(video => video.thumb).length;
  const failedPreviews = videos.filter(video => !video.thumb && previewFailures.has(video.id));
  const cachePercent = videos.length ? Math.min(100, Math.round(cachedCount / videos.length * 100)) : 0;
  const detailedSource = sources.find(source => source.id === sourceDetails);
  const activeSource = sources.find(source => source.id === sourceFilter);
  const activeSourceVideoCount = activeSource ? videos.filter(video => video.sourceId === activeSource.id).length : videos.length;
  const detailedSourceVideos = detailedSource ? videos.filter(video => video.sourceId === detailedSource.id) : [];
  const detailedSourceCacheSize = detailedSourceVideos.reduce((sum, video) => sum + video.cacheSize, 0);
  const detailedSourceCachedCount = detailedSourceVideos.filter(video => video.cacheSize > 0).length;

  function toggleSelection(id: string, extend = false) {
    const anchor = selectionAnchor.current;
    setSelected(current => selectRange(current, filtered.map(video => video.id), anchor, id, extend));
    if (!extend || !anchor || !filtered.some(video => video.id === anchor)) selectionAnchor.current = id;
  }

  function changeQueueMode(mode: "sequence" | "random" | "repeat") {
    setQueueMode(mode);
    if (mode === "sequence") setPlayQueue(originalQueueRef.current.filter(id => videoById.has(id)));
    if (mode === "random") {
      const rest = availableQueue.filter(id => id !== player?.id);
      for (let index = rest.length - 1; index > 0; index--) {
        const other = Math.floor(Math.random() * (index + 1));
        [rest[index], rest[other]] = [rest[other], rest[index]];
      }
      setPlayQueue(player ? [player.id, ...rest] : rest);
    }
  }

  async function deleteSelected() {
    if (scanControlRef.current) { setError("请先完成或取消扫描任务，再删除文件。"); return; }
    const deleting = [...selectedVideos];
    const failedIds: string[] = [];
    for (const video of deleting) {
      try { await video.parent.removeEntry(video.name); } catch { failedIds.push(video.id); }
    }
    const deletedIds = new Set(deleting.filter(video => !failedIds.includes(video.id)).map(video => video.id));
    setVideos(current => {
      const next = current.filter(video => !deletedIds.has(video.id));
      persistMarks(next);
      const affectedSourceIds = new Set(deleting.map(video => video.sourceId));
      affectedSourceIds.forEach(sourceId => void dbSet(`library:${sourceId}`, next.filter(video => video.sourceId === sourceId).map(storedVideo)));
      return next;
    });
    const deleted = deleting.filter(video => deletedIds.has(video.id));
    setSources(current => {
      const next = current.map(source => {
        const removed = deleted.filter(video => video.sourceId === source.id);
        return removed.length ? { ...source, videoCount: Math.max(0, source.videoCount - removed.length), totalSize: Math.max(0, source.totalSize - removed.reduce((sum, video) => sum + video.size, 0)) } : source;
      });
      void dbSet("source-folders", next);
      return next;
    });
    setSelected(new Set()); setSelecting(false); setConfirmDelete(false);
    setNotice(failedIds.length ? `已删除 ${deleting.length - failedIds.length} 个，${failedIds.length} 个删除失败（可能缺少权限或文件正在使用）。` : `已永久删除 ${deleting.length} 个视频。`);
  }

  async function clearCache() {
    if (scanControlRef.current) { setNotice("请先完成或取消扫描再清除缓存。"); return; }
    await dbDeletePrefix("media:");
    videos.forEach(video => video.thumb && URL.revokeObjectURL(video.thumb));
    setVideos(current => current.map(video => ({ ...video, thumb: null, cacheSize: 0 })));
    setNotice("预览缓存已清除，源文件夹和解析清单仍然保留。重新扫描可再次构建预览。");
  }

  return (
    <main className="shell">
      <header className="topbar">
        <span className="brand"><span className="brand-mark">F</span> Framebase</span>
        <label className="search"><span>⌕</span><input value={query} onChange={event => { setQuery(event.target.value); setCurrentPage(1); }} placeholder="搜索名称或路径…" aria-label="搜索视频" /></label>
        <div className="header-actions">
          <a className="lan-link" href="/lan" title="设置手机局域网只读访问">局域网</a>
          <button className="shortcut-toggle" onClick={() => setShortcutHelp(value => !value)} aria-expanded={shortcutHelp}>快捷键</button><span className="local-badge">仅本机</span>
          <div className="font-controls" aria-label="字体大小">
            <button className={fontSize === "small" ? "active" : ""} onClick={() => setFontSize("small")} title="较小字号" aria-label="较小字号">A−</button>
            <button className={fontSize === "medium" ? "active" : ""} onClick={() => setFontSize("medium")} title="标准字号" aria-label="标准字号">A</button>
            <button className={fontSize === "large" ? "active" : ""} onClick={() => setFontSize("large")} title="超大字号" aria-label="超大字号">A＋</button>
          </div>
          <ThemeSelector />
        </div>
      </header>

      {error && <div className="toast error-toast"><span>{error}</span><button onClick={() => setError(null)}>×</button></div>}
      {notice && <div className="toast"><span>{notice}</span><button onClick={() => setNotice(null)}>×</button></div>}

      {shortcutHelp && <section className="shortcut-help" role="dialog" aria-label="快捷键说明"><button onClick={() => setShortcutHelp(false)} aria-label="关闭快捷键说明">×</button><strong>播放器快捷键</strong><p>空格：播放 / 暂停 / ← / →：快退 / 快进 10 秒 / ↑ / ↓：音量 ±5%</p><p>M：静音 / F：全屏 / Esc：退出全屏或关闭播放器</p><p>选择模式：按住 Shift 点击卡片或勾选按钮，连续选中两个位置之间的视频（支持跨页）。输入文字时不触发播放快捷键。</p></section>}
      {scanTask && <section className="scan-task" aria-label="扫描任务"><div><strong>{scanTask.name} · {scanTask.paused ? "已暂停" : scanTask.phase}</strong><p>{scanTask.phase === "扫描目录" ? `已发现 ${scanTask.count} 个视频` : `已处理 ${scanTask.count} / ${scanTask.total} 个预览`}{scanTask.failed > 0 ? ` · ${scanTask.failed} 个失败` : ""}</p>{scanTask.total > 0 && <progress value={scanTask.count} max={scanTask.total} aria-label="预览生成进度" />}<small>暂停或取消在当前文件处理结束后生效；取消目录扫描会保留原清单，已完成的预览会保留。</small></div><div className="scan-task-actions">{scanTask.active ? <><button onClick={() => { const control = scanControlRef.current; if (!control) return; control.paused = !control.paused; setScanTask(current => current && ({ ...current, paused: control.paused })); }}>{scanTask.paused ? "继续" : "暂停"}</button><button onClick={() => { const control = scanControlRef.current; if (control) { control.cancelled = true; control.paused = false; } setScanTask(current => current && ({ ...current, phase: "正在取消…", paused: false })); }}>取消任务</button></> : <>{videos.some(video => !video.thumb) && <button onClick={() => void retryPreviews(true)}>生成未完成预览</button>}<button onClick={() => setScanTask(null)}>收起</button></>}</div></section>}
      <section className="workspace-head">
        <div>
          <h1>视频库</h1>
          <p className="folder-path"><span className={sources.length ? "status-dot" : "status-dot idle"} /> {sources.length ? `${sources.length} 个源文件夹 · 已保存到本机` : "尚未添加源文件夹"}</p>
        </div>
        <div className="head-actions"><button className="secondary tag-manager-button" onClick={() => setTagManagerOpen(value => !value)} aria-expanded={tagManagerOpen}>◇ 管理标签{customTags.length ? ` (${customTags.length})` : ""}</button></div>
      </section>

      {tagManagerOpen && <section className="tag-manager" aria-label="自定义标签管理">
        <header><div><strong>自定义标签</strong><span>标签与视频关联只保存在本机</span></div><button onClick={() => setTagManagerOpen(false)} aria-label="关闭标签管理">×</button></header>
        <div className="tag-create-row">
          <input type="color" value={newTagColor} onChange={event => setNewTagColor(event.target.value)} aria-label="新标签颜色" />
          <input value={newTagName} maxLength={24} onChange={event => setNewTagName(event.target.value)} onKeyDown={event => event.key === "Enter" && createTag()} placeholder="输入新标签名称" aria-label="新标签名称" />
          <button className="primary" onClick={createTag}>＋ 创建标签</button>
        </div>
        {customTags.length ? <div className="tag-manager-list">{customTags.map(tag => <div className="tag-manager-item" key={tag.id}>
          <input type="color" value={tag.color} onChange={event => changeTagColor(tag.id, event.target.value)} aria-label={`修改 ${tag.name} 的颜色`} />
          {editingTagId === tag.id ? <input className="tag-name-edit" value={editingTagName} maxLength={24} onChange={event => setEditingTagName(event.target.value)} onKeyDown={event => { if (event.key === "Enter") saveRenamedTag(); if (event.key === "Escape") setEditingTagId(null); }} aria-label="编辑标签名称" /> : <span className="custom-tag" style={{ "--tag-color": tag.color } as CSSProperties}>{tag.name}<small>{videos.filter(video => video.tagIds.includes(tag.id)).length}</small></span>}
          {editingTagId === tag.id ? <><button onClick={saveRenamedTag}>保存</button><button onClick={() => setEditingTagId(null)}>取消</button></> : <button onClick={() => beginRenameTag(tag)}>重命名</button>}
          <button className="tag-delete" onClick={() => deleteTag(tag.id)}>删除</button>
        </div>)}</div> : <p className="tag-manager-empty">尚未创建标签。创建后即可给任意视频添加多个标签。</p>}
      </section>}

      {sources.length > 0 && <section className={sourcePanelOpen ? "source-manager open" : "source-manager"} aria-label="源文件夹管理">
        <button className="source-manager-toggle" onClick={() => { setSourcePanelOpen(value => !value); if (sourcePanelOpen) setSourceDetails(null); }} aria-expanded={sourcePanelOpen}>
          <span className="source-manager-icon">▰</span>
          <span><strong>{activeSource ? activeSource.name : "全部来源"}</strong><small>{activeSourceVideoCount.toLocaleString()} 个视频 · {sources.length} 个源文件夹</small></span>
          <em>{sourcePanelOpen ? "收起" : "管理源文件夹"} {sourcePanelOpen ? "⌃" : "⌄"}</em>
        </button>
        {sourcePanelOpen && <div className="source-manager-panel">
          <div className="source-manager-actions"><button className="secondary" onClick={rescanAllSources} disabled={Boolean(scanTask?.active)}>↻ {loading ? "扫描中…" : "扫描全部来源"}</button><button className="primary" onClick={chooseFolder}>＋ 添加源文件夹</button></div>
          <section className="source-shelf" aria-label="源文件夹">
            <button className={sourceFilter === "all" ? "all-sources active" : "all-sources"} onClick={() => { setSourceFilter("all"); setCurrentPage(1); }}><span>▱</span><strong>全部来源</strong><small>{videos.length} 个视频</small></button>
            {sources.map(source => <div className={sourceFilter === source.id ? "source-chip active" : "source-chip"} key={source.id}>
              <button className="source-main" onClick={() => { setSourceFilter(source.id); setCurrentPage(1); }} title={source.name}><span>▰</span><strong>{source.name}</strong><small>{source.videoCount || videos.filter(video => video.sourceId === source.id).length} 个</small></button>
              <button className="source-action" onClick={() => rescanSource(source)} title="重新授权并扫描" aria-label={`重新扫描 ${source.name}`}>↻</button>
              <button className="source-action" onClick={() => setSourceDetails(current => current === source.id ? null : source.id)} title="更多信息" aria-label={`查看 ${source.name} 的更多信息`}>…</button>
              <button className="source-action remove" onClick={() => removeSource(source)} title="从视频库移除（不会删除文件）" aria-label={`移除 ${source.name}`}>×</button>
            </div>)}
          </section>
          {detailedSource && <section className="source-details" aria-label={`${detailedSource.name} 的更多信息`}>
            <div className="source-details-head"><div><span>源文件夹更多信息</span><strong title={detailedSource.name}>{detailedSource.name}</strong></div><button onClick={() => setSourceDetails(null)} aria-label="关闭源文件夹更多信息">×</button></div>
            <dl>
              <div><dt>视频数量</dt><dd>{detailedSourceVideos.length.toLocaleString()} 个</dd></div>
              <div><dt>视频总容量</dt><dd>{formatBytes(detailedSource.totalSize || detailedSourceVideos.reduce((sum, video) => sum + video.size, 0))}</dd></div>
              <div><dt>预览缓存</dt><dd>{formatBytes(detailedSourceCacheSize)}</dd></div>
              <div><dt>缓存进度</dt><dd>{detailedSourceCachedCount} / {detailedSourceVideos.length} 个</dd></div>
              <div><dt>最后扫描</dt><dd>{detailedSource.lastScan ? formatDate(detailedSource.lastScan) : "尚未扫描"}</dd></div>
            </dl>
          </section>}
        </div>}
      </section>}

      {sources.length === 0 && !loading ? (
        <section className="empty-state">
          <div className="empty-icon"><span>▶</span></div>
          <p className="eyebrow">建立多来源本地索引</p><h2>把多个文件夹，汇总成一个视频库</h2>
          <p>你可以连续添加多个源文件夹。解析清单、文件夹授权、缩略图和标记都会缓存在本机，下次打开仍会恢复。</p>
          <button className="primary large" onClick={chooseFolder}>添加第一个视频文件夹</button>
          <div className="feature-row"><span>✓ 多文件夹聚合</span><span>✓ 本机持久缓存</span><span>✓ 源文件不会上传</span></div>
        </section>
      ) : (
        <>
          <section className="stats" aria-label="视频库统计">
            <div><span>视频</span><strong>{videos.length.toLocaleString()}</strong></div><div><span>总容量</span><strong>{formatBytes(totalSize)}</strong></div><div><span>已点赞</span><strong>{videos.filter(v => v.liked).length}</strong></div><div><span>待清理</span><strong>{videos.filter(v => v.cleanup).length}</strong></div>
            <div className="cache"><span>预览缓存</span><strong><i style={{ background: `linear-gradient(90deg,#9bc834 ${cachePercent}%,#e5e7df ${cachePercent}%)` }} /> {cachePercent}%</strong><small>{videos.length > cachedCount + failedPreviews.length ? `${scanTask && !scanTask.active ? "预览待处理" : "正在加载预览"} · ${videos.length - cachedCount - failedPreviews.length} 个剩余` : failedPreviews.length ? "预览处理完成" : "缩略图与基础信息已就绪"}{failedPreviews.length > 0 && <> · {failedPreviews.length} 个失败 <button disabled={Boolean(scanTask?.active)} onClick={() => void retryPreviews()}>{retryingPreviews ? "重试中…" : "重试失败项"}</button></>}</small></div>
          </section>

          <section className="toolbar">
            <div className="tabs"><button className={tab === "all" ? "active" : ""} onClick={() => { setTab("all"); setCurrentPage(1); }}>全部 <b>{videos.length}</b></button><button className={tab === "liked" ? "active" : ""} onClick={() => { setTab("liked"); setCurrentPage(1); }}>已点赞 <b>{videos.filter(v => v.liked).length}</b></button><button className={tab === "cleanup" ? "active" : ""} onClick={() => { setTab("cleanup"); setCurrentPage(1); }}>待清理 <b>{videos.filter(v => v.cleanup).length}</b></button></div>
            <div className="filters">
              <select value={sort} onChange={event => { if (event.target.value === "random") shuffleVideos(); else if (event.target.value === "popular" || event.target.value === "leastPopular") sortByClicks(event.target.value); else { setSort(event.target.value as Sort); setCurrentPage(1); } }} aria-label="排序"><option value="newest">最新修改</option><option value="oldest">最早修改</option><option value="largest">文件最大</option><option value="smallest">文件最小</option><option value="name">按名称</option><option value="popular">点击最多</option><option value="leastPopular">点击最少</option><option value="random">全随机</option></select>
              {(sort === "popular" || sort === "leastPopular") && <button className="tie-shuffle" onClick={reshuffleEqualClicks} title="只重新随机排列点击次数相同的视频">↻ 同次数重排</button>}
              <button className={sort === "random" ? "random-sort active" : "random-sort"} onClick={shuffleVideos} title="重新随机排列全部视频">⤨ 全随机</button>
              <select value={resolutionFilter} onChange={event => { setResolutionFilter(event.target.value as ResolutionFilter); setCurrentPage(1); }} aria-label="分辨率筛选"><option value="all">全部分辨率</option><option value="480p">480p 及以下</option><option value="720p">720p</option><option value="1080p">1080p</option><option value="2k">2K</option><option value="4k">4K</option><option value="8k">8K</option><option value="unknown">尚未解析</option></select>
              <select value={durationFilter} onChange={event => { setDurationFilter(event.target.value as DurationFilter); setCurrentPage(1); }} aria-label="时长筛选"><option value="all">全部时长</option><option value="short">1 分钟内</option><option value="medium">1–10 分钟</option><option value="long">10 分钟以上</option></select>
              <select value={format} onChange={event => { setFormat(event.target.value); setCurrentPage(1); }} aria-label="格式筛选"><option value="all">全部格式</option>{formats.map(ext => <option value={ext} key={ext}>{ext.toUpperCase()}</option>)}</select>
              <button className={selectedTagIds.size ? "tag-filter-toggle active" : "tag-filter-toggle"} onClick={() => setTagFilterOpen(value => !value)} aria-expanded={tagFilterOpen}>◇ 标签{selectedTagIds.size ? ` ${selectedTagIds.size}` : ""}</button>
              <div className="layout-switcher" aria-label="视频列表布局">
                <button className={layout === "comfortable" ? "active" : ""} onClick={() => setLayout("comfortable")} title="舒适网格" aria-label="舒适网格">▦</button>
                <button className={layout === "compact" ? "active" : ""} onClick={() => setLayout("compact")} title="紧凑网格（桌面端每行 5 个）" aria-label="紧凑网格，桌面端每行 5 个">⠿</button>
                <button className={layout === "list" ? "active" : ""} onClick={() => setLayout("list")} title="列表" aria-label="列表">☷</button>
              </div>
            </div>
          </section>

          {tagFilterOpen && <section className="tag-filter-panel" aria-label="标签筛选">
            <div className="tag-filter-head"><strong>按标签筛选</strong><div><label><input type="radio" checked={tagMatch === "any"} onChange={() => { setTagMatch("any"); setCurrentPage(1); }} /> 匹配任一</label><label><input type="radio" checked={tagMatch === "all"} onChange={() => { setTagMatch("all"); setCurrentPage(1); }} /> 同时匹配全部</label>{selectedTagIds.size > 0 && <button onClick={() => { setSelectedTagIds(new Set()); setCurrentPage(1); }}>清除</button>}</div></div>
            {customTags.length ? <div className="tag-filter-list">{customTags.map(tag => <button className={selectedTagIds.has(tag.id) ? "custom-tag selected" : "custom-tag"} style={{ "--tag-color": tag.color } as CSSProperties} onClick={() => toggleTagFilter(tag.id)} aria-pressed={selectedTagIds.has(tag.id)} key={tag.id}><i />{tag.name}<small>{videos.filter(video => video.tagIds.includes(tag.id)).length}</small></button>)}</div> : <p>还没有自定义标签。<button onClick={() => setTagManagerOpen(true)}>立即创建</button></p>}
          </section>}

          <section className="library-head">
            <p>{filtered.length.toLocaleString()} 个视频 <span>· {filtered.length ? `当前显示 ${pageStart + 1}–${Math.min(pageStart + pageSize, filtered.length)}` : "当前视图"}{query || format !== "all" || resolutionFilter !== "all" || durationFilter !== "all" || selectedTagIds.size ? " · 已筛选" : ""}</span></p>
            <div className="selection-actions">
              {selecting && <><button onClick={() => { selectionAnchor.current = null; setSelected(current => new Set([...current, ...paginatedVideos.map(v => v.id)])); }}>全选本页</button><button onClick={() => { selectionAnchor.current = null; setSelected(new Set(filtered.map(v => v.id))); }}>全选全部筛选结果</button><button onClick={() => { selectionAnchor.current = null; setSelected(current => { const next = new Set(current); paginatedVideos.forEach(video => { if (next.has(video.id)) next.delete(video.id); else next.add(video.id); }); return next; }); }}>反选本页</button><button disabled={!selected.size} onClick={() => { setSelected(new Set()); selectionAnchor.current = null; }}>取消全部</button><span>已选 {selected.size} 个</span>{selected.size > 0 && <button className="danger-text" onClick={() => setConfirmDelete(true)}>删除</button>}</>}
              <button className="select" onClick={() => { setSelecting(value => !value); setSelected(new Set()); selectionAnchor.current = null; }}>{selecting ? "取消" : "选择"}</button>
            </div>
          </section>

          {selecting && <p className="selection-summary" role="status">Shift 点击可跨页连续选择。已选 {selected.size} 个 · {offPageSelectionCount} 个不在本页{hiddenSelectionCount > 0 && <>，其中 {hiddenSelectionCount} 个不符合当前筛选 <button onClick={() => setSelected(current => new Set([...current].filter(id => filtered.some(video => video.id === id))))}>取消隐藏项选择</button></>}</p>}
          {loading ? <section className="loading-state"><span className="spinner" />正在扫描视频文件…</section> : filtered.length ? (
            <section className={`grid layout-${layout}`}>
              {paginatedVideos.map(video => (
                <article className={`video-card ${selected.has(video.id) ? "selected" : ""}`} key={video.id}>
                  {selecting && <button className={`check ${selected.has(video.id) ? "checked" : ""}`} onClick={event => toggleSelection(video.id, event.shiftKey)} aria-label={`选择 ${video.name}`} aria-pressed={selected.has(video.id)}>{selected.has(video.id) ? "✓" : ""}</button>}
                  <HoverPreview item={video} onOpen={extend => selecting ? toggleSelection(video.id, extend) : openPlayer(video, false, filtered.map(item => item.id))} />
                  <div className="card-body">
                    <div className="video-title">
                      <h2 title={video.path}>{video.name}</h2>
                      <div className="card-mark-actions" aria-label="视频标记">
                        <button className={`mark-button liked-mark ${video.liked ? "active" : ""}`} onClick={() => updateMark(video.id, "liked")} title={video.liked ? "取消点赞" : "点赞"} aria-label={video.liked ? "取消点赞" : "点赞"} aria-pressed={video.liked}><MarkIcon type="liked" /></button>
                        <button className={`mark-button cleanup-mark ${video.cleanup ? "active" : ""}`} onClick={() => updateMark(video.id, "cleanup")} title={video.cleanup ? "取消待清理标记" : "标记为待清理"} aria-label={video.cleanup ? "取消待清理标记" : "标记为待清理"} aria-pressed={video.cleanup}><MarkIcon type="cleanup" /></button>
                        <button className={`mark-button tag-mark ${video.tagIds.length ? "active" : ""}`} onClick={() => setTaggingVideoId(current => current === video.id ? null : video.id)} title="添加或移除标签" aria-label={`管理 ${video.name} 的标签`} aria-expanded={taggingVideoId === video.id}><TagIcon /></button>
                      </div>
                    </div>
                    {taggingVideoId === video.id && <div className="video-tag-picker">
                      <strong>为视频添加标签</strong>
                      {customTags.length ? <div>{customTags.map(tag => <button className={video.tagIds.includes(tag.id) ? "custom-tag selected" : "custom-tag"} style={{ "--tag-color": tag.color } as CSSProperties} onClick={() => toggleVideoTag(video.id, tag.id)} aria-pressed={video.tagIds.includes(tag.id)} key={tag.id}><i />{tag.name}</button>)}</div> : <p>还没有标签。<button onClick={() => setTagManagerOpen(true)}>创建标签</button></p>}
                    </div>}
                    <div className="card-info-line">
                      <p><b className="source-label">{video.sourceName}</b><span>·</span>{formatBytes(video.size)}<span>·</span>{formatDate(video.modified)}</p>
                      <div className="tag-line"><div className="tags"><span>{video.ext.toUpperCase()}</span><span title={`已点击 ${video.clicks} 次`}>点击 {video.clicks}</span></div></div>
                    </div>
                    {video.tagIds.length > 0 && <div className="video-tags">{video.tagIds.map(id => customTags.find(tag => tag.id === id)).filter((tag): tag is CustomTag => Boolean(tag)).map(tag => <button className="custom-tag" style={{ "--tag-color": tag.color } as CSSProperties} onClick={() => { if (!selectedTagIds.has(tag.id)) toggleTagFilter(tag.id); setTagFilterOpen(true); }} title={`筛选标签：${tag.name}`} key={tag.id}><i />{tag.name}</button>)}</div>}
                  </div>
                </article>
              ))}
            </section>
          ) : <section className="no-results"><strong>没有符合条件的视频</strong><p>试试清除搜索词或调整筛选条件。</p><button onClick={() => { setQuery(""); setFormat("all"); setResolutionFilter("all"); setDurationFilter("all"); setSelectedTagIds(new Set()); setTab("all"); setCurrentPage(1); }}>清除筛选</button></section>}

          {!loading && filtered.length > 0 && <nav className="pagination" aria-label="视频分页">
            <label>每页<select value={pageSize} onChange={event => { setPageSize(Number(event.target.value) as PageSize); setCurrentPage(1); }} aria-label="每页视频数量"><option value={20}>20</option><option value={50}>50</option><option value={100}>100</option></select>个</label>
            <div>
              <button onClick={() => setCurrentPage(1)} disabled={visiblePage === 1} aria-label="第一页">«</button>
              <button onClick={() => setCurrentPage(Math.max(1, visiblePage - 1))} disabled={visiblePage === 1}>上一页</button>
              <span>第 <b>{visiblePage}</b> / {totalPages} 页</span>
              <button onClick={() => setCurrentPage(Math.min(totalPages, visiblePage + 1))} disabled={visiblePage === totalPages}>下一页</button>
              <button onClick={() => setCurrentPage(totalPages)} disabled={visiblePage === totalPages} aria-label="最后一页">»</button>
            </div>
            <small>共 {filtered.length.toLocaleString()} 个视频</small>
          </nav>}
        </>
      )}

      <footer className="footer"><span><i /> 本地模式 · 文件不会上传</span><span>预览缓存在浏览器中 <button onClick={clearCache}>清除缓存</button></span></footer>

      {player && playerUrl && <div className="modal-backdrop player-backdrop" role="presentation">
        <section className="player-modal" role="dialog" aria-modal="true" aria-label={`播放 ${player.name}`}>
          <aside className="player-sidebar">
            <header className="player-sidebar-head"><span className="brand-mark">F</span><span>播放详情</span><button type="button" className="player-close" onClick={event => { event.preventDefault(); event.stopPropagation(); requestClosePlayer(); }} title="关闭播放窗口并返回视频列表" aria-label="关闭播放窗口并返回视频列表"><b>×</b><em>返回</em></button></header>
            <div className="player-title-block"><p className="eyebrow">正在播放</p><h2>{player.name}</h2><span>{player.sourceName}</span></div>
            <dl className="player-info">
              <div><dt>时长</dt><dd>{formatDuration(player.duration)}</dd></div>
              <div><dt>文件大小</dt><dd>{formatBytes(player.size)}</dd></div>
              <div><dt>格式</dt><dd>{player.ext.toUpperCase()}</dd></div>
              <div><dt>分辨率</dt><dd>{player.width && player.height ? `${player.width} × ${player.height}` : "解析中"}</dd></div>
              <div><dt>点击次数</dt><dd>{player.clicks.toLocaleString()} 次</dd></div>
              <div><dt>修改时间</dt><dd>{formatDate(player.modified)}</dd></div>
            </dl>
            <div className="player-path"><span>文件位置</span><p>{player.sourceName} / {player.path}</p></div>
            <div className="player-actions">
              <button disabled={switchingVideo || !previousVideo} onClick={() => previousVideo && void openPlayer(previousVideo, true)}>← 上一个</button>
              <button disabled={switchingVideo || !nextVideo} onClick={() => nextVideo && void openPlayer(nextVideo, true)}>下一个 →</button>
              <span>{switchingVideo ? "正在打开视频…" : `${queuePosition + 1} / ${availableQueue.length}`}</span>
              <button className={player.liked ? "liked active" : ""} onClick={() => updatePlayerMark("liked")} aria-pressed={player.liked}><span className="player-mark-icon"><MarkIcon type="liked" /></span>{player.liked ? "已点赞" : "点赞"}</button>
              <button className={player.cleanup ? "cleanup-player active" : ""} onClick={() => updatePlayerMark("cleanup")} aria-pressed={player.cleanup}><span className="player-mark-icon"><MarkIcon type="cleanup" /></span>{player.cleanup ? "已标记待清理" : "标记待清理"}</button>
            </div>
            <section className="play-queue" aria-label="播放队列"><header><strong>播放队列 · {queuePosition + 1} / {availableQueue.length}</strong><button onClick={() => setShortcutHelp(true)}>快捷键</button></header><div className="queue-controls"><select aria-label="播放模式" value={queueMode} onChange={event => changeQueueMode(event.target.value as typeof queueMode)}><option value="sequence">顺序播放</option><option value="random">随机播放</option><option value="repeat">单条循环</option></select>{queueMode === "random" && <button onClick={() => changeQueueMode("random")}>重新打乱</button>}<label><input type="checkbox" checked={autoAdvance} onChange={event => setAutoAdvance(event.target.checked)} /> 自动连播</label></div><input className="queue-search" value={queueQuery} onChange={event => setQueueQuery(event.target.value)} placeholder="在队列中查找…" aria-label="搜索播放队列" /><ol>{availableQueue.map((id, index) => ({ item: videoById.get(id)!, index })).filter(({ item }) => item.name.toLowerCase().includes(queueQuery.toLowerCase())).map(({ item, index }) => <li key={item.id}><button disabled={switchingVideo} aria-current={player.id === item.id ? "true" : undefined} onClick={() => void openPlayer(item, true)} title={`${item.sourceName} / ${item.path}`}><span>{player.id === item.id ? "▶" : index + 1}</span><span><strong>{item.name}</strong><small>{item.sourceName} · {formatDuration(item.duration)}</small></span></button></li>)}</ol></section>
            <section className="player-tags" aria-label="视频标签"><span>视频标签</span>{customTags.length ? <div>{customTags.map(tag => <button className={player.tagIds.includes(tag.id) ? "custom-tag selected" : "custom-tag"} style={{ "--tag-color": tag.color } as CSSProperties} onClick={() => toggleVideoTag(player.id, tag.id)} aria-pressed={player.tagIds.includes(tag.id)} key={tag.id}><i />{tag.name}</button>)}</div> : <button className="player-create-tag" onClick={() => { requestClosePlayer(); setTagManagerOpen(true); }}>＋ 创建第一个标签</button>}</section>
            <span className={playerFeedback ? "player-feedback visible" : "player-feedback"}>✓ {playerFeedback}</span>
            <p className="player-local-note"><i /> 本地播放 · 视频不会上传</p>
          </aside>
          <div className="player-stage">
            <header><span>{player.name}</span><small>← / → 10 秒 · ↑ / ↓ 音量 · 空格播放/暂停 · {formatDuration(player.duration)} · {player.ext.toUpperCase()}</small></header>
            {/* Local personal videos do not have a captions track available to the app. */}
            {/* eslint-disable-next-line jsx-a11y/media-has-caption */}
            <video ref={playerVideoRef} src={playerUrl} controls autoPlay playsInline preload="auto" loop={queueMode === "repeat"} onEnded={() => { if (autoAdvance && nextVideo) void openPlayer(nextVideo, true); }} onLoadedMetadata={event => { applySavedVolume(event.currentTarget); setPlayerDuration(Number.isFinite(event.currentTarget.duration) ? event.currentTarget.duration : 0); }} onTimeUpdate={event => setPlayerTime(event.currentTarget.currentTime)} onDurationChange={event => setPlayerDuration(Number.isFinite(event.currentTarget.duration) ? event.currentTarget.duration : 0)} onVolumeChange={event => savePlayerVolume(event.currentTarget)} aria-label={`正在播放 ${player.name}`} aria-keyshortcuts="ArrowLeft ArrowRight" />
            <div className="player-progress">
              <span>{formatDuration(playerTime)}</span>
              <input type="range" min={0} max={playerDuration || 1} step={0.1} value={Math.min(playerTime, playerDuration || 1)} onPointerDown={event => { if (!playerDuration) return; const bounds = event.currentTarget.getBoundingClientRect(); const ratio = Math.max(0, Math.min(1, (event.clientX - bounds.left) / bounds.width)); const time = ratio * playerDuration; if (playerVideoRef.current) playerVideoRef.current.currentTime = time; setPlayerTime(time); }} onChange={event => { const time = Number(event.target.value); if (playerVideoRef.current) playerVideoRef.current.currentTime = time; setPlayerTime(time); }} style={{ "--progress": `${playerDuration ? playerTime / playerDuration * 100 : 0}%` } as CSSProperties} aria-label="视频播放进度" aria-keyshortcuts="ArrowLeft ArrowRight ArrowUp ArrowDown Space" />
              <span>{formatDuration(playerDuration)}</span>
            </div>
          </div>
        </section>
      </div>}

      {confirmDelete && <div className="modal-backdrop">
        <section className="confirm-modal" role="alertdialog" aria-modal="true" aria-labelledby="delete-title">
          <span className="warning">!</span><h2 id="delete-title">永久删除 {selected.size} 个视频？</h2>
          <p>将释放约 <strong>{formatBytes(selectedSize)}</strong>。文件会从源文件夹直接删除，且不经过本应用的回收站，此操作无法撤销。</p>
          {hiddenSelectionCount > 0 && <p className="selection-warning">注意：包含 {hiddenSelectionCount} 个不符合当前筛选的已选视频。</p>}
          <section className="delete-paths" aria-label="即将删除的源文件路径">
            <strong>即将删除的源文件</strong>
            <ol>{selectedVideos.slice(0, 10).map(video => <li key={video.id} title={`${video.sourceName} / ${video.path}`}><span>{video.sourceName}</span> / {video.path}</li>)}</ol>
            {selectedVideos.length > 10 && <small>另外还有 {selectedVideos.length - 10} 个文件未展开显示</small>}
          </section>
          <label><input type="checkbox" id="delete-understood" /> 我已确认筛选和选择范围无误</label>
          <div><button className="secondary" onClick={() => setConfirmDelete(false)}>取消</button><button className="danger" onClick={() => { const checkbox = document.getElementById("delete-understood") as HTMLInputElement; if (checkbox?.checked) void deleteSelected(); else setError("请先勾选确认项。"); }}>永久删除</button></div>
        </section>
      </div>}
    </main>
  );
}
