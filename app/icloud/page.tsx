"use client";

/* eslint-disable @next/next/no-html-link-for-pages -- hard navigation is required by the Vinext compatibility router. */

import Link from "next/link";
import { useEffect, useState } from "react";
import AccountGate, { signOut } from "../account-gate";
import ThemeSelector from "../theme-selector";
import styles from "./icloud.module.css";

type IcloudConfig = {
  selectedDirectory: string | null;
  backupDirectory: string | null;
  connectionStatus: "not_connected" | "connected" | "expired";
  provider: "icloudpd";
  providerInfo?: { id: "icloudpd"; available: boolean; version: string | null };
  appleAccount: string | null;
  icloudDomain: "cn" | "com";
  lastConnectionCheckAt: string | null;
  lastConnectionMessage: string | null;
  lastScanAt: string | null;
  lastBackupAt: string | null;
  updatedAt: string | null;
  scan?: { scannedAt: string | null; sampleCount: number; samples: Array<{ name: string; extension: string; mediaType: "photo" | "video" }> };
  backup?: { completedAt: string | null; fileCount: number; files: Array<{ name: string; relativePath: string; extension: string; mediaType: "photo" | "video"; size: number; sha256: string | null }> };
  timeline?: TimelineState;
  fullBackup?: FullBackupState;
  fullManifest?: { updatedAt: string | null; fileCount: number; coverage: { years: CoverageBucket[]; quarters: CoverageBucket[]; months: CoverageBucket[] } };
  releasePlan?: ReleasePlan | null;
};

type ReleasePlan = { id: string | null; status: "ready" | "blocked" | "confirmed"; message: string; createdAt: string | null; confirmedAt: string | null; eligibleCount: number; eligibleBytes: number; failedCount: number; files: Array<{ name: string; relativePath: string; mediaType: "photo" | "video"; size: number }> };

type FullBackupState = {
  status: "idle" | "planning" | "downloading" | "verifying" | "paused" | "cancelled" | "completed" | "failed";
  message: string; startedAt: string | null; updatedAt: string | null; completedAt: string | null; phase: string; currentLibrary: string | null;
  currentRange: string | null; rangeIndex: number; rangeCount: number; completedRanges: string[];
  planned: number; downloaded: number; plannedPhotoCount: number; plannedVideoCount: number; syncedPhotoCount: number; syncedVideoCount: number; downloadedBytes: number; transferRateBps: number;
  verified: number; skipped: number; failed: number; photoCount: number; videoCount: number; verifiedBytes: number; manifestFileCount: number;
  ranges: BackupRange[];
};
type TimelineBucket = { key: string; itemCount: number; photoCount: number; videoCount: number; livePhotoCount: number; rawCount: number; originalBytes: number };
type CoverageBucket = { key: string; verifiedCount: number; verifiedBytes: number; photoCount: number; videoCount: number };
type TimelineState = { scannedAt: string | null; total: TimelineBucket | null; years: TimelineBucket[]; quarters: TimelineBucket[]; months: TimelineBucket[] };
type BackupRange = { key: string; label: string; start: string; end: string };
type TimelineGranularity = "years" | "quarters" | "months";

type AuthState = { status: "idle" | "starting" | "waiting_password" | "verifying" | "waiting_mfa" | "connected" | "failed" | "cancelled" | "tool_missing"; message: string; startedAt?: string };
const activeAuthStates = new Set<AuthState["status"]>(["starting", "waiting_password", "verifying", "waiting_mfa"]);

export default function IcloudPage() {
  return <AccountGate>{username => <IcloudCenter key={username} username={username} />}</AccountGate>;
}

