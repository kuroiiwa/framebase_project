"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import ThemeSelector from "../theme-selector";
import PowerPanel from "../power-panel";
import AccountGate, { signOut } from "../account-gate";
import { accountDbName, accountKey } from "../account-storage";
import styles from "./lan.module.css";
import extra from "./lan-extra.module.css";
import fontStyles from "./lan-font.module.css";

type FolderInfo = { path: string; name: string; available: boolean };
type LanVideoIndex = { id: string; sourceName: string; path: string; size: number; modified: number; thumbnailAvailable: boolean };
type LanConfig = { folders: FolderInfo[]; accessUrls: string[]; pairingCode: string; videoCount: number; videoIndex: LanVideoIndex[] };
type CachedSource = { id: string; name: string; videoCount: number };
type CachedVideo = { path: string; size: number; modified: number };
type CachedPreview = { thumb?: Blob };
type LanFontSize = "small" | "medium" | "large";

const CACHE_STORE = "cache";

function openCacheDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(accountDbName(), 1);
    request.onupgradeneeded = () => { if (!request.result.objectStoreNames.contains(CACHE_STORE)) request.result.createObjectStore(CACHE_STORE); };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function cacheGet<T>(db: IDBDatabase, key: string): Promise<T | undefined> {
  return new Promise((resolve, reject) => {
    const request = db.transaction(CACHE_STORE, "readonly").objectStore(CACHE_STORE).get(key);
    request.onsuccess = () => resolve(request.result as T | undefined);
    request.onerror = () => reject(request.error);
  });
}

async function readCachedSources() {
  try {
    const db = await openCacheDb();
    const sources = await cacheGet<Array<{ id: string; name: string; videoCount?: number }>>(db, "source-folders") || [];
    return sources.map(source => ({ id: source.id, name: source.name, videoCount: Number(source.videoCount || 0) }));
  } catch { return []; }
}

async function syncCachedThumbnails(videoIndex: LanVideoIndex[]) {
  const pending = videoIndex.filter(video => !video.thumbnailAvailable);
  if (!pending.length) return 0;
  const db = await openCacheDb();
  const sources = await cacheGet<Array<{ id: string; name: string }>>(db, "source-folders") || [];
  const libraries = new Map<string, CachedVideo[]>();
  for (const source of sources) libraries.set(source.id, await cacheGet<CachedVideo[]>(db, `library:${source.id}`) || []);
  const jobs: Array<{ video: LanVideoIndex; sourceId: string; cached: CachedVideo }> = [];
  for (const video of pending) {
    const matchingSources = sources.filter(source => source.name === video.sourceName);
    for (const source of matchingSources) {
      const cached = libraries.get(source.id)?.find(item => item.path.replaceAll("\\", "/") === video.path && item.size === video.size);
      if (cached) { jobs.push({ video, sourceId: source.id, cached }); break; }
    }
  }
  let cursor = 0;
  let uploaded = 0;
  async function worker() {
    while (cursor < jobs.length) {
      const job = jobs[cursor++];
      const key = `media:${job.sourceId}:${job.cached.path}:${job.cached.size}:${job.cached.modified}`;
      const legacyKey = `media:${job.cached.path}:${job.cached.size}:${job.cached.modified}`;
      const preview = await cacheGet<CachedPreview>(db, key).catch(() => undefined) ?? await cacheGet<CachedPreview>(db, legacyKey).catch(() => undefined);
      if (!preview?.thumb) continue;
      const response = await fetch(`/api/lan/videos/${job.video.id}/thumbnail`, { method: "POST", headers: { "Content-Type": "image/webp" }, body: preview.thumb });
      if (response.ok) uploaded += 1;
    }
  }
  await Promise.all([worker(), worker(), worker()]);
  return uploaded;
}

export default function LanSettings() {
  return <AccountGate>{username => <LanSettingsContent key={username} username={username} />}</AccountGate>;
}

