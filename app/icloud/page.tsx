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
};

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
  const [busy, setBusy] = useState<"folder" | "path" | "connection" | "verify" | "auth" | "scan" | "backup" | null>(null);
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

  function formatBytes(bytes: number) {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / 1024 ** 2).toFixed(1)} MB`;
  }

  const readyForConnection = Boolean(config?.backupDirectory);
  const connectionConfigured = Boolean(config?.appleAccount);
  return <main className={styles.page}>
    <div className="route-theme"><ThemeSelector /></div>
    <header className={styles.topbar}>
      <Link href="/"><span>F</span>Framebase</Link>
      <div><button className={styles.backLink} onClick={() => window.location.assign("/")}>← 返回视频库</button><b>{username} · iCloud 备份中心</b><button onClick={() => void signOut()}>退出</button></div>
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
        <div className={styles.capabilities}><div><strong>iCloud 照片与视频</strong><span>支持只读扫描和安全备份</span></div><div><strong>FrameBase 主媒体库</strong><span>当前仅管理视频；图片浏览与整理尚未开放</span></div></div>
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
    </section>

    <footer><span>配置只保存在这台电脑，并按 FrameBase 用户隔离</span><Link href="/">返回视频库 →</Link></footer>
  </main>;
}
