"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import ThemeSelector from "../theme-selector";
import PowerPanel from "../power-panel";
import { usePlayerShortcuts } from "../player-shortcuts";
import styles from "./mobile.module.css";
import extra from "./mobile-extra.module.css";

type LanVideo = {
  id: string;
  name: string;
  ext: string;
  size: number;
  modified: number;
  sourceName: string;
  path: string;
  streamUrl: string;
  thumbnailUrl: string;
};

type SortMode = "newest" | "name" | "largest" | "random";

function randomRank(value: string, seed: number) {
  let hash = 2166136261 ^ seed;
  for (let index = 0; index < value.length; index++) hash = Math.imul(hash ^ value.charCodeAt(index), 16777619);
  return hash >>> 0;
}

function formatBytes(bytes: number) {
  if (!bytes) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  const index = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  return `${(bytes / 1024 ** index).toFixed(index > 2 ? 1 : 0)} ${units[index]}`;
}

function formatDate(timestamp: number) {
  return new Intl.DateTimeFormat("zh-CN", { month: "short", day: "numeric", year: "numeric" }).format(timestamp);
}

function extensionColor(ext: string) {
  const colors: Record<string, string> = { mp4: "#c9f45e", mov: "#6ee7d3", webm: "#8bbcff", mkv: "#c8a7ff", avi: "#ffb86b", wmv: "#ff8f91" };
  return colors[ext] || "#d7e2bd";
}