function LanSettingsContent({ username }: { username: string }) {
  const [config, setConfig] = useState<LanConfig | null>(null);
  const [cachedSources, setCachedSources] = useState<CachedSource[]>([]);
  const [folderPath, setFolderPath] = useState("");
  const [fontSize, setFontSize] = useState<LanFontSize>("medium");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const thumbnailSyncRef = useRef(false);

  const loadConfig = useCallback(async () => {
    setLoading(true);
    try {
      const response = await fetch("/api/lan/config", { cache: "no-store" });
      const data = await response.json() as LanConfig & { error?: string };
      if (!response.ok) throw new Error(data.error || "无法读取局域网共享设置");
      setConfig(data);
      setError("");
      if (!thumbnailSyncRef.current && data.videoIndex?.some(video => !video.thumbnailAvailable)) {
        thumbnailSyncRef.current = true;
        void syncCachedThumbnails(data.videoIndex).then(count => {
          if (count) setMessage(`已自动同步 ${count} 张电脑端缓存缩略图。`);
        }).catch(() => undefined);
      }
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "无法连接局域网服务。");
    } finally { setLoading(false); }
  }, []);

  useEffect(() => { queueMicrotask(() => {
    void loadConfig();
    void readCachedSources().then(setCachedSources);
    const savedFontSize = localStorage.getItem(accountKey("framebase-lan-font-size"));
    if (savedFontSize === "small" || savedFontSize === "large") setFontSize(savedFontSize);
  }); }, [loadConfig]);

  function updateFontSize(value: LanFontSize) {
    setFontSize(value);
    localStorage.setItem(accountKey("framebase-lan-font-size"), value);
  }

  async function addFolderPath(path: string) {
    if (!path.trim()) { setError("请输入或选择文件夹的完整路径。"); return; }
    setSaving(true); setMessage(""); setError("");
    try {
      const response = await fetch("/api/lan/config", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ path: path.trim() }) });
      const data = await response.json() as { error?: string; videoCount?: number };
      if (!response.ok) throw new Error(data.error || "无法添加共享目录");
      setFolderPath("");
      setMessage(`共享目录已添加，目前可在手机浏览 ${data.videoCount || 0} 个视频。`);
      await loadConfig();
    } catch (reason) { setError(reason instanceof Error ? reason.message : "无法添加共享目录。"); }
    finally { setSaving(false); }
  }

  async function addFolder() {
    await addFolderPath(folderPath);
  }

  async function pickFolder(source?: CachedSource) {
    setSaving(true); setMessage(""); setError("");
    try {
      const response = await fetch("/api/lan/pick-folder", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(source ? { name: source.name } : {}),
      });
      const data = await response.json() as { path?: string; cancelled?: boolean; error?: string };
      if (!response.ok) throw new Error(data.error || "无法打开文件夹选择窗口");
      if (data.cancelled || !data.path) return;
      setFolderPath(data.path);
      if (source) await addFolderPath(data.path);
      else setMessage("已自动填入完整路径，确认后点击“添加共享”。");
    } catch (reason) { setError(reason instanceof Error ? reason.message : "无法打开文件夹选择窗口。"); }
    finally { setSaving(false); }
  }

  async function removeFolder(index: number, name: string) {
    if (!window.confirm(`停止共享“${name}”？\n\n这不会删除任何视频文件。`)) return;
    setSaving(true); setMessage(""); setError("");
    try {
      const response = await fetch(`/api/lan/config?index=${index}`, { method: "DELETE" });
      const data = await response.json() as { error?: string };
      if (!response.ok) throw new Error(data.error || "无法停止共享");
      setMessage(`已停止共享“${name}”，视频文件没有被删除。`);
      await loadConfig();
    } catch (reason) { setError(reason instanceof Error ? reason.message : "无法停止共享。"); }
    finally { setSaving(false); }
  }

  async function rescan() {
    setSaving(true); setMessage(""); setError("");
    try {
      const response = await fetch("/api/lan/rescan", { method: "POST" });
      const data = await response.json() as { error?: string; videoCount?: number };
      if (!response.ok) throw new Error(data.error || "重新扫描失败");
      setMessage(`扫描完成，共发现 ${data.videoCount || 0} 个视频。`);
      await loadConfig();
    } catch (reason) { setError(reason instanceof Error ? reason.message : "重新扫描失败。"); }
    finally { setSaving(false); }
  }

  async function syncThumbnails() {
    if (!config) return;
    setSaving(true); setMessage(""); setError("");
    try {
      const count = await syncCachedThumbnails(config.videoIndex);
      setMessage(count ? `已同步 ${count} 张缓存缩略图。` : "没有发现新的可同步缩略图；请先在电脑端等待预览缓存完成。");
      thumbnailSyncRef.current = true;
      await loadConfig();
    } catch { setError("无法同步缩略图，请确认电脑端预览缓存已经生成。"); }
    finally { setSaving(false); }
  }

  async function regenerateCode() {
    if (!window.confirm("生成新验证码会让已配对的手机重新验证，是否继续？")) return;
    setSaving(true); setMessage(""); setError("");
    try {
      const response = await fetch("/api/lan/pairing-code", { method: "POST" });
      const data = await response.json() as { error?: string; pairingCode?: string };
      if (!response.ok) throw new Error(data.error || "无法生成新验证码");
      setMessage(`新验证码为 ${data.pairingCode}，已配对设备需要重新输入。`);
      await loadConfig();
    } catch (reason) { setError(reason instanceof Error ? reason.message : "无法生成新验证码。"); }
    finally { setSaving(false); }
  }

  async function copyLink(url: string) {
    try { await navigator.clipboard.writeText(url); setMessage("移动端链接已复制，可以发送到自己的手机。 "); }
    catch { setError("浏览器无法自动复制，请长按或手动选择链接复制。"); }
  }

  return <main className={`${styles.page} ${fontStyles[fontSize]}`}>
    <div className="route-theme"><ThemeSelector /></div>
    <header className={styles.topbar}><Link href="/"><span>F</span>Framebase</Link><div className={fontStyles.topActions}><button className={styles.backLink} onClick={() => window.location.assign("/")}>← 返回视频库</button><b>{username} · 电脑端设置</b><button className={styles.signOut} onClick={() => void signOut()}>退出</button><div className={fontStyles.fontControls} aria-label="页面字体大小"><button className={fontSize === "small" ? fontStyles.active : ""} onClick={() => updateFontSize("small")} title="较小字体" aria-label="较小字体">A−</button><button className={fontSize === "medium" ? fontStyles.active : ""} onClick={() => updateFontSize("medium")} title="标准字体" aria-label="标准字体">A</button><button className={fontSize === "large" ? fontStyles.active : ""} onClick={() => updateFontSize("large")} title="大字体" aria-label="大字体">A＋</button></div></div></header>
    <section className={styles.hero}><p>局域网共享</p><h1>让手机只读访问<br />这台电脑的视频</h1><span>手机只能浏览和播放，不能删除文件或修改共享目录。</span></section>

    {error && <div className={styles.error}>{error}<button onClick={() => setError("")}>×</button></div>}
    {message && <div className={styles.notice}>{message}<button onClick={() => setMessage("")}>×</button></div>}

    <section className={styles.panel}>
      <header><div><small>01</small><strong>共享目录</strong></div><span>{config?.videoCount || 0} 个可播放视频</span></header>
      <p>选择或粘贴 Windows 文件夹的完整路径，例如 <code>D:\视频素材</code>。目录中的子文件夹会一并扫描。</p>
      {cachedSources.length > 0 && <div className={extra.recommended}><span>电脑端已缓存来源</span><div>{cachedSources.map(source => {
        const shared = config?.folders.some(folder => folder.name === source.name);
        return <button className={shared ? extra.shared : ""} onClick={() => void pickFolder(source)} disabled={saving || shared} key={source.id}>{shared ? "✓ " : "选择 "}{source.name}<small>{source.videoCount} 个</small></button>;
      })}</div><p>点击缓存来源会打开 Windows 文件夹选择窗口；确认一次后会自动添加并记住完整路径。</p></div>}
      <div className={styles.addRow}><input value={folderPath} onChange={event => setFolderPath(event.target.value)} onKeyDown={event => event.key === "Enter" && void addFolder()} placeholder="D:\视频素材" aria-label="共享文件夹完整路径" /><div style={{ display: "flex", gap: 8 }}><button style={{ borderColor: "#cbd2bd", background: "#f7f9f2", color: "#59634e" }} onClick={() => void pickFolder()} disabled={saving}>浏览…</button><button onClick={addFolder} disabled={saving}>＋ 添加共享</button></div></div>
      {loading ? <div className={styles.loading}>正在读取设置…</div> : config?.folders.length ? <div className={styles.folderList}>{config.folders.map((folder, index) => <article key={`${folder.path}-${index}`}>
        <i className={folder.available ? styles.online : styles.offline} /><div><strong>{folder.name}</strong><span title={folder.path}>{folder.path}</span></div><em>{folder.available ? "可用" : "不可用"}</em><button onClick={() => removeFolder(index, folder.name)} disabled={saving}>停止共享</button>
      </article>)}</div> : <div className={styles.empty}>尚未添加共享目录。现有电脑端视频库不会自动暴露到局域网。</div>}
      <div className={extra.secondaryActions}><button className={styles.rescan} onClick={rescan} disabled={saving || !config?.folders.length}>↻ 重新扫描共享目录</button><button className={styles.rescan} onClick={syncThumbnails} disabled={saving || !config?.videoIndex.length}>▣ 同步电脑端缩略图</button></div>
    </section>

    <section className={styles.panel}>
      <header><div><small>02</small><strong>手机访问链接</strong></div><span>同一 Wi-Fi / 局域网</span></header>
      <p>手机使用固定地址访问，输入当前用户的六位验证码。电脑端退出此账户后，手机配对立即失效。</p>
      <div className={extra.pairing}><div><span>当前配对验证码</span><strong data-pairing-code>{config?.pairingCode?.split("").join(" ") || "— — — — — —"}</strong></div><button onClick={regenerateCode} disabled={saving}>生成新验证码</button></div>
      {config?.accessUrls.length ? <div className={styles.linkList}>{config.accessUrls.map(url => <article key={url}><a href={url} target="_blank" rel="noreferrer">{url}</a><button onClick={() => copyLink(url)}>复制</button></article>)}</div> : <div className={styles.empty}>没有检测到可用的局域网 IPv4 地址。请确认电脑已连接 Wi-Fi 或网线。</div>}
      <ol><li>电脑和手机连接到同一个局域网。</li><li>保持 Framebase 启动窗口打开。</li><li>如果手机无法连接，请允许 Windows 防火墙中的专用网络访问。</li></ol>
    </section>
    <PowerPanel admin />
    <footer><span>设置仅保存在这台电脑</span><Link href="/">返回电脑端视频库 →</Link></footer>
  </main>;
}
