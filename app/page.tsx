"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

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
};
type PickerWindow = Window & { showDirectoryPicker?: (options?: { mode: "readwrite" }) => Promise<DirectoryHandle> };

type VideoItem = {
  id: string;
  name: string;
  path: string;
  ext: string;
  size: number;
  modified: number;
  duration: number | null;
  width: number | null;
  height: number | null;
  thumb: string | null;
  handle: FileHandle;
  parent: DirectoryHandle;
  liked: boolean;
  cleanup: boolean;
};

type CachedInfo = { duration: number; width: number; height: number; thumb: Blob };
type Tab = "all" | "liked" | "cleanup";
type DurationFilter = "all" | "short" | "medium" | "long";
type Sort = "newest" | "oldest" | "largest" | "smallest" | "name";

const VIDEO_EXTENSIONS = new Set(["mp4", "mov", "m4v", "webm", "mkv", "avi", "wmv", "flv", "mpeg", "mpg"]);
const DB_NAME = "framebase-local-v1";
const DB_STORE = "cache";

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

async function dbClear() {
  const db = await openDb();
  return new Promise<void>((resolve, reject) => {
    const tx = db.transaction(DB_STORE, "readwrite");
    tx.objectStore(DB_STORE).clear();
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

function marksKey(folder: string) { return `framebase-marks:${folder}`; }
function readMarks(folder: string): Record<string, { liked?: boolean; cleanup?: boolean }> {
  try { return JSON.parse(localStorage.getItem(marksKey(folder)) || "{}"); } catch { return {}; }
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
  return new Intl.DateTimeFormat("zh-CN", { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" }).format(timestamp);
}

async function scanDirectory(root: DirectoryHandle, marks: Record<string, { liked?: boolean; cleanup?: boolean }>) {
  const found: VideoItem[] = [];
  async function walk(directory: DirectoryHandle, parts: string[]) {
    for await (const entry of directory.values()) {
      if (entry.kind === "directory") {
        await walk(entry, [...parts, entry.name]);
      } else {
        const ext = entry.name.split(".").pop()?.toLowerCase() || "";
        if (!VIDEO_EXTENSIONS.has(ext)) continue;
        const file = await entry.getFile();
        const path = [...parts, entry.name].join("/");
        const cacheKey = `media:${path}:${file.size}:${file.lastModified}`;
        const cached = await dbGet<CachedInfo>(cacheKey).catch(() => undefined);
        found.push({
          id: path,
          name: entry.name,
          path,
          ext,
          size: file.size,
          modified: file.lastModified,
          duration: cached?.duration ?? null,
          width: cached?.width ?? null,
          height: cached?.height ?? null,
          thumb: cached?.thumb ? URL.createObjectURL(cached.thumb) : null,
          handle: entry,
          parent: directory,
          liked: Boolean(marks[path]?.liked),
          cleanup: Boolean(marks[path]?.cleanup),
        });
      }
    }
  }
  await walk(root, []);
  return found;
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
      video.onloadedmetadata = () => resolve();
      video.onerror = () => reject(new Error("无法读取视频元数据"));
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
    video.removeAttribute("src");
    URL.revokeObjectURL(url);
  }
}

function HoverPreview({ item, onOpen }: { item: VideoItem; onOpen: () => void }) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const urlRef = useRef<string | null>(null);
  const [hovering, setHovering] = useState(false);

  async function start() {
    setHovering(true);
    const video = videoRef.current;
    if (!video || urlRef.current) return;
    const file = await item.handle.getFile();
    urlRef.current = URL.createObjectURL(file);
    video.src = urlRef.current;
    video.onloadedmetadata = () => { video.currentTime = Math.min(Math.max(video.duration * .2, 0), 20); void video.play().catch(() => undefined); };
  }
  function stop() {
    setHovering(false);
    const video = videoRef.current;
    if (video) { video.pause(); video.removeAttribute("src"); video.load(); }
    if (urlRef.current) URL.revokeObjectURL(urlRef.current);
    urlRef.current = null;
  }
  useEffect(() => stop, []);

  return (
    <div className="thumb real-thumb" onMouseEnter={start} onMouseLeave={stop} onClick={onOpen} role="button" tabIndex={0} onKeyDown={event => event.key === "Enter" && onOpen()}>
      {/* Blob URLs are local cache entries and cannot be optimized by next/image. */}
      {/* eslint-disable-next-line @next/next/no-img-element */}
      {item.thumb ? <img src={item.thumb} alt="" /> : <div className="thumb-placeholder"><span>{item.ext.toUpperCase()}</span></div>}
      <video ref={videoRef} className={hovering ? "hover-video visible" : "hover-video"} muted loop playsInline preload="none" />
      <span className="play">▶</span>
      <span className="duration">{formatDuration(item.duration)}</span>
      {hovering && <span className="hover-hint">片段预览</span>}
    </div>
  );
}

export default function Home() {
  const [root, setRoot] = useState<DirectoryHandle | null>(null);
  const [lastRoot, setLastRoot] = useState<DirectoryHandle | null>(null);
  const [videos, setVideos] = useState<VideoItem[]>([]);
  const [loading, setLoading] = useState(false);
  const [cacheDone, setCacheDone] = useState(0);
  const [tab, setTab] = useState<Tab>("all");
  const [query, setQuery] = useState("");
  const [format, setFormat] = useState("all");
  const [durationFilter, setDurationFilter] = useState<DurationFilter>("all");
  const [sort, setSort] = useState<Sort>("newest");
  const [selecting, setSelecting] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [player, setPlayer] = useState<VideoItem | null>(null);
  const [playerUrl, setPlayerUrl] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => { void dbGet<DirectoryHandle>("root-handle").then(handle => handle && setLastRoot(handle)).catch(() => undefined); }, []);

  const persistMarks = useCallback((next: VideoItem[]) => {
    if (!root) return;
    const marks: Record<string, { liked?: boolean; cleanup?: boolean }> = {};
    next.forEach(video => { if (video.liked || video.cleanup) marks[video.path] = { liked: video.liked, cleanup: video.cleanup }; });
    localStorage.setItem(marksKey(root.name), JSON.stringify(marks));
  }, [root]);

  const buildCache = useCallback(async (items: VideoItem[]) => {
    const pending = items.filter(item => !item.thumb);
    setCacheDone(items.length - pending.length);
    let cursor = 0;
    async function worker() {
      while (cursor < pending.length) {
        const item = pending[cursor++];
        try {
          const info = await buildPreview(item);
          const file = await item.handle.getFile();
          await dbSet(`media:${item.path}:${file.size}:${file.lastModified}`, info);
          const thumbUrl = URL.createObjectURL(info.thumb);
          setVideos(current => current.map(video => video.id === item.id ? { ...video, duration: info.duration, width: info.width, height: info.height, thumb: thumbUrl } : video));
        } catch { /* Unsupported codecs remain playable through native controls when possible. */ }
        setCacheDone(value => value + 1);
        await new Promise(resolve => setTimeout(resolve, 20));
      }
    }
    await Promise.all([worker(), worker()]);
  }, []);

  const loadFolder = useCallback(async (handle: DirectoryHandle) => {
    setLoading(true); setError(null); setSelected(new Set());
    try {
      const items = await scanDirectory(handle, readMarks(handle.name));
      setRoot(handle); setLastRoot(handle); setVideos(items); setCacheDone(0);
      await dbSet("root-handle", handle).catch(() => undefined);
      setLoading(false);
      void buildCache(items);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "无法读取这个文件夹");
      setLoading(false);
    }
  }, [buildCache]);

  async function chooseFolder() {
    if (!(window as PickerWindow).showDirectoryPicker) { setError("当前浏览器不支持文件夹访问。请使用最新版 Chrome 或 Edge 打开此页面。"); return; }
    try {
      const handle = await (window as PickerWindow).showDirectoryPicker!({ mode: "readwrite" });
      await loadFolder(handle);
    } catch (reason) {
      if ((reason as DOMException)?.name !== "AbortError") setError("未能打开文件夹，请确认已授予读写权限。");
    }
  }

  async function reopenFolder() {
    if (!lastRoot) return;
    const permission = await lastRoot.requestPermission?.({ mode: "readwrite" });
    if (permission === "granted") await loadFolder(lastRoot); else setError("需要文件夹读写权限才能继续管理视频。");
  }

  function updateMark(id: string, key: "liked" | "cleanup") {
    setVideos(current => {
      const next = current.map(video => video.id === id ? { ...video, [key]: !video[key] } : video);
      persistMarks(next);
      return next;
    });
  }

  async function openPlayer(item: VideoItem) {
    const file = await item.handle.getFile();
    const url = URL.createObjectURL(file);
    setPlayer(item); setPlayerUrl(url);
  }
  function closePlayer() { if (playerUrl) URL.revokeObjectURL(playerUrl); setPlayer(null); setPlayerUrl(null); }

  const filtered = useMemo(() => {
    const lower = query.trim().toLowerCase();
    return videos.filter(video => {
      if (tab === "liked" && !video.liked) return false;
      if (tab === "cleanup" && !video.cleanup) return false;
      if (lower && !video.name.toLowerCase().includes(lower) && !video.path.toLowerCase().includes(lower)) return false;
      if (format !== "all" && video.ext !== format) return false;
      if (durationFilter === "short" && (video.duration ?? Infinity) >= 60) return false;
      if (durationFilter === "medium" && ((video.duration ?? 0) < 60 || (video.duration ?? Infinity) > 600)) return false;
      if (durationFilter === "long" && (video.duration ?? 0) <= 600) return false;
      return true;
    }).sort((a, b) => sort === "newest" ? b.modified - a.modified : sort === "oldest" ? a.modified - b.modified : sort === "largest" ? b.size - a.size : sort === "smallest" ? a.size - b.size : a.name.localeCompare(b.name, "zh-CN"));
  }, [videos, tab, query, format, durationFilter, sort]);

  const selectedVideos = videos.filter(video => selected.has(video.id));
  const totalSize = videos.reduce((sum, video) => sum + video.size, 0);
  const selectedSize = selectedVideos.reduce((sum, video) => sum + video.size, 0);
  const formats = [...new Set(videos.map(video => video.ext))].sort();
  const cachePercent = videos.length ? Math.min(100, Math.round(cacheDone / videos.length * 100)) : 0;

  function toggleSelection(id: string) {
    setSelected(current => { const next = new Set(current); if (next.has(id)) next.delete(id); else next.add(id); return next; });
  }

  async function deleteSelected() {
    const deleting = [...selectedVideos];
    const failed: string[] = [];
    for (const video of deleting) {
      try { await video.parent.removeEntry(video.name); } catch { failed.push(video.name); }
    }
    const deletedIds = new Set(deleting.filter(video => !failed.includes(video.name)).map(video => video.id));
    setVideos(current => { const next = current.filter(video => !deletedIds.has(video.id)); persistMarks(next); return next; });
    setSelected(new Set()); setSelecting(false); setConfirmDelete(false);
    setNotice(failed.length ? `已删除 ${deleting.length - failed.length} 个，${failed.length} 个删除失败（可能缺少权限或文件正在使用）。` : `已永久删除 ${deleting.length} 个视频。`);
  }

  async function clearCache() {
    await dbClear();
    if (root) await dbSet("root-handle", root).catch(() => undefined);
    videos.forEach(video => video.thumb && URL.revokeObjectURL(video.thumb));
    setVideos(current => current.map(video => ({ ...video, thumb: null, duration: null, width: null, height: null })));
    setCacheDone(0); setNotice("预览缓存已清除。重新扫描可再次构建。");
  }

  return (
    <main className="shell">
      <header className="topbar">
        <span className="brand"><span className="brand-mark">F</span> Framebase</span>
        <label className="search"><span>⌕</span><input value={query} onChange={event => setQuery(event.target.value)} placeholder="搜索名称或路径…" aria-label="搜索视频" /></label>
        <div className="header-actions"><span className="local-badge">仅本机</span><button className="avatar">KZ</button></div>
      </header>

      {error && <div className="toast error-toast"><span>{error}</span><button onClick={() => setError(null)}>×</button></div>}
      {notice && <div className="toast"><span>{notice}</span><button onClick={() => setNotice(null)}>×</button></div>}

      <section className="workspace-head">
        <div>
          <p className="eyebrow">本地视频工作台</p><h1>视频库</h1>
          <p className="folder-path"><span className={root ? "status-dot" : "status-dot idle"} /> {root ? root.name : "尚未选择源文件夹"}{root && <button onClick={chooseFolder}>更换</button>}</p>
        </div>
        <div className="head-actions">
          {root && <button className="secondary" onClick={() => loadFolder(root)} disabled={loading}>↻ {loading ? "扫描中…" : "重新扫描"}</button>}
          {!root && lastRoot && <button className="secondary" onClick={reopenFolder}>继续 {lastRoot.name}</button>}
          <button className="primary" onClick={chooseFolder}>＋ 选择源文件夹</button>
        </div>
      </section>

      {!root && !loading ? (
        <section className="empty-state">
          <div className="empty-icon"><span>▶</span></div>
          <p className="eyebrow">开始建立本地索引</p><h2>把散落的视频，变成好用的素材库</h2>
          <p>选择一个源文件夹后，Framebase 只会管理该文件夹中的视频。缩略图、时长和标记保存在当前浏览器，不会上传文件。</p>
          <button className="primary large" onClick={chooseFolder}>选择视频文件夹</button>
          <div className="feature-row"><span>✓ 递归扫描子文件夹</span><span>✓ 本地流畅播放</span><span>✓ 删除前二次确认</span></div>
        </section>
      ) : (
        <>
          <section className="stats" aria-label="视频库统计">
            <div><span>视频</span><strong>{videos.length.toLocaleString()}</strong></div><div><span>总容量</span><strong>{formatBytes(totalSize)}</strong></div><div><span>已点赞</span><strong>{videos.filter(v => v.liked).length}</strong></div><div><span>待清理</span><strong>{videos.filter(v => v.cleanup).length}</strong></div>
            <div className="cache"><span>预览缓存</span><strong><i style={{ background: `linear-gradient(90deg,#9bc834 ${cachePercent}%,#e5e7df ${cachePercent}%)` }} /> {cachePercent}%</strong><small>{cachePercent < 100 ? `后台构建中 · ${Math.max(videos.length - cacheDone, 0)} 个剩余` : "缩略图与基础信息已就绪"}</small></div>
          </section>

          <section className="toolbar">
            <div className="tabs"><button className={tab === "all" ? "active" : ""} onClick={() => setTab("all")}>全部 <b>{videos.length}</b></button><button className={tab === "liked" ? "active" : ""} onClick={() => setTab("liked")}>已点赞 <b>{videos.filter(v => v.liked).length}</b></button><button className={tab === "cleanup" ? "active" : ""} onClick={() => setTab("cleanup")}>待清理 <b>{videos.filter(v => v.cleanup).length}</b></button></div>
            <div className="filters">
              <select value={sort} onChange={event => setSort(event.target.value as Sort)} aria-label="排序"><option value="newest">最新修改</option><option value="oldest">最早修改</option><option value="largest">文件最大</option><option value="smallest">文件最小</option><option value="name">按名称</option></select>
              <select value={durationFilter} onChange={event => setDurationFilter(event.target.value as DurationFilter)} aria-label="时长筛选"><option value="all">全部时长</option><option value="short">1 分钟内</option><option value="medium">1–10 分钟</option><option value="long">10 分钟以上</option></select>
              <select value={format} onChange={event => setFormat(event.target.value)} aria-label="格式筛选"><option value="all">全部格式</option>{formats.map(ext => <option value={ext} key={ext}>{ext.toUpperCase()}</option>)}</select>
            </div>
          </section>

          <section className="library-head">
            <p>{filtered.length.toLocaleString()} 个视频 <span>· {query || format !== "all" || durationFilter !== "all" ? "已筛选" : "当前视图"}</span></p>
            <div className="selection-actions">
              {selecting && <><button onClick={() => setSelected(new Set(filtered.map(v => v.id)))}>全选当前结果</button><span>已选 {selected.size} 个</span>{selected.size > 0 && <button className="danger-text" onClick={() => setConfirmDelete(true)}>删除</button>}</>}
              <button className="select" onClick={() => { setSelecting(value => !value); setSelected(new Set()); }}>{selecting ? "取消" : "选择"}</button>
            </div>
          </section>

          {loading ? <section className="loading-state"><span className="spinner" />正在扫描视频文件…</section> : filtered.length ? (
            <section className="grid">
              {filtered.map(video => (
                <article className={`video-card ${selected.has(video.id) ? "selected" : ""}`} key={video.id}>
                  {selecting && <button className={`check ${selected.has(video.id) ? "checked" : ""}`} onClick={() => toggleSelection(video.id)} aria-label="选择视频">{selected.has(video.id) ? "✓" : ""}</button>}
                  <HoverPreview item={video} onOpen={() => selecting ? toggleSelection(video.id) : openPlayer(video)} />
                  <div className="card-body">
                    <div className="video-title"><h2 title={video.path}>{video.name}</h2><button className={video.liked ? "liked" : ""} onClick={() => updateMark(video.id, "liked")} aria-label={video.liked ? "取消点赞" : "点赞"}>♥</button></div>
                    <p>{formatBytes(video.size)}<span>·</span>{formatDate(video.modified)}</p>
                    <div className="tag-line"><div className="tags"><span>{video.ext.toUpperCase()}</span>{video.width && video.width >= 3800 && <span>4K</span>}</div><button className={video.cleanup ? "cleanup active" : "cleanup"} onClick={() => updateMark(video.id, "cleanup")}>{video.cleanup ? "✓ 待清理" : "标记清理"}</button></div>
                  </div>
                </article>
              ))}
            </section>
          ) : <section className="no-results"><strong>没有符合条件的视频</strong><p>试试清除搜索词或调整筛选条件。</p><button onClick={() => { setQuery(""); setFormat("all"); setDurationFilter("all"); setTab("all"); }}>清除筛选</button></section>}
        </>
      )}

      <footer className="footer"><span><i /> 本地模式 · 文件不会上传</span><span>预览缓存在浏览器中 <button onClick={clearCache}>清除缓存</button></span></footer>

      {player && playerUrl && <div className="modal-backdrop" role="presentation" onMouseDown={event => event.currentTarget === event.target && closePlayer()}>
        <section className="player-modal" role="dialog" aria-modal="true" aria-label={`播放 ${player.name}`}>
          <header><div><strong>{player.name}</strong><span>{player.path} · {formatBytes(player.size)}</span></div><button onClick={closePlayer}>×</button></header>
          {/* Local personal videos do not have a captions track available to the app. */}
          {/* eslint-disable-next-line jsx-a11y/media-has-caption */}
          <video src={playerUrl} controls autoPlay playsInline preload="auto" aria-label={`正在播放 ${player.name}`} />
          <footer><button className={player.liked ? "liked" : ""} onClick={() => updateMark(player.id, "liked")}>♥ {player.liked ? "已点赞" : "点赞"}</button><button onClick={() => updateMark(player.id, "cleanup")}>⌑ {player.cleanup ? "已标记待清理" : "标记待清理"}</button></footer>
        </section>
      </div>}

      {confirmDelete && <div className="modal-backdrop">
        <section className="confirm-modal" role="alertdialog" aria-modal="true" aria-labelledby="delete-title">
          <span className="warning">!</span><h2 id="delete-title">永久删除 {selected.size} 个视频？</h2>
          <p>将释放约 <strong>{formatBytes(selectedSize)}</strong>。文件会从源文件夹直接删除，且不经过本应用的回收站，此操作无法撤销。</p>
          <label><input type="checkbox" id="delete-understood" /> 我已确认筛选和选择范围无误</label>
          <div><button className="secondary" onClick={() => setConfirmDelete(false)}>取消</button><button className="danger" onClick={() => { const checkbox = document.getElementById("delete-understood") as HTMLInputElement; if (checkbox?.checked) void deleteSelected(); else setError("请先勾选确认项。"); }}>永久删除</button></div>
        </section>
      </div>}
    </main>
  );
}