function IcloudCenter({ username }: { username: string }) {
  const [config, setConfig] = useState<IcloudConfig | null>(null);
  const [manualPath, setManualPath] = useState("");
  const [appleAccount, setAppleAccount] = useState("");
  const [icloudDomain, setIcloudDomain] = useState<"cn" | "com">("cn");
  const [auth, setAuth] = useState<AuthState | null>(null);
  const [password, setPassword] = useState("");
  const [mfaCode, setMfaCode] = useState("");
  const [busy, setBusy] = useState<"folder" | "path" | "connection" | "verify" | "auth" | "scan" | "backup" | "full" | "release" | null>(null);
  const [releaseConfirmation, setReleaseConfirmation] = useState("");
  const [timelineGranularity, setTimelineGranularity] = useState<TimelineGranularity>("years");
  const [selectedPeriods, setSelectedPeriods] = useState<string[]>([]);
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
        setAppleAccount(data.appleAccount || "");
        setIcloudDomain(data.icloudDomain || "cn");
      })
      .catch(reason => { if (!cancelled) setError(reason instanceof Error ? reason.message : "无法读取配置"); });
    return () => { cancelled = true; };
  }, []);

  useEffect(() => {
    if (!auth || !activeAuthStates.has(auth.status)) return;
    const timer = setInterval(() => {
      void fetch("/api/icloud/auth/status", { cache: "no-store" })
        .then(response => response.json() as Promise<AuthState>)
        .then(next => {
          setAuth(next);
          if (next.status === "connected") {
            setConfig(current => current ? { ...current, connectionStatus: "connected", lastConnectionMessage: next.message, lastConnectionCheckAt: new Date().toISOString() } : current);
            setMessage("Apple iCloud 登录成功。");
          }
        })
        .catch(() => undefined);
    }, 1000);
    return () => clearInterval(timer);
  }, [auth]);

  const fullBackupActive = Boolean(config?.fullBackup && ["planning", "downloading", "verifying"].includes(config.fullBackup.status));
  useEffect(() => {
    if (!fullBackupActive) return;
    const timer = setInterval(() => {
      void fetch("/api/icloud/config", { cache: "no-store" })
        .then(response => response.json() as Promise<IcloudConfig>)
        .then(data => setConfig(data))
        .catch(() => undefined);
    }, 1000);
    return () => clearInterval(timer);
  }, [fullBackupActive]);

  async function chooseFolder() {
    setBusy("folder"); setError(""); setMessage("");
    try {
      const response = await fetch("/api/icloud/pick-folder", { method: "POST" });
      const data = await response.json() as IcloudConfig & { cancelled?: boolean; error?: string };
      if (!response.ok) throw new Error(data.error || "无法选择备份文件夹");
      if (data.cancelled) return;
      setConfig(current => ({ ...data, providerInfo: current?.providerInfo })); setManualPath(data.selectedDirectory || "");
      setMessage("备份目录已为当前 FrameBase 用户单独创建。");
    } catch (reason) { setError(reason instanceof Error ? reason.message : "无法选择备份文件夹"); }
    finally { setBusy(null); }
  }

  async function saveManualPath(event: React.FormEvent) {
    event.preventDefault();
    setBusy("path"); setError(""); setMessage("");
    try {
      const response = await fetch("/api/icloud/config", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ path: manualPath.trim() }) });
      const data = await response.json() as IcloudConfig & { error?: string };
      if (!response.ok) throw new Error(data.error || "无法保存备份目录");
      setConfig(current => ({ ...data, providerInfo: current?.providerInfo })); setManualPath(data.selectedDirectory || "");
      setMessage("备份目录已保存。");
    } catch (reason) { setError(reason instanceof Error ? reason.message : "无法保存备份目录"); }
    finally { setBusy(null); }
  }

  async function saveConnection(event: React.FormEvent) {
    event.preventDefault();
    setBusy("connection"); setError(""); setMessage("");
    try {
      const response = await fetch("/api/icloud/connection", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ appleAccount: appleAccount.trim(), icloudDomain }) });
      const data = await response.json() as IcloudConfig & { error?: string };
      if (!response.ok) throw new Error(data.error || "无法保存 Apple 连接配置");
      setConfig(data); setAppleAccount(data.appleAccount || ""); setIcloudDomain(data.icloudDomain);
      setMessage("Apple 账户配置已保存；密码不会保存在 FrameBase 配置中。");
    } catch (reason) { setError(reason instanceof Error ? reason.message : "无法保存 Apple 连接配置"); }
    finally { setBusy(null); }
  }

  async function verifyConnection() {
    setBusy("verify"); setError(""); setMessage("");
    try {
      const response = await fetch("/api/icloud/verify", { method: "POST" });
      const data = await response.json() as IcloudConfig & { verification?: { status: string; message: string }; error?: string };
      if (!response.ok) throw new Error(data.error || "无法验证 iCloud 会话");
      setConfig(data);
      if (data.verification?.status === "connected") setMessage("iCloud 会话验证成功。");
      else setError(data.verification?.message || "现有会话不可用，需要重新登录 Apple ID。");
    } catch (reason) { setError(reason instanceof Error ? reason.message : "无法验证 iCloud 会话"); }
    finally { setBusy(null); }
  }

  async function startAuthentication() {
    setBusy("auth"); setError(""); setMessage("");
    try {
      const response = await fetch("/api/icloud/auth/start", { method: "POST" });
      const data = await response.json() as AuthState & { error?: string };
      if (!response.ok) throw new Error(data.error || "无法启动 Apple 登录");
      setAuth(data);
    } catch (reason) { setError(reason instanceof Error ? reason.message : "无法启动 Apple 登录"); }
    finally { setBusy(null); }
  }

  async function submitAuthInput(event: React.FormEvent, type: "password" | "mfa") {
    event.preventDefault();
    const value = type === "password" ? password : mfaCode.trim();
    setError("");
    try {
      const response = await fetch("/api/icloud/auth/input", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ type, value }) });
      const data = await response.json() as AuthState & { error?: string };
      if (!response.ok) throw new Error(data.error || "无法提交登录信息");
      setAuth(data);
      if (type === "password") setPassword(""); else setMfaCode("");
    } catch (reason) { setError(reason instanceof Error ? reason.message : "无法提交登录信息"); }
  }

  async function cancelAuthentication() {
    const response = await fetch("/api/icloud/auth/cancel", { method: "POST" });
    const data = await response.json() as AuthState;
    setAuth(data); setPassword(""); setMfaCode("");
  }

  async function scanRecent() {
    setBusy("scan"); setError(""); setMessage("");
    try {
      const response = await fetch("/api/icloud/scan", { method: "POST" });
      const data = await response.json() as IcloudConfig & { scanResult?: { status: string; message: string }; error?: string };
      if (!response.ok) throw new Error(data.error || "无法扫描 iCloud 媒体");
      setConfig(current => ({ ...data, providerInfo: current?.providerInfo }));
      if (data.scanResult?.status === "ready") setMessage(data.scanResult.message);
      else setError(data.scanResult?.message || "iCloud 只读扫描失败，请重新验证连接。");
    } catch (reason) { setError(reason instanceof Error ? reason.message : "无法扫描 iCloud 媒体"); }
    finally { setBusy(null); }
  }

  async function backupRecent() {
    if (!window.confirm("将最近 3 个 iCloud 媒体项目复制到当前用户的备份目录。此操作不会删除或移动 iCloud 原文件，是否继续？")) return;
    setBusy("backup"); setError(""); setMessage("");
    try {
      const response = await fetch("/api/icloud/backup/test", { method: "POST" });
      const data = await response.json() as IcloudConfig & { backupResult?: { status: string; message: string }; error?: string };
      if (!response.ok) throw new Error(data.error || "无法完成测试备份");
      setConfig(current => ({ ...data, providerInfo: current?.providerInfo }));
      if (data.backupResult?.status === "completed") setMessage(data.backupResult.message);
      else setError(data.backupResult?.message || "测试备份未完成，请检查连接和本地目录。");
    } catch (reason) { setError(reason instanceof Error ? reason.message : "无法完成测试备份"); }
    finally { setBusy(null); }
  }

  async function controlFullBackup(action: "start" | "resume" | "pause" | "cancel", ranges: BackupRange[] = []) {
    if (action === "start" && !window.confirm(ranges.length ? `将增量备份所选的 ${ranges.length} 个时间范围，包含图片、视频、Live Photo 和 RAW 原件。不会删除或移动云端内容，是否开始？` : "将开始备份当前用户 iCloud 中的全部图片和视频原文件。任务不会删除或移动任何云端内容；可以暂停并稍后继续。是否开始？")) return;
    if (action === "cancel" && !window.confirm("取消任务会停止当前下载，但保留已下载文件和已验证清单。是否取消？")) return;
    setBusy("full"); setError(""); setMessage("");
    try {
      const response = await fetch(`/api/icloud/backup/full/${action}`, { method: "POST", headers: action === "start" || action === "resume" ? { "Content-Type": "application/json" } : undefined, body: action === "start" || action === "resume" ? JSON.stringify({ ranges }) : undefined });
      const data = await response.json() as { fullBackup?: FullBackupState; error?: string };
      if (!response.ok) throw new Error(data.error || "无法更新完整备份任务");
      if (data.fullBackup) setConfig(current => current ? { ...current, fullBackup: data.fullBackup } : current);
      setMessage(action === "pause" ? "正在安全暂停任务…" : action === "cancel" ? "正在安全取消任务…" : "完整增量备份已进入后台运行。可留在此页查看进度。");
    } catch (reason) { setError(reason instanceof Error ? reason.message : "无法更新完整备份任务"); }
    finally { setBusy(null); }
  }

  async function scanTimeline() {
    setBusy("scan"); setError(""); setMessage("");
    try {
      const response = await fetch("/api/icloud/timeline", { method: "POST" });
      const data = await response.json() as { timeline?: TimelineState; timelineResult?: { status: string; message: string }; error?: string };
      if (!response.ok) throw new Error(data.error || "无法读取 iCloud 时间统计");
      if (data.timeline) setConfig(current => current ? { ...current, timeline: data.timeline } : current);
      setSelectedPeriods([]);
      if (data.timelineResult?.status === "ready") setMessage(data.timelineResult.message); else setError(data.timelineResult?.message || "时间统计失败，请重新验证连接。");
    } catch (reason) { setError(reason instanceof Error ? reason.message : "无法读取 iCloud 时间统计"); }
    finally { setBusy(null); }
  }

  function periodRange(key: string): BackupRange {
    let year: number; let startMonth: number; let monthCount: number; let label: string;
    if (timelineGranularity === "years") { year = Number(key); startMonth = 1; monthCount = 12; label = `${year} 年`; }
    else if (timelineGranularity === "quarters") { const match = /^(\d{4})-Q([1-4])$/.exec(key)!; year = Number(match[1]); startMonth = (Number(match[2]) - 1) * 3 + 1; monthCount = 3; label = `${year} 年第 ${match[2]} 季度`; }
    else { const [yearText, monthText] = key.split("-"); year = Number(yearText); startMonth = Number(monthText); monthCount = 1; label = `${year} 年 ${startMonth} 月`; }
    const endBase = new Date(Date.UTC(year, startMonth - 1 + monthCount, 1));
    endBase.setUTCSeconds(endBase.getUTCSeconds() - 1);
    const pad = (value: number) => String(value).padStart(2, "0");
    return { key, label, start: `${year}-${pad(startMonth)}-01T00:00:00`, end: `${endBase.getUTCFullYear()}-${pad(endBase.getUTCMonth() + 1)}-${pad(endBase.getUTCDate())}T23:59:59` };
  }

  async function createReleasePlan() {
    if (!window.confirm("FrameBase 将重新读取并计算完整备份中每个文件的 SHA-256。只有全部通过后才会生成释放计划；此步骤不会修改 iCloud。是否继续？")) return;
    setBusy("release"); setError(""); setMessage("");
    try {
      const response = await fetch("/api/icloud/release/plan", { method: "POST" });
      const data = await response.json() as { releasePlan?: ReleasePlan; error?: string };
      if (!response.ok || !data.releasePlan) throw new Error(data.error || "无法生成释放计划");
      setConfig(current => current ? { ...current, releasePlan: data.releasePlan } : current);
      if (data.releasePlan.status === "ready") setMessage(data.releasePlan.message); else setError(data.releasePlan.message);
    } catch (reason) { setError(reason instanceof Error ? reason.message : "无法生成释放计划"); }
    finally { setBusy(null); }
  }

  async function confirmReleasePlan(event: React.FormEvent) {
    event.preventDefault();
    if (!config?.releasePlan?.id) return;
    setBusy("release"); setError(""); setMessage("");
    try {
      const response = await fetch("/api/icloud/release/confirm", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ planId: config.releasePlan.id, confirmation: releaseConfirmation }) });
      const data = await response.json() as { releasePlan?: ReleasePlan; error?: string };
      if (!response.ok || !data.releasePlan) throw new Error(data.error || "无法确认释放计划");
      setConfig(current => current ? { ...current, releasePlan: data.releasePlan } : current); setReleaseConfirmation("");
      setMessage(data.releasePlan.message);
    } catch (reason) { setError(reason instanceof Error ? reason.message : "无法确认释放计划"); }
    finally { setBusy(null); }
  }

  function formatBytes(bytes: number) {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(1)} KB`;
    if (bytes < 1024 ** 3) return `${(bytes / 1024 ** 2).toFixed(1)} MB`;
    return `${(bytes / 1024 ** 3).toFixed(2)} GB`;
  }

  const readyForConnection = Boolean(config?.backupDirectory);
  const connectionConfigured = Boolean(config?.appleAccount);
  const timelineBuckets = config?.timeline?.[timelineGranularity] || [];
  const coverageByKey = new Map((config?.fullManifest?.coverage?.[timelineGranularity] || []).map(bucket => [bucket.key, bucket]));
  const rangesOverlap = (left: BackupRange, right: BackupRange) => left.start <= right.end && right.start <= left.end;
  const rangeContains = (outer: BackupRange, inner: BackupRange) => outer.start <= inner.start && outer.end >= inner.end;
  const fullBackup = config?.fullBackup;
  const syncedPhotoCount = fullBackup?.syncedPhotoCount || fullBackup?.photoCount || 0;
  const syncedVideoCount = fullBackup?.syncedVideoCount || fullBackup?.videoCount || 0;
  const plannedPhotoCount = Math.max(syncedPhotoCount, fullBackup?.plannedPhotoCount || 0);
  const plannedVideoCount = Math.max(syncedVideoCount, fullBackup?.plannedVideoCount || 0);
  const progressDone = fullBackup?.phase === "verifying" || fullBackup?.status === "completed" ? fullBackup.verified : fullBackup?.downloaded || 0;
  const progressTotal = Math.max(progressDone, fullBackup?.planned || plannedPhotoCount + plannedVideoCount);
  const progressPercent = progressTotal ? Math.min(100, Math.round(progressDone / progressTotal * 100)) : 0;
  const backupStateForBucket = (bucket: TimelineBucket) => {
    const bucketRange = periodRange(bucket.key);
    const activeRange = fullBackup?.ranges?.length ? fullBackup.ranges[Math.max(0, (fullBackup.rangeIndex || 1) - 1)] : null;
    const completedDefinitions = (fullBackup?.ranges || []).filter(range => fullBackup?.completedRanges.includes(range.key));
    const coverage = coverageByKey.get(bucket.key);
    if (completedDefinitions.some(range => rangeContains(range, bucketRange))) return { key: "backupComplete", label: "已备份", detail: coverage ? `本地已验证 ${coverage.verifiedCount} 个文件` : "本轮已完成校验" };
    if (fullBackupActive && (!fullBackup?.ranges?.length || (activeRange && rangesOverlap(activeRange, bucketRange)))) return { key: "backupRunning", label: "备份中", detail: "正在处理" };
    if (coverage && coverage.verifiedCount >= bucket.itemCount) return { key: "backupComplete", label: "已备份", detail: `本地已验证 ${coverage.verifiedCount} 个文件` };
    if (coverage?.verifiedCount) return { key: "backupPartial", label: "部分备份", detail: `本地已验证 ${coverage.verifiedCount} 个文件` };
    return { key: "backupMissing", label: "未备份", detail: "没有已验证的本地文件" };
  };
  return <main className={styles.page}>
    <header className={styles.topbar}>
      <Link href="/"><span>F</span>Framebase</Link>
      <div><a className={styles.backLink} href="/">← 返回视频库</a><a className={styles.backLink} href="/photos">返回图片库</a><b>{username} · iCloud 备份中心</b><button onClick={() => void signOut()}>退出</button><ThemeSelector /></div>
    </header>

    <section className={styles.hero}>
      <p>独立备份中心</p>
      <h1>把 iCloud 原片安全保存到这台电脑</h1>
      <span>每个 FrameBase 用户拥有独立的目录、认证会话、任务和清单。FrameBase 通过可替换 Provider 调用 icloudpd，不保存 Apple 密码。</span>
    </section>

    {error && <div className={styles.error} role="alert">{error}<button onClick={() => setError("")}>×</button></div>}
    {message && <div className={styles.notice} role="status">{message}<button onClick={() => setMessage("")}>×</button></div>}

    <section className={styles.content}>
      <article className={styles.card}>
        <div className={styles.cardHead}><span>1</span><div><h2>选择备份位置</h2><p>选择一个上级文件夹，FrameBase 会自动创建 <code>FrameBase-iCloud\{username}</code>。</p></div></div>
        <div className={styles.currentPath}><small>当前用户的备份目录</small><strong>{config?.backupDirectory || "尚未设置"}</strong></div>
        <div className={styles.actions}><button className={styles.primary} onClick={() => void chooseFolder()} disabled={busy !== null}>{busy === "folder" ? "请稍候…" : "选择文件夹"}</button></div>
        <form className={styles.manual} onSubmit={saveManualPath}><label>也可以输入上级文件夹的绝对路径<input value={manualPath} onChange={event => setManualPath(event.target.value)} placeholder="例如 D:\\照片备份" disabled={busy !== null} /></label><button disabled={busy !== null || !manualPath.trim()}>{busy === "path" ? "保存中…" : "保存路径"}</button></form>
      </article>

      <article className={`${styles.card} ${!readyForConnection ? styles.disabled : ""}`}>
        <div className={styles.cardHead}><span>2</span><div><h2>配置 iCloud 连接</h2><p>账户和区域按 FrameBase 用户隔离。此阶段只验证现有会话，不下载或删除照片。</p></div></div>
        <div className={styles.provider}><div><small>连接适配器</small><strong>icloudpd</strong></div><span className={config?.providerInfo?.available ? styles.available : styles.missing}>{config?.providerInfo?.available ? config.providerInfo.version || "可用" : "未找到工具"}</span></div>
        <form className={styles.connectionForm} onSubmit={saveConnection}>
          <label>Apple ID<input type="email" value={appleAccount} onChange={event => setAppleAccount(event.target.value)} placeholder="name@example.com" autoComplete="username" disabled={busy !== null || !readyForConnection} /></label>
          <label>iCloud 服务区域<select value={icloudDomain} onChange={event => setIcloudDomain(event.target.value as "cn" | "com")} disabled={busy !== null || !readyForConnection}><option value="cn">中国大陆（icloud.com.cn）</option><option value="com">全球（icloud.com）</option></select></label>
          <button className={styles.primary} disabled={busy !== null || !readyForConnection || !appleAccount.trim()}>{busy === "connection" ? "保存中…" : "保存连接配置"}</button>
        </form>
        <div className={styles.status}><i className={config?.connectionStatus === "connected" ? styles.statusOk : ""} /><strong>{config?.connectionStatus === "connected" ? "已连接" : config?.connectionStatus === "expired" ? "需要登录" : "尚未验证"}</strong><small>{config?.lastConnectionMessage || (readyForConnection ? "本地目录已经就绪" : "请先设置备份目录")}</small></div>
        <div className={styles.actions}><button onClick={() => void verifyConnection()} disabled={busy !== null || !connectionConfigured || !config?.providerInfo?.available}>{busy === "verify" ? "正在检查…" : "验证已有会话"}</button>{config?.connectionStatus !== "connected" && <button className={styles.primary} onClick={() => void startAuthentication()} disabled={busy !== null || !connectionConfigured || !config?.providerInfo?.available || Boolean(auth && activeAuthStates.has(auth.status))}>{busy === "auth" ? "正在启动…" : "开始 Apple 登录"}</button>}</div>
        {auth && auth.status !== "idle" && <div className={styles.authBox}>
          <div><strong>{auth.status === "connected" ? "登录成功" : auth.status === "failed" ? "登录失败" : "Apple 登录"}</strong><span>{auth.message}</span></div>
          {auth.status === "waiting_password" && <form onSubmit={event => void submitAuthInput(event, "password")}><input type="password" value={password} onChange={event => setPassword(event.target.value)} autoComplete="current-password" placeholder="Apple ID 密码" aria-label="Apple ID 密码" /><button className={styles.primary} disabled={!password}>提交密码</button></form>}
          {auth.status === "waiting_mfa" && <form onSubmit={event => void submitAuthInput(event, "mfa")}><input inputMode="numeric" pattern="[0-9]{6}" maxLength={6} value={mfaCode} onChange={event => setMfaCode(event.target.value.replace(/\D/g, "").slice(0, 6))} autoComplete="one-time-code" placeholder="六位验证码" aria-label="Apple 六位验证码" /><button className={styles.primary} disabled={mfaCode.length !== 6}>提交验证码</button></form>}
          {activeAuthStates.has(auth.status) && <button className={styles.cancel} onClick={() => void cancelAuthentication()}>取消登录</button>}
        </div>}
      </article>

      <article className={`${styles.card} ${config?.connectionStatus !== "connected" ? styles.disabled : ""}`}>
        <div className={styles.cardHead}><span>3</span><div><h2>扫描、备份与验证</h2><p>连接后先只读统计，再由当前用户选择测试备份或完整增量备份。</p></div></div>
        <div className={styles.capabilities}><div><strong>iCloud 照片与视频</strong><span>支持只读扫描和安全备份</span></div><div><strong>FrameBase 媒体库</strong><span>视频库与独立图片库按格式隔离管理</span></div></div>
        <p className={styles.libraryHint}>同一备份目录可以分别加入 <Link href="/photos">独立图片库</Link> 和 <Link href="/">视频库</Link>；图片与视频索引会按格式自动分流。</p>
        <ul><li>测试备份硬性限制为最近 3 个项目</li><li>保存原始尺寸，完成后验证本地文件存在且非空</li><li>不会传入云端删除、移动或自动清理参数</li></ul>
        <div className={styles.actions}><button onClick={() => void scanRecent()} disabled={busy !== null || config?.connectionStatus !== "connected"}>{busy === "scan" ? "正在只读扫描…" : "扫描最近 10 个项目"}</button><button className={styles.primary} onClick={() => void backupRecent()} disabled={busy !== null || config?.connectionStatus !== "connected" || !config?.scan?.sampleCount || Boolean(config?.backup?.completedAt)}>{busy === "backup" ? "正在安全备份与验证…" : config?.backup?.completedAt ? "测试备份已完成" : "安全备份最近 3 个"}</button></div>
        {config?.scan?.scannedAt && <div className={styles.scanResult}>
          <div><strong>最近一次只读扫描</strong><span>{config.scan.sampleCount} 个媒体项目 · {new Date(config.scan.scannedAt).toLocaleString("zh-CN")}</span></div>
          {config.scan.samples.length > 0 && <ul>{config.scan.samples.map((item, index) => <li key={`${item.name}-${index}`}><span>{item.mediaType === "video" ? "视频" : "照片"}</span><strong>{item.name}</strong></li>)}</ul>}
        </div>}
        {config?.backup?.completedAt && <div className={styles.scanResult}>
          <div><strong>已验证的安全备份清单</strong><span>{config.backup.fileCount} 个项目 · {new Date(config.backup.completedAt).toLocaleString("zh-CN")}</span></div>
          {config.backup.files.length > 0 && <ul>{config.backup.files.map((item, index) => <li key={`${item.relativePath}-${index}`}><span>{item.mediaType === "video" ? "视频" : "照片"}</span><strong title={`${item.relativePath}${item.sha256 ? ` · SHA-256 ${item.sha256}` : ""}`}>{item.name} · {formatBytes(item.size)} · {item.sha256 ? "SHA-256 已记录" : "基础校验"}</strong></li>)}</ul>}
        </div>}
      </article>

      <article className={`${styles.card} ${config?.connectionStatus !== "connected" ? styles.disabled : ""}`}>
        <div className={styles.cardHead}><span>4</span><div><h2>按时间统计与选择</h2><p>只读获取拍摄时间、类型和原始资源大小，可按年、季度或月份选择增量备份范围。</p></div></div>
        <div className={styles.timelineHead}><div><strong>{config?.timeline?.total ? `${config.timeline.total.itemCount} 个云端项目 · ${formatBytes(config.timeline.total.originalBytes)}` : "尚未生成时间统计"}</strong><span>{config?.timeline?.scannedAt ? `更新于 ${new Date(config.timeline.scannedAt).toLocaleString("zh-CN")}` : "扫描不会下载或删除媒体文件"}</span></div><button onClick={() => void scanTimeline()} disabled={busy !== null || config?.connectionStatus !== "connected"}>{busy === "scan" ? "正在读取云端元数据…" : config?.timeline?.scannedAt ? "刷新统计" : "开始只读统计"}</button></div>
        {config?.timeline?.scannedAt && <>
          <div className={styles.timelineTabs}><button className={timelineGranularity === "years" ? styles.active : ""} onClick={() => { setTimelineGranularity("years"); setSelectedPeriods([]); }}>按年份</button><button className={timelineGranularity === "quarters" ? styles.active : ""} onClick={() => { setTimelineGranularity("quarters"); setSelectedPeriods([]); }}>每 3 个月</button><button className={timelineGranularity === "months" ? styles.active : ""} onClick={() => { setTimelineGranularity("months"); setSelectedPeriods([]); }}>按月份</button></div>
          <div className={styles.timelineTable}><div className={styles.timelineRow}><span>选择</span><strong>时间</strong><span>备份状态</span><span>图片</span><span>视频</span><span>Live Photo</span><span>RAW</span><span>原始大小</span></div>{timelineBuckets.map(bucket => { const backupState = backupStateForBucket(bucket); return <label className={styles.timelineRow} key={bucket.key}><input type="checkbox" checked={selectedPeriods.includes(bucket.key)} onChange={() => setSelectedPeriods(current => current.includes(bucket.key) ? current.filter(key => key !== bucket.key) : [...current, bucket.key])} /><strong>{periodRange(bucket.key).label}</strong><span className={`${styles.backupBadge} ${styles[backupState.key]}`} title={backupState.detail}>{backupState.label}</span><span>{bucket.photoCount}</span><span>{bucket.videoCount}</span><span>{bucket.livePhotoCount}</span><span>{bucket.rawCount}</span><span>{formatBytes(bucket.originalBytes)}</span></label>; })}</div>
          <div className={styles.timelineActions}><span>已选择 {selectedPeriods.length} 个时间范围</span><button className={styles.primary} onClick={() => void controlFullBackup("start", selectedPeriods.map(periodRange))} disabled={busy !== null || selectedPeriods.length === 0 || fullBackupActive}>备份所选范围</button></div>
        </>}
      </article>

      <article className={`${styles.card} ${config?.connectionStatus !== "connected" ? styles.disabled : ""}`}>
        <div className={styles.cardHead}><span>5</span><div><h2>完整增量备份</h2><p>备份全部图片、视频、Live Photo 与 RAW 原文件；再次运行只补充变化，并复核本地 SHA-256。</p></div></div>
        <div className={styles.safetyBanner}><strong>安全边界</strong><span>此任务不带任何云端删除参数。暂停或取消只会停止本机任务，已下载文件会保留。</span></div>
        <div className={styles.fullStatus}>
          <div><strong>{config?.fullBackup?.status === "completed" ? "备份完成" : config?.fullBackup?.status === "paused" ? "已暂停" : config?.fullBackup?.status === "cancelled" ? "已取消" : config?.fullBackup?.status === "failed" ? "需要重试" : fullBackupActive ? "任务运行中" : "尚未开始"}</strong><span>{config?.fullBackup?.message || "准备好后由当前用户手动开始。"}</span></div>
          {config?.fullBackup?.rangeCount ? <div className={styles.rangeStatus}><strong>时间范围 {config.fullBackup.rangeIndex || 1}/{config.fullBackup.rangeCount}</strong><span>{config.fullBackup.currentRange || "正在准备"} · 已完成 {config.fullBackup.completedRanges.length} 个范围</span></div> : null}
          {config?.fullBackup && <div className={styles.liveMetrics}><div><span>实时同步速率</span><strong>{config.fullBackup.phase === "downloading" ? `${formatBytes(config.fullBackup.transferRateBps || 0)}/秒` : "—"}</strong></div><div><span>图片进度</span><strong>{syncedPhotoCount} / {plannedPhotoCount || "—"}</strong></div><div><span>视频进度</span><strong>{syncedVideoCount} / {plannedVideoCount || "—"}</strong></div><div><span>总同步进度</span><strong>{config.fullBackup.downloaded} / {config.fullBackup.planned || "—"}</strong></div></div>}
          {config?.fullBackup && <dl><div><dt>计划</dt><dd>{config.fullBackup.planned}</dd></div><div><dt>已验证</dt><dd>{config.fullBackup.verified}</dd></div><div><dt>增量跳过</dt><dd>{config.fullBackup.skipped}</dd></div><div><dt>失败</dt><dd>{config.fullBackup.failed}</dd></div><div><dt>图片</dt><dd>{config.fullBackup.photoCount}</dd></div><div><dt>视频</dt><dd>{config.fullBackup.videoCount}</dd></div></dl>}
          {progressTotal ? <div className={styles.progressLine}><div className={styles.progress} aria-label={`完整备份进度 ${progressPercent}%`}><i style={{ width: `${progressPercent}%` }} /></div><strong>{progressPercent}%</strong></div> : null}
          {config?.fullBackup?.downloadedBytes ? <small>本地已存在或写入：{formatBytes(config.fullBackup.downloadedBytes)}</small> : null}
          {config?.fullBackup?.verifiedBytes ? <small>已通过完整性校验：{formatBytes(config.fullBackup.verifiedBytes)} · 清单共 {config.fullManifest?.fileCount || config.fullBackup.verified} 个文件</small> : null}
        </div>
        <div className={styles.actions}>
          {(!config?.fullBackup || ["idle", "cancelled"].includes(config.fullBackup.status)) && <button className={styles.primary} onClick={() => void controlFullBackup("start")} disabled={busy !== null || config?.connectionStatus !== "connected"}>{busy === "full" ? "正在启动…" : "开始完整备份"}</button>}
          {config?.fullBackup && ["paused", "failed"].includes(config.fullBackup.status) && <button className={styles.primary} onClick={() => void controlFullBackup("resume")} disabled={busy !== null || config?.connectionStatus !== "connected"}>{busy === "full" ? "正在恢复…" : "继续 / 重试"}</button>}
          {config?.fullBackup?.status === "completed" && <button className={styles.primary} onClick={() => void controlFullBackup("resume")} disabled={busy !== null || config?.connectionStatus !== "connected"}>检查新增项目</button>}
          {fullBackupActive && <button onClick={() => void controlFullBackup("pause")} disabled={busy !== null}>暂停</button>}
          {fullBackupActive && <button className={styles.danger} onClick={() => void controlFullBackup("cancel")} disabled={busy !== null}>取消任务</button>}
        </div>
      </article>

      <article className={`${styles.card} ${config?.fullBackup?.status !== "completed" ? styles.disabled : ""}`}>
        <div className={styles.cardHead}><span>6</span><div><h2>iCloud 容量释放</h2><p>先重新复核本地清单，再进入独立确认；任何云端删除都不与备份按钮绑定。</p></div></div>
        <div className={styles.safetyBanner}><strong>当前安全策略</strong><span>icloudpd 不能按 SHA-256 清单精确指定云端对象，因此自动删除保持锁定，避免误删刚上传但尚未备份的新项目。</span></div>
        {config?.releasePlan ? <div className={styles.fullStatus}>
          <div><strong>{config.releasePlan.status === "confirmed" ? "本地副本已确认" : config.releasePlan.status === "ready" ? "释放计划待确认" : "释放计划被阻止"}</strong><span>{config.releasePlan.message}</span></div>
          <dl><div><dt>可释放项目</dt><dd>{config.releasePlan.eligibleCount}</dd></div><div><dt>本地已验证</dt><dd>{formatBytes(config.releasePlan.eligibleBytes)}</dd></div><div><dt>校验失败</dt><dd>{config.releasePlan.failedCount}</dd></div></dl>
          {config.releasePlan.files.length > 0 && <ul className={styles.releaseFiles}>{config.releasePlan.files.slice(0, 5).map(item => <li key={item.relativePath}><span>{item.mediaType === "video" ? "视频" : "图片"}</span><strong>{item.name}</strong><small>{formatBytes(item.size)}</small></li>)}</ul>}
        </div> : <p className={styles.releaseIntro}>完整备份完成后，可生成只读释放计划。生成计划会再次校验全部文件，不会访问删除接口。</p>}
        <div className={styles.actions}><button onClick={() => void createReleasePlan()} disabled={busy !== null || config?.fullBackup?.status !== "completed"}>{busy === "release" ? "正在复核本地文件…" : config?.releasePlan ? "重新生成释放计划" : "生成只读释放计划"}</button></div>
        {config?.releasePlan?.status === "ready" && <form className={styles.confirmRelease} onSubmit={confirmReleasePlan}><label>输入“确认本地备份完整”以完成本地确认<input value={releaseConfirmation} onChange={event => setReleaseConfirmation(event.target.value)} /></label><button className={styles.primary} disabled={busy !== null || releaseConfirmation !== "确认本地备份完整"}>确认本地副本</button></form>}
        {config?.releasePlan?.status === "confirmed" && <div className={styles.manualRelease}><strong>下一步仍需人工操作</strong><span>请在 iCloud 照片中核对并删除对应项目，再到“最近删除”中决定是否彻底清空。自动删除将在支持精确对象匹配后再开放。</span><a href={config.icloudDomain === "cn" ? "https://www.icloud.com.cn/photos/" : "https://www.icloud.com/photos/"} target="_blank" rel="noreferrer">打开 iCloud 照片</a></div>}
      </article>
    </section>

    <footer><span>配置只保存在这台电脑，并按 FrameBase 用户隔离</span><a href="/">返回视频库 →</a></footer>
  </main>;
}