export default function MobileLibrary() {
  const [videos, setVideos] = useState<LanVideo[]>([]);
  const [sourceCount, setSourceCount] = useState(0);
  const [query, setQuery] = useState("");
  const [format, setFormat] = useState("all");
  const [sort, setSort] = useState<SortMode>("newest");
  const [randomSeed, setRandomSeed] = useState(0);
  const [player, setPlayer] = useState<LanVideo | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [pairingRequired, setPairingRequired] = useState(false);
  const [pairingCode, setPairingCode] = useState("");
  const [pairing, setPairing] = useState(false);
  const [powerInView, setPowerInView] = useState(false);
  const playerVideoRef = useRef<HTMLVideoElement>(null);
  const powerSectionRef = useRef<HTMLDivElement>(null);

  async function loadVideos() {
    setLoading(true);
    try {
      const response = await fetch("/api/lan/videos", { cache: "no-store" });
      const data = await response.json() as { videos?: LanVideo[]; sourceCount?: number; error?: string; codeRequired?: boolean };
      if (response.status === 401 && data.codeRequired) {
        setPairingRequired(true); setError(""); return;
      }
      if (!response.ok) throw new Error(data.error || "无法读取视频库");
      setVideos(data.videos || []);
      setSourceCount(data.sourceCount || 0);
      setPairingRequired(false);
      setError("");
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "无法连接电脑端 Framebase 服务。");
    } finally {
      setLoading(false);
    }
  }

  async function pairDevice() {
    if (pairingCode.length !== 6) { setError("请输入电脑端显示的六位验证码。"); return; }
    setPairing(true); setError("");
    try {
      const response = await fetch("/api/lan/pair", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ code: pairingCode }) });
      const data = await response.json() as { error?: string };
      if (!response.ok) throw new Error(data.error || "验证失败");
      setPairingRequired(false); setPairingCode("");
      await loadVideos();
    } catch (reason) { setError(reason instanceof Error ? reason.message : "验证失败。"); }
    finally { setPairing(false); }
  }

  function shuffleVideos() {
    setRandomSeed(crypto.getRandomValues(new Uint32Array(1))[0]);
    setSort("random");
  }

  useEffect(() => { queueMicrotask(() => void loadVideos()); }, []);
  usePlayerShortcuts(Boolean(player), playerVideoRef, () => setPlayer(null));
  useEffect(() => {
    if (loading || pairingRequired) return;
    const updatePowerVisibility = () => {
      const bounds = powerSectionRef.current?.getBoundingClientRect();
      setPowerInView(Boolean(bounds && bounds.top < window.innerHeight * 0.6 && bounds.bottom > 0));
    };
    updatePowerVisibility();
    window.addEventListener("scroll", updatePowerVisibility, { passive: true });
    window.addEventListener("resize", updatePowerVisibility);
    return () => {
      window.removeEventListener("scroll", updatePowerVisibility);
      window.removeEventListener("resize", updatePowerVisibility);
    };
  }, [loading, pairingRequired]);

  function scrollToPower() {
    const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    powerSectionRef.current?.scrollIntoView({ behavior: reduceMotion ? "auto" : "smooth", block: "start" });
  }

  const formats = [...new Set(videos.map(video => video.ext))].sort();
  const filtered = useMemo(() => {
    const lower = query.trim().toLocaleLowerCase("zh-CN");
    return videos.filter(video => {
      if (format !== "all" && video.ext !== format) return false;
      return !lower || video.name.toLocaleLowerCase("zh-CN").includes(lower) || video.path.toLocaleLowerCase("zh-CN").includes(lower) || video.sourceName.toLocaleLowerCase("zh-CN").includes(lower);
    }).sort((a, b) => sort === "name" ? a.name.localeCompare(b.name, "zh-CN") : sort === "largest" ? b.size - a.size : sort === "random" ? randomRank(a.id, randomSeed) - randomRank(b.id, randomSeed) : b.modified - a.modified);
  }, [videos, query, format, sort, randomSeed]);

  if (pairingRequired && !loading) return <main className={styles.app}>
    <div className="route-theme"><ThemeSelector /></div>
    <header className={styles.topbar}><span className={styles.brand}><span>F</span>Framebase</span><span className={styles.readonly}>设备配对</span></header>
    <section className={extra.pairPage}><div className={extra.pairIcon}>•••</div><p>首次访问验证</p><h1>输入电脑端的<br />六位验证码</h1><span>在电脑打开 Framebase → 局域网，即可看到当前验证码。验证一次后，这台手机会自动保持配对。</span>
      <input value={pairingCode} onChange={event => setPairingCode(event.target.value.replace(/\D/g, "").slice(0, 6))} onKeyDown={event => event.key === "Enter" && void pairDevice()} inputMode="numeric" pattern="[0-9]*" maxLength={6} placeholder="000000" aria-label="六位配对验证码" autoComplete="one-time-code" />
      {error && <em>{error}</em>}<button onClick={pairDevice} disabled={pairing || pairingCode.length !== 6}>{pairing ? "正在验证…" : "验证并进入视频库"}</button>
    </section>
  </main>;

  return (
    <main className={styles.app}>
      <div className="route-theme"><ThemeSelector /></div>
      <header className={styles.topbar}>
        <span className={styles.brand}><span>F</span>Framebase</span>
        <span className={styles.readonly}>只读 · 局域网</span>
      </header>

      <section className={styles.hero}>
        <p>移动视频库</p>
        <h1>随手浏览，直接播放</h1>
        <div className={styles.summary}><span><b>{videos.length}</b> 个视频</span><i /><span><b>{sourceCount}</b> 个共享目录</span></div>
      </section>

      <section className={styles.controls} aria-label="视频筛选">
        <label className={styles.search}><span>⌕</span><input value={query} onChange={event => setQuery(event.target.value)} placeholder="搜索视频、路径或来源" aria-label="搜索视频" /></label>
        <div className={styles.selects}>
          <select value={format} onChange={event => setFormat(event.target.value)} aria-label="格式筛选"><option value="all">全部格式</option>{formats.map(ext => <option value={ext} key={ext}>{ext.toUpperCase()}</option>)}</select>
          <select value={sort} onChange={event => event.target.value === "random" ? shuffleVideos() : setSort(event.target.value as SortMode)} aria-label="排序"><option value="newest">最近修改</option><option value="name">按名称</option><option value="largest">文件最大</option><option value="random">随机打乱</option></select>
          <button className={sort === "random" ? extra.randomActive : ""} onClick={shuffleVideos} aria-label="重新随机打乱" title="重新随机打乱">⤨</button>
          <button onClick={loadVideos} disabled={loading} aria-label="刷新视频清单">↻</button>
        </div>
      </section>

      {loading ? <section className={styles.state}><span className={styles.spinner} /><strong>正在连接电脑视频库</strong><p>首次扫描较大的共享目录可能需要一点时间。</p></section> : error ? <section className={`${styles.state} ${styles.error}`}><span>!</span><strong>暂时无法访问</strong><p>{error}</p><button onClick={loadVideos}>重新连接</button></section> : filtered.length ? <>
        <div className={styles.resultHead}><strong>{filtered.length} 个结果</strong><span>点击卡片开始播放</span></div>
        <section className={styles.grid} aria-label="视频列表">{filtered.map(video => <article className={styles.card} key={video.id}>
          <button className={styles.poster} onClick={() => setPlayer(video)} aria-label={`播放 ${video.name}`} style={{ "--accent": extensionColor(video.ext) } as React.CSSProperties}>
            {/* LAN thumbnails are generated from the existing local browser preview cache. */}
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img className={extra.thumbnail} src={video.thumbnailUrl} alt="" loading="lazy" onError={event => { event.currentTarget.hidden = true; }} />
            <span className={styles.ext}>{video.ext.toUpperCase()}</span><span className={styles.play}>▶</span><small>{formatBytes(video.size)}</small>
          </button>
          <button className={styles.cardBody} onClick={() => setPlayer(video)}>
            <strong title={video.name}>{video.name}</strong>
            <span>{video.sourceName} · {formatDate(video.modified)}</span>
          </button>
        </article>)}</section>
      </> : <section className={styles.state}><span>◇</span><strong>{videos.length ? "没有符合条件的视频" : "共享目录中还没有视频"}</strong><p>{videos.length ? "尝试清除搜索词或格式筛选。" : "请在电脑端检查共享目录，然后刷新此页面。"}</p></section>}

      {!loading && !pairingRequired && <div className={styles.powerDestination} ref={powerSectionRef}><PowerPanel /></div>}
      {!loading && !pairingRequired && !player && !powerInView && <button className={styles.jumpToPower} type="button" onClick={scrollToPower} aria-label="跳转到底部的远程关机区域"><span aria-hidden="true">↓</span> 到底部 · 关机</button>}
      <footer className={styles.footer}><span>连接到你的电脑</span><span>视频只读 · 关机需单独授权</span></footer>

      {player && <div className={styles.playerBackdrop} role="presentation">
        <section className={styles.playerModal} role="dialog" aria-modal="true" aria-label={`播放 ${player.name}`}>
          <header><div><small>{player.sourceName}</small><strong>{player.name}</strong></div><button onClick={() => setPlayer(null)} aria-label="关闭播放器">×</button></header>
          {/* Local shared videos do not have a captions track available to the app. */}
          {/* eslint-disable-next-line jsx-a11y/media-has-caption */}
          <video ref={playerVideoRef} src={player.streamUrl} controls autoPlay playsInline preload="metadata" aria-keyshortcuts="ArrowLeft ArrowRight" />
          <footer><span>← / → 10 秒 · 空格暂停 · ↑ / ↓ 音量 · M 静音 · F 全屏 · Esc 返回</span><span>{player.ext.toUpperCase()}</span><span>{formatBytes(player.size)}</span><span>{formatDate(player.modified)}</span></footer>
        </section>
      </div>}
    </main>
  );
}
