"use client";

/* eslint-disable @next/next/no-img-element, @next/next/no-html-link-for-pages -- previews use local Blob URLs; hard navigation avoids losing File System Access state in the compatibility router. */

import { useCallback, useEffect, useMemo, useState } from "react";
import AccountGate, { signOut } from "../account-gate";
import { accountDbName, accountKey } from "../account-storage";
import ThemeSelector from "../theme-selector";
import styles from "./photos.module.css";

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
  liked: boolean;
  cleanup: boolean;
};
type SourceFolder = { id: string; name: string; handle: DirectoryHandle; lastScan: number; photoCount: number; totalSize: number };
type PhotoMarks = Record<string, { liked?: boolean; cleanup?: boolean }>;
type Tab = "all" | "liked" | "cleanup";
type Sort = "newest" | "oldest" | "largest" | "smallest" | "name";
type PreviewRatio = "standard" | "phone";

const PHOTO_EXTENSIONS = new Set(["jpg", "jpeg", "png", "gif", "webp", "bmp", "avif", "heic", "heif", "tif", "tiff", "dng", "cr2", "cr3", "nef", "arw", "raf", "orf", "rw2"]);
const BROWSER_PREVIEW_EXTENSIONS = new Set(["jpg", "jpeg", "png", "gif", "webp", "bmp", "avif"]);
const SOURCES_KEY = "photo-source-folders-v1";
const PAGE_SIZE = 48;

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
    for await (const entry of directory.values()) {
      if (entry.kind === "directory") await walk(entry, [...parts, entry.name]);
      else {
        const extension = entry.name.split(".").pop()?.toLowerCase() || "";
        if (!PHOTO_EXTENSIONS.has(extension)) continue;
        const file = await entry.getFile();
        const path = [...parts, entry.name].join("/");
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
          liked: Boolean(marks[path]?.liked),
          cleanup: Boolean(marks[path]?.cleanup),
        });
        if (found.length % 25 === 0) progress(found.length);
      }
    }
  }
  await walk(source.handle, []);
  progress(found.length);
  return found;
}

function PhotoThumb({ item, onOpen }: { item: PhotoItem; onOpen: () => void }) {
  const [url, setUrl] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    let cancelled = false;
    let objectUrl = "";
    if (!BROWSER_PREVIEW_EXTENSIONS.has(item.extension)) return;
    void item.handle.getFile().then(file => {
      if (cancelled) return;
      objectUrl = URL.createObjectURL(file);
      setUrl(objectUrl);
    }).catch(() => setFailed(true));
    return () => { cancelled = true; if (objectUrl) URL.revokeObjectURL(objectUrl); };
  }, [item]);
  return <button className={styles.thumb} onClick={onOpen} aria-label={`查看 ${item.name}`}>
    {url && !failed ? <img src={url} alt="" loading="lazy" onError={() => setFailed(true)} /> : <span><b>{item.extension.toUpperCase()}</b><small>{BROWSER_PREVIEW_EXTENSIONS.has(item.extension) ? "正在读取预览" : "浏览器暂不支持预览"}</small></span>}
  </button>;
}

