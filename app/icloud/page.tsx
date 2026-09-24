"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import AccountGate, { signOut } from "../account-gate";
import ThemeSelector from "../theme-selector";
import styles from "./icloud.module.css";

type IcloudConfig = {
  selectedDirectory: string | null;
  backupDirectory: string | null;
  connectionStatus: "not_connected" | "connected" | "expired";
  appleAccount: string | null;
  lastScanAt: string | null;
  lastBackupAt: string | null;
  updatedAt: string | null;
};

export default function IcloudPage() {
  return <AccountGate>{username => <IcloudCenter key={username} username={username} />}</AccountGate>;
}

function IcloudCenter({ username }: { username: string }) {
  const [config, setConfig] = useState<IcloudConfig | null>(null);
  const [manualPath, setManualPath] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");

  useEffect(() => {
    let cancelled = false;
    void fetch("/api/icloud/config", { cache: "no-store" })
      .then(async response => {
        const data = await response.json() as IcloudConfig & { error?: string };
        if (!response.ok) throw new Error(data.error || "无法读取 iCloud 备份配置");
        return data;
      })
      .then(data => {
        if (cancelled) return;
        setConfig(data);
        setManualPath(data.selectedDirectory || "");
      })
      .catch(reason => { if (!cancelled) setError(reason instanceof Error ? reason.message : "无法读取配置"); });
    return () => { cancelled = true; };
  }, []);

  async function chooseFolder() {
    setBusy(true); setError(""); setMessage("");
    try {
      const response = await fetch("/api/icloud/pick-folder", { method: "POST" });
      const data = await response.json() as IcloudConfig & { cancelled?: boolean; error?: string };
      if (!response.ok) throw new Error(data.error || "无法选择备份文件夹");
      if (data.cancelled) return;
      setConfig(data); setManualPath(data.selectedDirectory || "");
      setMessage("备份目录已为当前 FrameBase 用户单独创建。");
    } catch (reason) { setError(reason instanceof Error ? reason.message : "无法选择备份文件夹"); }
    finally { setBusy(false); }
  }

  async function saveManualPath(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true); setError(""); setMessage("");
    try {
      const response = await fetch("/api/icloud/config", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ path: manualPath.trim() }) });
      const data = await response.json() as IcloudConfig & { error?: string };
      if (!response.ok) throw new Error(data.error || "无法保存备份目录");
      setConfig(data); setManualPath(data.selectedDirectory || "");
      setMessage("备份目录已保存。");
    } catch (reason) { setError(reason instanceof Error ? reason.message : "无法保存备份目录"); }
    finally { setBusy(false); }
  }

  const readyForConnection = Boolean(config?.backupDirectory);
  return <main className={styles.page}>
    <div className="route-theme"><ThemeSelector /></div>
    <header className={styles.topbar}>
      <Link href="/"><span>F</span>Framebase</Link>
      <div><button className={styles.backLink} onClick={() => window.location.assign("/")}>← 返回视频库</button><b>{username} · iCloud 备份中心</b><button onClick={() => void signOut()}>退出</button></div>
    </header>

    <section className={styles.hero}>
      <p>独立备份中心</p>
      <h1>把 iCloud 原片安全保存到这台电脑</h1>
      <span>每个 FrameBase 用户拥有独立的目录、认证会话、任务和清单。当前阶段只配置本地目录，不连接或修改 iCloud。</span>
    </section>

    {error && <div className={styles.error} role="alert">{error}<button onClick={() => setError("")}>×</button></div>}
    {message && <div className={styles.notice} role="status">{message}<button onClick={() => setMessage("")}>×</button></div>}

    <section className={styles.content}>
      <article className={styles.card}>
        <div className={styles.cardHead}><span>1</span><div><h2>选择备份位置</h2><p>选择一个上级文件夹，FrameBase 会自动创建 <code>FrameBase-iCloud\{username}</code>。</p></div></div>
        <div className={styles.currentPath}><small>当前用户的备份目录</small><strong>{config?.backupDirectory || "尚未设置"}</strong></div>
        <div className={styles.actions}><button className={styles.primary} onClick={() => void chooseFolder()} disabled={busy}>{busy ? "请稍候…" : "选择文件夹"}</button></div>
        <form className={styles.manual} onSubmit={saveManualPath}><label>也可以输入上级文件夹的绝对路径<input value={manualPath} onChange={event => setManualPath(event.target.value)} placeholder="例如 D:\\照片备份" disabled={busy} /></label><button disabled={busy || !manualPath.trim()}>保存路径</button></form>
      </article>

      <article className={`${styles.card} ${!readyForConnection ? styles.disabled : ""}`}>
        <div className={styles.cardHead}><span>2</span><div><h2>连接 iCloud</h2><p>下一阶段将在 FrameBase 内完成区域识别、密码和双重验证。</p></div></div>
        <div className={styles.status}><i /><strong>{config?.connectionStatus === "connected" ? "已连接" : "尚未连接"}</strong><small>{readyForConnection ? "本地目录已经就绪" : "请先设置备份目录"}</small></div>
        <button disabled>即将开放</button>
      </article>

      <article className={`${styles.card} ${styles.disabled}`}>
        <div className={styles.cardHead}><span>3</span><div><h2>扫描、备份与验证</h2><p>连接后先只读统计，再由当前用户选择测试备份或完整增量备份。</p></div></div>
        <ul><li>原片、视频、Live Photo 与 RAW</li><li>断点续传和失败重试</li><li>本地存在性、大小与媒体可读性验证</li></ul>
      </article>
    </section>

    <footer><span>配置只保存在这台电脑，并按 FrameBase 用户隔离</span><Link href="/">返回视频库 →</Link></footer>
  </main>;
}