function PhotoViewer({ item, previous, next, onClose }: { item: PhotoItem; previous: () => void; next: () => void; onClose: () => void }) {
  const [url, setUrl] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    let objectUrl = "";
    if (BROWSER_PREVIEW_EXTENSIONS.has(item.extension)) void item.handle.getFile().then(file => {
      objectUrl = URL.createObjectURL(file); setUrl(objectUrl);
    }).catch(() => setFailed(true));
    return () => { if (objectUrl) URL.revokeObjectURL(objectUrl); };
  }, [item]);
  useEffect(() => {
    const keydown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
      if (event.key === "ArrowLeft") previous();
      if (event.key === "ArrowRight") next();
    };
    window.addEventListener("keydown", keydown);
    return () => window.removeEventListener("keydown", keydown);
  }, [next, onClose, previous]);
  return <div className={styles.viewer} role="dialog" aria-modal="true" aria-label={item.name}>
    <button className={styles.viewerClose} onClick={onClose} aria-label="关闭">×</button>
    <button className={styles.viewerPrevious} onClick={previous} aria-label="上一张">‹</button>
    <figure>{url && !failed ? <img src={url} alt={item.name} onError={() => setFailed(true)} /> : <div className={styles.unsupported}><strong>{item.extension.toUpperCase()}</strong><span>浏览器无法直接显示此原始格式，但文件仍已纳入图片库。</span></div>}<figcaption><strong title={item.path}>{item.name}</strong><span>{item.sourceName} · {item.extension.toUpperCase()} · {formatBytes(item.size)} · {formatDate(item.modified)}</span></figcaption></figure>
    <button className={styles.viewerNext} onClick={next} aria-label="下一张">›</button>
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
  const [page, setPage] = useState(1);
  const [viewerId, setViewerId] = useState<string | null>(null);
  const [icloudBackupDirectory, setIcloudBackupDirectory] = useState<string | null>(null);
  const [notice, setNotice] = useState("");
  const [error, setError] = useState("");

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

  useEffect(() => {
    void fetch("/api/icloud/config", { cache: "no-store" }).then(async response => {
      if (!response.ok) return null;
      return response.json() as Promise<{ backupDirectory?: string | null }>;
    }).then(config => setIcloudBackupDirectory(config?.backupDirectory || null)).catch(() => undefined);
  }, []);

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
      <a href="/"><span>F</span>Framebase</a>
      <label><span>⌕</span><input value={query} onChange={event => { setQuery(event.target.value); setPage(1); }} placeholder="搜索图片名称或路径…" aria-label="搜索图片" /></label>
      <nav><a href="/">视频库</a><a href="/icloud">iCloud 备份</a><a href="/lan">局域网</a><b>{username}</b><button onClick={() => void signOut()}>退出</button><ThemeSelector /></nav>
    </header>
    {error && <div className={styles.error} role="alert">{error}<button onClick={() => setError("")}>×</button></div>}
    {notice && <div className={styles.notice} role="status">{notice}<button onClick={() => setNotice("")}>×</button></div>}
    <section className={styles.hero}><div><p>独立图片库</p><h1>图片浏览与整理</h1><span>图片来源、索引和标记与原视频库彻底隔离；移除来源不会删除文件。</span></div><button onClick={() => void chooseFolder()} disabled={loading}>{loading ? `正在扫描 ${progress} 张…` : "添加图片文件夹"}</button></section>
    {icloudBackupDirectory && <aside className={styles.icloudHint}><div><strong>iCloud 照片与视频备份目录</strong><span>{icloudBackupDirectory}</span></div><p>可将这个目录同时添加到图片库和视频库：本页只索引图片与 RAW，视频库只索引视频，两套标记和索引互不影响。</p></aside>}
    <section className={styles.stats}><div><span>图片</span><strong>{photos.length}</strong></div><div><span>来源</span><strong>{sources.length}</strong></div><div><span>收藏</span><strong>{photos.filter(item => item.liked).length}</strong></div><div><span>占用</span><strong>{formatBytes(totalSize)}</strong></div></section>
    <section className={styles.sources} aria-label="图片来源">
      {sources.length === 0 && ready ? <p>尚未添加图片文件夹。这里不会读取视频库已经选择的目录。</p> : sources.map(source => <article key={source.id}><button onClick={() => { setSourceFilter(source.id); setPage(1); }} className={sourceFilter === source.id ? styles.activeSource : ""}><strong>{source.name}</strong><span>{source.photoCount} 张 · {formatBytes(source.totalSize)}</span></button><button onClick={() => void loadSource(source)} disabled={loading}>重扫</button><button onClick={() => void removeSource(source)} disabled={loading}>移除</button></article>)}
    </section>
    <section className={styles.toolbar}>
      <div><button className={tab === "all" ? styles.active : ""} onClick={() => { setTab("all"); setPage(1); }}>全部</button><button className={tab === "liked" ? styles.active : ""} onClick={() => { setTab("liked"); setPage(1); }}>收藏</button><button className={tab === "cleanup" ? styles.active : ""} onClick={() => { setTab("cleanup"); setPage(1); }}>待整理</button></div>
      <div><select value={sourceFilter} onChange={event => { setSourceFilter(event.target.value); setPage(1); }} aria-label="来源"><option value="all">全部来源</option>{sources.map(source => <option value={source.id} key={source.id}>{source.name}</option>)}</select><select value={formatFilter} onChange={event => { setFormatFilter(event.target.value); setPage(1); }} aria-label="格式"><option value="all">全部格式</option>{formats.map(format => <option value={format} key={format}>{format.toUpperCase()}</option>)}</select><select value={sort} onChange={event => { setSort(event.target.value as Sort); setPage(1); }} aria-label="排序"><option value="newest">最新优先</option><option value="oldest">最早优先</option><option value="largest">最大优先</option><option value="smallest">最小优先</option><option value="name">按名称</option></select><select value={previewRatio} onChange={event => setPreviewRatio(event.target.value as PreviewRatio)} aria-label="预览比例"><option value="standard">标准比例</option><option value="phone">手机比例 9:16</option></select><button onClick={() => setCompact(value => !value)}>{compact ? "舒适视图" : "紧凑视图"}</button></div>
    </section>
    <section className={styles.libraryHead}><p>显示 <strong>{filtered.length}</strong> 张图片</p>{pageCount > 1 && <div><button disabled={currentPage === 1} onClick={() => setPage(value => Math.max(1, value - 1))}>上一页</button><span>{currentPage} / {pageCount}</span><button disabled={currentPage === pageCount} onClick={() => setPage(value => Math.min(pageCount, value + 1))}>下一页</button></div>}</section>
    {visible.length ? <section className={`${styles.grid} ${compact ? styles.compact : ""} ${previewRatio === "phone" ? styles.phoneRatio : ""}`}>{visible.map(item => <article className={styles.card} key={item.id}><div className={styles.preview}><PhotoThumb item={item} onOpen={() => setViewerId(item.id)} /><nav className={styles.cardActions}><button title={item.liked ? "取消收藏" : "收藏"} aria-label={item.liked ? "取消收藏" : "收藏"} className={item.liked ? styles.marked : ""} onClick={() => toggleMark(item.id, "liked")}>{item.liked ? "♥" : "♡"}</button><button title={item.cleanup ? "移出待整理" : "加入待整理"} aria-label={item.cleanup ? "移出待整理" : "加入待整理"} className={item.cleanup ? styles.cleanupMarked : ""} onClick={() => toggleMark(item.id, "cleanup")}>{item.cleanup ? "✓" : "⌁"}</button></nav></div><div className={styles.cardMeta}><h2 title={item.path}>{item.name}</h2><p title={`${item.sourceName} · ${item.extension.toUpperCase()} · ${formatBytes(item.size)} · ${formatDate(item.modified)}`}><span>{item.sourceName}</span> · {item.extension.toUpperCase()} · {formatBytes(item.size)} · {formatDate(item.modified)}</p></div></article>)}</section> : <section className={styles.empty}><strong>{ready ? "没有符合条件的图片" : "正在读取图片库…"}</strong><span>{sources.length ? "可以调整筛选条件或重新扫描来源。" : "点击“添加图片文件夹”开始建立独立图片库。"}</span></section>}
    <footer><span>图片库只读取用户明确授权的本地文件夹</span><a href="/">返回视频库 →</a></footer>
    {viewer && <PhotoViewer key={viewer.id} item={viewer} previous={() => moveViewer(-1)} next={() => moveViewer(1)} onClose={() => setViewerId(null)} />}
  </main>;
}
