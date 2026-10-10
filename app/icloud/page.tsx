"use client";

/* eslint-disable @next/next/no-html-link-for-pages -- hard navigation is required by the Vinext compatibility router. */

import { useEffect, useRef, useState } from "react";
import AccountGate, { signOut } from "../account-gate";
import ThemeSelector from "../theme-selector";
import ConfirmationDialog, { type ConfirmationRequest } from "../confirmation-dialog";
import { RecentDebugLogs, DebugLogLink, type DebugLog } from "../icloud-debug-log";
import styles from "./icloud.module.css";
import { createBackupNotifier } from "./backup-notifier";

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
  backupHistory?: { updatedAt: string | null; completedRanges: BackupRange[] };
  fullBackup?: FullBackupState;
  fullManifest?: { updatedAt: string | null; fileCount: number; coverage: { years: CoverageBucket[]; quarters: CoverageBucket[]; months: CoverageBucket[] } };
  releasePlan?: ReleasePlan | null;
  releaseProgress?: ReleaseProgress;
  releaseHistory?: { movedCount: number; movedBytes: number; recycledFileCount: number; recycledBytes: number; lastReleasedAt: string | null; events: Array<{ id: string; recycleStatus: string; recycleResults: Array<{ relativePath: string; status: string }> }> };
};

type ReleaseProgress = { status: "idle" | "running" | "completed" | "failed"; phase?: string; message?: string; total?: number; checked?: number; failed?: number; reused?: number; rehashed?: number; totalBytes?: number; readBytes?: number; currentFile?: string | null };

type ReleasePlan = { matchedAssetCount: number; matchedLocalFileCount: number; unmatchedLocalFileCount: number; livePhotoAssetCount: number; unmatchedFiles: Array<{ name: string; relativePath: string; size: number }>; id: string | null; status: "ready" | "blocked" | "confirmed"; message: string; createdAt: string | null; confirmedAt: string | null; eligibleCount: number; eligibleBytes: number; failedCount: number; files: Array<{ name: string; relativePath: string; mediaType: "photo" | "video"; size: number }>; assets: Array<{ id: string; library: string; name: string; originalBytes: number }> };

type FullBackupState = {
  status: "idle" | "planning" | "downloading" | "verifying" | "paused" | "cancelled" | "completed" | "failed";
  message: string; startedAt: string | null; updatedAt: string | null; completedAt: string | null; phase: string; currentLibrary: string | null;
  currentRange: string | null; rangeIndex: number; rangeCount: number; completedRanges: string[];
  planned: number; downloaded: number; plannedPhotoCount: number; plannedVideoCount: number; syncedPhotoCount: number; syncedVideoCount: number; downloadedBytes: number; transferRateBps: number;
  verified: number; skipped: number; failed: number; photoCount: number; videoCount: number; verifiedBytes: number; manifestFileCount: number;
  ranges: BackupRange[];
};
type TimelineBucket = { key: string; itemCount: number; photoCount: number; videoCount: number; livePhotoCount: number; rawCount: number; originalBytes: number };
type DisplayTimelineBucket = TimelineBucket & { localOnly?: boolean };
type CoverageBucket = { key: string; verifiedCount: number; verifiedBytes: number; photoCount: number; videoCount: number };
type TimelineState = { scannedAt: string | null; staleAt: string | null; staleReason: string | null; assetCount: number; total: TimelineBucket | null; years: TimelineBucket[]; quarters: TimelineBucket[]; months: TimelineBucket[] };
type BackupRange = { key: string; label: string; start: string; end: string };
type TimelineGranularity = "years" | "quarters" | "months";
type TimelineJob = { status: "idle" | "running" | "completed" | "failed"; phase: string; message: string; library: string | null; libraryIndex: number; libraryCount: number; itemCount: number; elapsedSeconds: number; timeline?: TimelineState; debugLog?: DebugLog };

type AuthState = { status: "idle" | "starting" | "waiting_password" | "verifying" | "waiting_mfa" | "connected" | "failed" | "cancelled" | "tool_missing"; message: string; startedAt?: string };
type RuntimeVersion = { app: "FrameBase"; version: string; commit: string; startedAt: string; pid: number; node: string };
const activeAuthStates = new Set<AuthState["status"]>(["starting", "waiting_password", "verifying", "waiting_mfa"]);

function mergeConfig(current: IcloudConfig | null, update: IcloudConfig) {
  return current ? { ...current, ...update } : update;
}

async function fetchIcloudConfig() {
  const response = await fetch("/api/icloud/config", { cache: "no-store" });
  const data = await response.json() as IcloudConfig & { error?: string };
  if (!response.ok) throw new Error(data.error || "无法读取 iCloud 备份配置");
  return data;
}

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
  const [releaseProgress, setReleaseProgress] = useState<ReleaseProgress | null>(null);
  const [releaseAcknowledged, setReleaseAcknowledged] = useState(false);
  const [timelineGranularity, setTimelineGranularity] = useState<TimelineGranularity>("years");
  const [timelineJob, setTimelineJob] = useState<TimelineJob | null>(null);
  const [selectedPeriods, setSelectedPeriods] = useState<string[]>([]);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const [runtimeVersion, setRuntimeVersion] = useState<RuntimeVersion | null>(null);
  const [runtimeVersionUnavailable, setRuntimeVersionUnavailable] = useState(false);
  const [confirmation, setConfirmation] = useState<ConfirmationRequest | null>(null);
  const confirmationResolver = useRef<((value: string | null) => void) | null>(null);
  const backupNotifier = useRef<ReturnType<typeof createBackupNotifier> | null>(null);
  const [backupCompletion, setBackupCompletion] = useState<ConfirmationRequest | null>(null);
  const [desktopReminder, setDesktopReminder] = useState(false);
  useEffect(() => () => { confirmationResolver.current?.(null); }, []);
  useEffect(() => {
    backupNotifier.current = createBackupNotifier();
    queueMicrotask(() => setDesktopReminder(typeof Notification !== "undefined" && Notification.permission === "granted"));
    return () => { backupNotifier.current?.dispose(); backupNotifier.current = null; };
  }, []);
  useEffect(() => {
    if (!backupCompletion) return;
    const originalTitle = document.title;
    document.title = `${backupCompletion.title} · FrameBase`;
    return () => { document.title = originalTitle; };
  }, [backupCompletion]);

  async function enableBackupReminders() {
    void backupNotifier.current?.prepareSound();
    const permission = await backupNotifier.current?.enableDesktop();
    setDesktopReminder(permission === "granted");
    setMessage(permission === "granted" ? "桌面提醒已启用。保持此备份页签打开，切换到其他页签时也会提醒。" : permission === "denied" ? "浏览器已禁止桌面通知，请在网站权限中允许；页面完成弹窗仍会显示。" : "当前浏览器不支持桌面通知；页面完成弹窗仍会显示。");
  }

  function requestConfirmation(request: ConfirmationRequest) {
    if (confirmationResolver.current) return Promise.resolve(null);
    return new Promise<string | null>(resolve => { confirmationResolver.current = resolve; setConfirmation(request); });
  }

  function resolveConfirmation(value: string | null) {
    const resolve = confirmationResolver.current;
    confirmationResolver.current = null;
    setConfirmation(null);
    resolve?.(value);
  }

  useEffect(() => {
    let cancelled = false;
    void fetchIcloudConfig()
      .then(data => {
        if (cancelled) return;
        setConfig(data);
        if (data.releaseProgress) setReleaseProgress(data.releaseProgress);
        setManualPath(data.selectedDirectory || "");
        setAppleAccount(data.appleAccount || "");
        setIcloudDomain(data.icloudDomain || "cn");
      })
      .catch(reason => { if (!cancelled) setError(reason instanceof Error ? reason.message : "无法读取配置"); });
    return () => { cancelled = true; };
  }, []);

  useEffect(() => {
    void fetch("/api/icloud/timeline/status", { cache: "no-store" }).then(response => response.json() as Promise<{ timelineJob: TimelineJob }>).then(data => {
      setTimelineJob(data.timelineJob);
      if (data.timelineJob.status === "running") setBusy("scan");
      else if (data.timelineJob.status === "failed") setError(`重新统计未完成，上次统计及云端变化提示已保留。${data.timelineJob.message}`);
    }).catch(() => undefined);
  }, []);

  useEffect(() => {
    if (timelineJob?.status !== "running") return;
    const poll = () => void fetch("/api/icloud/timeline/status", { cache: "no-store" }).then(response => response.json() as Promise<{ timelineJob: TimelineJob }>).then(async data => {
      setTimelineJob(data.timelineJob);
      if (data.timelineJob.status === "completed") {
        try { setConfig(await fetchIcloudConfig()); }
        catch { if (data.timelineJob.timeline) setConfig(current => current ? { ...current, timeline: data.timelineJob.timeline } : current); }
        setSelectedPeriods([]); setMessage(data.timelineJob.message); setBusy(null);
      } else if (data.timelineJob.status === "failed") {
        setError(`重新统计未完成，上次统计及云端变化提示已保留。${data.timelineJob.message}`); setBusy(null);
      }
    }).catch(() => undefined);
    const timer = setInterval(poll, 1000);
    return () => clearInterval(timer);
  }, [timelineJob?.status]);

  useEffect(() => {
    let cancelled = false;
    void fetch("/api/runtime/version", { cache: "no-store" }).then(async response => {
      if (!response.ok) throw new Error("runtime-version-unavailable");
      return response.json() as Promise<RuntimeVersion>;
    }).then(data => { if (!cancelled) setRuntimeVersion(data); }).catch(() => { if (!cancelled) setRuntimeVersionUnavailable(true); });
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
    let cancelled = false;
    let polling = false;
    let notified = false;
    const poll = async () => {
      if (polling || notified) return;
      polling = true;
      try {
        const response = await fetch("/api/icloud/config", { cache: "no-store" });
        if (!response.ok) return;
        const data = await response.json() as IcloudConfig;
        if (cancelled) return;
        setConfig(data);
        if (data.fullBackup && ["completed", "failed"].includes(data.fullBackup.status)) {
          notified = true;
          const failed = data.fullBackup.status === "failed";
          const title = failed ? "完整增量备份未完成" : "完整增量备份完成";
          const message = data.fullBackup.message;
          setBackupCompletion({ title, message, choices: [{ label: "知道了", value: "dismiss" }] });
          backupNotifier.current?.notify(title, message, failed);
        }
      } catch { /* Keep reading background status after a temporary connection error. */ }
      finally { polling = false; }
    };
    const onVisible = () => { if (document.visibilityState === "visible") void poll(); };
    const timer = setInterval(() => void poll(), 1000);
    document.addEventListener("visibilitychange", onVisible);
    return () => { cancelled = true; clearInterval(timer); document.removeEventListener("visibilitychange", onVisible); };
  }, [fullBackupActive]);

  const releaseStatus = releaseProgress?.status;
  useEffect(() => {
    let cancelled = false;
    let polling = false;
    let wasRunning = false;
    const poll = async () => {
      if (polling) return;
      polling = true;
      try {
        const response = await fetch("/api/icloud/release/status", { cache: "no-store" });
        const data = await response.json() as { releaseProgress: ReleaseProgress; releasePlan?: ReleasePlan | null; error?: string };
        if (!response.ok) throw new Error(data.error || "无法读取复核进度");
        if (cancelled) return;
        setReleaseProgress(data.releaseProgress);
        if (data.releaseProgress.status === "running") { wasRunning = true; setBusy("release"); }
        else {
          if (wasRunning) { setBusy(current => current === "release" ? null : current); wasRunning = false; }
          if (data.releasePlan) setConfig(current => current ? { ...current, releasePlan: data.releasePlan } : current);
          if (data.releaseProgress.status === "failed") setError(data.releaseProgress.message || "复核失败");
        }
      } catch (reason) {
        if (!cancelled) setError(reason instanceof Error ? reason.message : "无法读取复核进度");
      } finally { polling = false; }
    };
    void poll();
    const timer = setInterval(() => void poll(), 1000);
    return () => { cancelled = true; clearInterval(timer); };
  }, []);

  async function chooseFolder() {
    setBusy("folder"); setError(""); setMessage("");
    try {
      const response = await fetch("/api/icloud/pick-folder", { method: "POST" });
      const data = await response.json() as IcloudConfig & { cancelled?: boolean; error?: string };
      if (!response.ok) throw new Error(data.error || "无法选择备份文件夹");
      if (data.cancelled) return;
      setConfig(current => mergeConfig(current, data)); setManualPath(data.selectedDirectory || "");
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
      setConfig(current => mergeConfig(current, data)); setManualPath(data.selectedDirectory || "");
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
      setConfig(current => mergeConfig(current, data)); setAppleAccount(data.appleAccount || ""); setIcloudDomain(data.icloudDomain);
      setMessage("Apple 账户配置已保存；密码不会保存在 FrameBase 配置中。");
    } catch (reason) { setError(reason instanceof Error ? reason.message : "无法保存 Apple 连接配置"); }
    finally { setBusy(null); }
  }

  const [verificationLog, setVerificationLog] = useState<DebugLog>();
  async function verifyConnection() {
    setBusy("verify"); setError(""); setMessage("");
    try {
      const response = await fetch("/api/icloud/verify", { method: "POST" });
      const data = await response.json() as IcloudConfig & { debugLog?: DebugLog; verification?: { status: string; message: string }; error?: string };
      setVerificationLog(data.debugLog);
      if (!response.ok) throw new Error(data.error || "无法验证 iCloud 会话");
      setConfig(current => mergeConfig(current, data));
      if (data.verification?.status === "connected") setMessage(data.verification.message);
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
      setConfig(current => mergeConfig(current, data));
      if (data.scanResult?.status === "ready") setMessage(data.scanResult.message);
      else setError(data.scanResult?.message || "iCloud 只读扫描失败，请重新验证连接。");
    } catch (reason) { setError(reason instanceof Error ? reason.message : "无法扫描 iCloud 媒体"); }
    finally { setBusy(null); }
  }

  async function backupRecent() {
    if (await requestConfirmation({ title: "确认测试备份", message: "将最近 3 个 iCloud 媒体项目复制到当前用户的备份目录。此操作不会删除或移动 iCloud 原文件，是否继续？", choices: [{ label: "开始测试备份", value: "confirm" }] }) !== "confirm") return;
    setBusy("backup"); setError(""); setMessage("");
    try {
      const response = await fetch("/api/icloud/backup/test", { method: "POST" });
      const data = await response.json() as IcloudConfig & { backupResult?: { status: string; message: string }; error?: string };
      if (!response.ok) throw new Error(data.error || "无法完成测试备份");
      setConfig(current => mergeConfig(current, data));
      if (data.backupResult?.status === "completed") setMessage(data.backupResult.message);
      else setError(data.backupResult?.message || "测试备份未完成，请检查连接和本地目录。");
    } catch (reason) { setError(reason instanceof Error ? reason.message : "无法完成测试备份"); }
    finally { setBusy(null); }
  }

  async function controlFullBackup(action: "start" | "resume" | "pause" | "cancel", ranges: BackupRange[] = []) {
    if (action === "start" || action === "resume") { void backupNotifier.current?.prepareSound(); setBackupCompletion(null); }
    if (action === "start" && await requestConfirmation({ title: "确认开始增量备份", message: ranges.length ? `将增量备份所选的 ${ranges.length} 个时间范围，包含图片、视频、Live Photo 和 RAW 原件。不会删除或移动云端内容，是否开始？` : "将开始备份当前用户 iCloud 中的全部图片和视频原文件。任务不会删除或移动任何云端内容；可以暂停并稍后继续。是否开始？", choices: [{ label: "开始备份", value: "confirm" }] }) !== "confirm") return;
    if (action === "cancel" && await requestConfirmation({ title: "确认取消备份任务", message: "取消任务会停止当前下载，但保留已下载文件和已验证清单。是否取消？", choices: [{ label: "确认取消任务", value: "confirm", danger: true }] }) !== "confirm") return;
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
      const data = await response.json() as { timelineJob?: TimelineJob; error?: string };
      if (!response.ok) throw new Error(data.error || "无法读取 iCloud 时间统计");
      if (!data.timelineJob) throw new Error("时间统计任务未能启动");
      setTimelineJob(data.timelineJob);
      if (data.timelineJob.status === "completed") {
        try { setConfig(await fetchIcloudConfig()); }
        catch { if (data.timelineJob.timeline) setConfig(current => current ? { ...current, timeline: data.timelineJob.timeline } : current); }
        setSelectedPeriods([]); setMessage(data.timelineJob.message); setBusy(null);
      } else if (data.timelineJob.status === "failed") {
        setError(`重新统计未完成，上次统计及云端变化提示已保留。${data.timelineJob.message}`); setBusy(null);
      }
    } catch (reason) { setError(reason instanceof Error ? reason.message : "无法读取 iCloud 时间统计"); setBusy(null); }
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
    setBusy("release"); setError(""); setMessage("");
    try {
      const response = await fetch("/api/icloud/release/plan", { method: "POST" });
      const data = await response.json() as { releaseProgress?: ReleaseProgress; error?: string };
      if (!response.ok || !data.releaseProgress) throw new Error(data.error || "无法生成释放计划");
      setReleaseProgress(data.releaseProgress);
      setReleaseAcknowledged(false);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "无法生成释放计划");
      setBusy(null);
    }
  }

  async function confirmReleasePlan(event: React.FormEvent) {
    event.preventDefault();
    if (!config?.releasePlan?.id) return;
    setBusy("release"); setError(""); setMessage("");
    try {
      const response = await fetch("/api/icloud/release/confirm", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ planId: config.releasePlan.id, confirmation: releaseAcknowledged }) });
      const data = await response.json() as { releasePlan?: ReleasePlan; error?: string };
      if (!response.ok || !data.releasePlan) throw new Error(data.error || "无法确认释放计划");
      setConfig(current => current ? { ...current, releasePlan: data.releasePlan } : current); setReleaseAcknowledged(false);
      setMessage(data.releasePlan.message);
    } catch (reason) { setError(reason instanceof Error ? reason.message : "无法确认释放计划"); }
    finally { setBusy(null); }
  }

  async function retryLocalRecycle(eventId: string) {
    setBusy("release"); setError(""); setMessage("");
    try {
      const response = await fetch("/api/icloud/release/recycle/retry", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ eventId }) });
      const data = await response.json() as { recycleResult?: { status: string; message: string }; releaseHistory?: IcloudConfig["releaseHistory"]; error?: string };
      if (!response.ok && !data.recycleResult) throw new Error(data.error || "本地回收重试失败");
      if (data.releaseHistory) setConfig(current => current ? { ...current, releaseHistory: data.releaseHistory } : current);
      if (data.recycleResult?.status === "recycled") setMessage(data.recycleResult.message); else setError(data.recycleResult?.message || data.error || "仍有本地文件未能移入回收站。");
    } catch (reason) { setError(reason instanceof Error ? reason.message : "本地回收重试失败"); }
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
  const rangesOverlap = (left: BackupRange, right: BackupRange) => left.start <= right.end && right.start <= left.end;
  const rangeContains = (outer: BackupRange, inner: BackupRange) => outer.start <= inner.start && outer.end >= inner.end;
  const fullBackup = config?.fullBackup;
  const coverageByKey = new Map((config?.fullManifest?.coverage?.[timelineGranularity] || []).map(bucket => [bucket.key, bucket]));
  const currentCompletedDefinitions = (fullBackup?.ranges || []).filter(range => fullBackup?.completedRanges.includes(range.key));
  const completedDefinitions = [...(config?.backupHistory?.completedRanges || []), ...currentCompletedDefinitions];
  const cloudBuckets = config?.timeline?.[timelineGranularity] || [];
  const cloudBucketsByKey = new Map(cloudBuckets.map(bucket => [bucket.key, bucket]));
  const visiblePeriodKeys = new Set([...cloudBucketsByKey.keys(), ...coverageByKey.keys()]);
  const addRangePeriods = (range: BackupRange, include: (outer: BackupRange, period: BackupRange) => boolean) => {
    const firstYear = Number(range.start.slice(0, 4));
    const lastYear = Number(range.end.slice(0, 4));
    if (!Number.isInteger(firstYear) || !Number.isInteger(lastYear) || firstYear < 1900 || lastYear > 2200) return;
    for (let year = firstYear; year <= lastYear; year += 1) {
      const keys = timelineGranularity === "years"
        ? [`${year}`]
        : timelineGranularity === "quarters"
          ? [1, 2, 3, 4].map(quarter => `${year}-Q${quarter}`)
          : Array.from({ length: 12 }, (_, month) => `${year}-${String(month + 1).padStart(2, "0")}`);
      for (const key of keys) {
        const period = periodRange(key);
        if (include(range, period)) visiblePeriodKeys.add(key);
      }
    }
  };
  for (const range of completedDefinitions) addRangePeriods(range, rangeContains);
  for (const range of fullBackup?.ranges || []) addRangePeriods(range, rangesOverlap);
  const timelineBuckets: DisplayTimelineBucket[] = [...visiblePeriodKeys].sort((left, right) => right.localeCompare(left)).map(key => {
    const cloudBucket = cloudBucketsByKey.get(key);
    if (cloudBucket) return cloudBucket;
    const coverage = coverageByKey.get(key);
    return {
      key,
      itemCount: coverage?.verifiedCount || 0,
      photoCount: coverage?.photoCount || 0,
      videoCount: coverage?.videoCount || 0,
      livePhotoCount: 0,
      rawCount: 0,
      originalBytes: coverage?.verifiedBytes || 0,
      localOnly: true,
    };
  });
  const syncedPhotoCount = fullBackup?.syncedPhotoCount || fullBackup?.photoCount || 0;
  const syncedVideoCount = fullBackup?.syncedVideoCount || fullBackup?.videoCount || 0;
  const plannedPhotoCount = Math.max(syncedPhotoCount, fullBackup?.plannedPhotoCount || 0);
  const plannedVideoCount = Math.max(syncedVideoCount, fullBackup?.plannedVideoCount || 0);
  const progressDone = fullBackup?.phase === "verifying" || fullBackup?.status === "completed" ? fullBackup.verified : fullBackup?.downloaded || 0;
  const progressTotal = Math.max(progressDone, fullBackup?.planned || plannedPhotoCount + plannedVideoCount);
  const progressPercent = progressTotal ? Math.min(100, Math.round(progressDone / progressTotal * 100)) : 0;
  const backupPhaseLabel = ({ planning: "读取云端清单", downloading: "下载及云端收尾", scanning_local: "扫描本地文件", verifying: "完整性校验", recording: "保存备份记录", retrying: "等待自动重试" } as Record<string, string>)[fullBackup?.phase || ""] || "准备备份";
  const stageIndeterminate = Boolean(fullBackupActive && ["planning", "scanning_local", "recording", "retrying"].includes(fullBackup?.phase || ""));
  const progressLabel = fullBackup?.phase === "verifying" ? "校验进度" : fullBackup?.status === "completed" ? "备份完成" : "已规划文件的本地进度";
  const verifiedManifestCount = config?.fullManifest?.fileCount || 0;
  const hasPreciseCloudCatalog = Boolean(config?.timeline?.assetCount);
  const backupStateForBucket = (bucket: TimelineBucket) => {
    const bucketRange = periodRange(bucket.key);
    const activeRange = fullBackup?.ranges?.length ? fullBackup.ranges[Math.max(0, (fullBackup.rangeIndex || 1) - 1)] : null;
    const coverage = coverageByKey.get(bucket.key);
    if (completedDefinitions.some(range => rangeContains(range, bucketRange))) return { key: "backupComplete", label: "已备份", detail: coverage ? `本地已验证 ${coverage.verifiedCount} 个文件` : "本轮已完成校验" };
    if (fullBackupActive && (!fullBackup?.ranges?.length || (activeRange && rangesOverlap(activeRange, bucketRange)))) return { key: "backupRunning", label: "备份中", detail: "正在处理" };
    if (coverage && coverage.verifiedCount >= bucket.itemCount) return { key: "backupComplete", label: "已备份", detail: `本地已验证 ${coverage.verifiedCount} 个文件` };
    if (coverage?.verifiedCount) return { key: "backupPartial", label: "部分备份", detail: `本地已验证 ${coverage.verifiedCount} 个文件` };
    return { key: "backupMissing", label: "未备份", detail: "没有已验证的本地文件" };
  };
  return <main className={styles.page}>
    <header className={styles.topbar}>
      <a href="/?library=video"><span>F</span>Framebase</a>
      <div className="media-header-actions"><a className={`${styles.backLink} media-header-button`} href="/?library=video">← 返回视频库</a><a className={`${styles.backLink} media-header-button`} href="/photos">返回图片库</a><b className="media-account">{username} · iCloud 备份中心</b><button className="media-logout" onClick={() => void signOut()}>退出</button><ThemeSelector /></div>
    </header>

    <section className={styles.hero}>
      <p>独立备份中心</p>
      <h1>把 iCloud 原片安全保存到这台电脑</h1>
      <span>每个 FrameBase 用户拥有独立的目录、认证会话、任务和清单。FrameBase 通过可替换 Provider 调用 icloudpd，不保存 Apple 密码。</span>
    </section>

    <aside className={`${styles.runtimeVersion} ${runtimeVersionUnavailable ? styles.runtimeVersionOld : ""}`} aria-live="polite">{runtimeVersion ? <><strong>后端运行版本 <code>{runtimeVersion.commit !== "unknown" ? runtimeVersion.commit : `v${runtimeVersion.version}`}</code></strong><span>启动于 {new Date(runtimeVersion.startedAt).toLocaleString("zh-CN")} · PID {runtimeVersion.pid} · Node {runtimeVersion.node}</span></> : runtimeVersionUnavailable ? <><strong>未检测到运行版本</strong><span>当前后端可能仍是旧进程；新版后端启动后会在这里显示提交号和启动时间。</span></> : <><strong>正在读取后端运行版本…</strong><span>用于确认 iCloud 任务是否由最新进程执行。</span></>}</aside>

    {error && <div className={styles.error} role="alert">{error}<button onClick={() => setError("")}>×</button></div>}
    {message && <div className={styles.notice} role="status">{message}<button onClick={() => setMessage("")}>×</button></div>}

    <section className={styles.content}>
      <details className={`${styles.card} ${styles.diagnostics}`}><summary>运行诊断日志 · 查看地址与下载</summary><RecentDebugLogs /></details>
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
        <DebugLogLink log={verificationLog} />
        <div className={styles.actions}><button onClick={() => void verifyConnection()} disabled={busy !== null || !connectionConfigured || !config?.providerInfo?.available}>{busy === "verify" ? "正在检查…" : "验证已有会话与照片图库"}</button>{config?.connectionStatus !== "connected" && <button className={styles.primary} onClick={() => void startAuthentication()} disabled={busy !== null || !connectionConfigured || !config?.providerInfo?.available || Boolean(auth && activeAuthStates.has(auth.status))}>{busy === "auth" ? "正在启动…" : "开始 Apple 登录"}</button>}</div>
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
        <p className={styles.libraryHint}>同一备份目录可以分别加入 <a href="/photos">独立图片库</a> 和 <a href="/?library=video">视频库</a>；图片与视频索引会按格式自动分流。</p>
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
        {timelineJob?.status === "running" && <div className={styles.timelineScanProgress}><div><strong>{timelineJob.message}</strong><span>{timelineJob.libraryCount ? `图库 ${timelineJob.libraryIndex}/${timelineJob.libraryCount}${timelineJob.library ? ` · ${timelineJob.library}` : ""}` : "正在发现图库"}</span></div><div className={styles.progressLine}><div className={`${styles.progress} ${timelineJob.libraryCount ? "" : styles.progressIndeterminate}`}><i style={timelineJob.libraryCount ? { width: `${Math.max(4, Math.round(timelineJob.libraryIndex / timelineJob.libraryCount * 100))}%` } : undefined} /></div><strong>{timelineJob.libraryCount ? `${Math.round(timelineJob.libraryIndex / timelineJob.libraryCount * 100)}%` : "连接中"}</strong></div><dl><div><dt>已读取项目</dt><dd>{timelineJob.itemCount.toLocaleString()}</dd></div><div><dt>已用时间</dt><dd>{Math.floor(timelineJob.elapsedSeconds / 60)}分 {timelineJob.elapsedSeconds % 60}秒</dd></div><div><dt>当前阶段</dt><dd>{timelineJob.phase === "discovering" ? "发现图库" : timelineJob.phase === "aggregating" ? "生成统计" : "读取元数据"}</dd></div></dl></div>}
        <DebugLogLink log={timelineJob?.debugLog} />
        {config?.timeline?.staleAt && <div className={styles.timelineWarning}><strong>云端内容已发生变化</strong><span>{config.timeline.staleReason || "当前数字已按本地删除结果更新，请重新统计以确认 iCloud 云端状态。"}</span></div>}
        {config?.timeline?.scannedAt && <>
          <div className={styles.timelineTabs}><button className={timelineGranularity === "years" ? styles.active : ""} onClick={() => { setTimelineGranularity("years"); setSelectedPeriods([]); }}>按年份</button><button className={timelineGranularity === "quarters" ? styles.active : ""} onClick={() => { setTimelineGranularity("quarters"); setSelectedPeriods([]); }}>每 3 个月</button><button className={timelineGranularity === "months" ? styles.active : ""} onClick={() => { setTimelineGranularity("months"); setSelectedPeriods([]); }}>按月份</button></div>
          <div className={styles.timelineTable}><div className={styles.timelineRow}><span>选择</span><strong>时间</strong><span>备份状态</span><span>图片</span><span>视频</span><span>Live Photo</span><span>RAW</span><span>原始大小</span></div>{timelineBuckets.map(bucket => { const backupState = backupStateForBucket(bucket); return <label className={`${styles.timelineRow} ${bucket.localOnly ? styles.timelineLocalOnly : ""}`} key={bucket.key}><input type="checkbox" disabled={bucket.localOnly} checked={!bucket.localOnly && selectedPeriods.includes(bucket.key)} onChange={() => setSelectedPeriods(current => current.includes(bucket.key) ? current.filter(key => key !== bucket.key) : [...current, bucket.key])} /><div className={styles.timelinePeriod}><strong>{periodRange(bucket.key).label}</strong>{bucket.localOnly && <small>云端待补扫 · 本地已记录</small>}</div><span className={`${styles.backupBadge} ${styles[backupState.key]}`} title={backupState.detail}>{backupState.label}</span><span>{bucket.photoCount}</span><span>{bucket.videoCount}</span><span>{bucket.livePhotoCount}</span><span>{bucket.rawCount}</span><span>{formatBytes(bucket.originalBytes)}</span></label>; })}</div>
          <div className={styles.timelineActions}><span>已选择 {selectedPeriods.length} 个时间范围</span><button className={styles.primary} onClick={() => void controlFullBackup("start", selectedPeriods.map(periodRange))} disabled={busy !== null || selectedPeriods.length === 0 || fullBackupActive}>备份所选范围</button></div>
        </>}
      </article>

      <article className={`${styles.card} ${config?.connectionStatus !== "connected" ? styles.disabled : ""}`}>
        <div className={styles.cardHead}><span>5</span><div><h2>完整增量备份</h2><p>备份全部图片、视频、Live Photo 与 RAW 原文件；未变文件复用本地校验清单，仅对新增或变化文件重算 SHA-256。</p></div></div>
        <div className={styles.safetyBanner}><strong>安全边界</strong><span>此任务不带任何云端删除参数。暂停或取消只会停止本机任务，已下载文件会保留。</span></div>
        <div className={styles.fullStatus}>
          <div><strong>{config?.fullBackup?.status === "completed" ? "备份完成" : config?.fullBackup?.status === "paused" ? "已暂停" : config?.fullBackup?.status === "cancelled" ? "已取消" : config?.fullBackup?.status === "failed" ? "需要重试" : fullBackupActive ? `正在${backupPhaseLabel}` : "尚未开始"}</strong><span>{config?.fullBackup?.message || "准备好后由当前用户手动开始。"}</span></div>
          {fullBackupActive && <small>每个时间范围依次进行：读取清单 → 下载 → 校验 → 保存记录。文件本地进度达到 100% 后仍需完成校验和保存。</small>}
          {config?.fullBackup?.rangeCount ? <div className={styles.rangeStatus}><strong>时间范围 {config.fullBackup.rangeIndex || 1}/{config.fullBackup.rangeCount}</strong><span>{config.fullBackup.currentRange || "正在准备"} · 已完成 {config.fullBackup.completedRanges.length} 个范围</span></div> : null}
          {config?.fullBackup && <div className={styles.liveMetrics}><div><span>实时同步速率</span><strong>{config.fullBackup.phase === "downloading" ? `${formatBytes(config.fullBackup.transferRateBps || 0)}/秒` : "—"}</strong></div><div><span>图片进度</span><strong>{syncedPhotoCount} / {plannedPhotoCount || "—"}</strong></div><div><span>视频进度</span><strong>{syncedVideoCount} / {plannedVideoCount || "—"}</strong></div><div><span>总同步进度</span><strong>{config.fullBackup.downloaded} / {config.fullBackup.planned || "—"}</strong></div></div>}
          {config?.fullBackup && <dl><div><dt>计划</dt><dd>{config.fullBackup.planned}</dd></div><div><dt>已验证</dt><dd>{config.fullBackup.verified}</dd></div><div><dt>增量跳过</dt><dd>{config.fullBackup.skipped}</dd></div><div><dt>失败</dt><dd>{config.fullBackup.failed}</dd></div><div><dt>图片</dt><dd>{config.fullBackup.photoCount}</dd></div><div><dt>视频</dt><dd>{config.fullBackup.videoCount}</dd></div></dl>}
          {stageIndeterminate ? <div className={styles.progressLine}><div className={`${styles.progress} ${styles.progressIndeterminate}`} aria-label={backupPhaseLabel}><i /></div><strong>{backupPhaseLabel}</strong></div> : progressTotal ? <div className={styles.progressLine}><div className={styles.progress} aria-label={`${progressLabel} ${progressPercent}%`}><i style={{ width: `${progressPercent}%` }} /></div><strong>{progressLabel} {progressPercent}%</strong></div> : null}
          {config?.fullBackup?.downloadedBytes ? <small>本地已存在或写入：{formatBytes(config.fullBackup.downloadedBytes)}</small> : null}
          {config?.fullBackup?.verifiedBytes ? <small>已通过完整性校验：{formatBytes(config.fullBackup.verifiedBytes)} · 清单共 {config.fullManifest?.fileCount || config.fullBackup.verified} 个文件</small> : null}
        </div>
        <div className={styles.actions}>
          {(!config?.fullBackup || ["idle", "cancelled"].includes(config.fullBackup.status)) && <button className={styles.primary} onClick={() => void controlFullBackup("start")} disabled={busy !== null || config?.connectionStatus !== "connected"}>{busy === "full" ? "正在启动…" : "开始完整备份"}</button>}
          {config?.fullBackup && ["paused", "failed"].includes(config.fullBackup.status) && <button className={styles.primary} onClick={() => void controlFullBackup("resume")} disabled={busy !== null || config?.connectionStatus !== "connected"}>{busy === "full" ? "正在恢复…" : "继续 / 重试"}</button>}
          {config?.fullBackup?.status === "completed" && <button className={styles.primary} onClick={() => void controlFullBackup("resume")} disabled={busy !== null || config?.connectionStatus !== "connected"}>检查新增项目</button>}
          {fullBackupActive && <button onClick={() => void controlFullBackup("pause")} disabled={busy !== null}>暂停</button>}
          {fullBackupActive && <button className={styles.danger} onClick={() => void controlFullBackup("cancel")} disabled={busy !== null}>取消任务</button>}
          <button onClick={() => void enableBackupReminders()}>{desktopReminder ? "桌面提醒已启用" : "启用桌面提醒"}</button>
        </div>
        <p>任务完成或最终失败时会弹窗并播放提示音；桌面提醒需允许浏览器通知。请保持此备份页签打开，浏览器静音或限制后台活动可能影响提醒。</p>
      </article>

      <article className={`${styles.card} ${verifiedManifestCount === 0 ? styles.disabled : ""}`}>
        <div className={styles.cardHead}><span>6</span><div><h2>iCloud 容量释放</h2><p>增量复核本地清单：未变化文件复用已通过的校验结果，新增或变化文件重新计算 SHA-256；每次重新匹配云端项目，实际删除前仍需精确复核。</p></div></div>
        <div className={styles.safetyBanner}><strong>当前安全策略</strong><span>仅允许删除已通过本地 SHA-256、云端资产 ID、文件名、拍摄时间、原始大小和图库六重核对的项目；删除入口位于图片库，每次都先 dry-run 并要求手动确认。</span></div>
        {config?.releaseHistory?.movedCount ? <><div className={styles.releaseSummary}><div><span>云端“最近删除”</span><strong>{config.releaseHistory.movedCount} 个 · {formatBytes(config.releaseHistory.movedBytes)}</strong></div><div><span>Windows 回收站</span><strong>{config.releaseHistory.recycledFileCount || 0} 个 · {formatBytes(config.releaseHistory.recycledBytes || 0)}</strong></div><p>两侧都保留恢复窗口；分别清空 iCloud“最近删除”和 Windows 回收站后，空间才会彻底释放。</p></div>{config.releaseHistory.events?.filter(event => event.recycleStatus === "failed" || event.recycleStatus === "partial").map(event => <div className={styles.recycleRetry} key={event.id}><span>有 {event.recycleResults.filter(result => result.status === "failed").length} 个本地文件未移入回收站。</span><button onClick={() => void retryLocalRecycle(event.id)} disabled={busy !== null}>重试本地回收</button></div>)}</> : null}
        {releaseProgress && releaseProgress.status !== "idle" && <div className={styles.fullStatus} role="status" aria-live="polite">
          <div><strong>{releaseProgress.status === "running" ? "正在复核本地备份" : releaseProgress.status === "failed" ? "复核失败" : "复核完成"}</strong><span>{releaseProgress.message}</span></div>
          <div className={styles.progressLine}><div className={styles.progress} role="progressbar" aria-label="本地文件复核进度" aria-valuemin={0} aria-valuemax={releaseProgress.total || 1} aria-valuenow={releaseProgress.checked || 0}><i style={{ width: (releaseProgress.total ? Math.round((releaseProgress.checked || 0) / releaseProgress.total * 100) : 0) + "%" }} /></div><strong>{releaseProgress.checked || 0} / {releaseProgress.total || 0} 个 · {releaseProgress.total ? Math.round((releaseProgress.checked || 0) / releaseProgress.total * 100) : 0}%</strong></div>
          <div className={styles.liveMetrics}><div><span>本轮读取（复用文件无需读取）</span><strong>{formatBytes(releaseProgress.readBytes || 0)}</strong></div><div><span>复用 / 重新计算</span><strong>{releaseProgress.reused || 0} / {releaseProgress.rehashed || 0} 个</strong></div><div><span>复核通过</span><strong>{(releaseProgress.checked || 0) - (releaseProgress.failed || 0)} 个</strong></div><div><span>校验失败</span><strong>{releaseProgress.failed || 0} 个</strong></div></div>
          {releaseProgress.currentFile && <small>当前文件：{releaseProgress.currentFile}</small>}
        </div>}
        {config?.releasePlan ? <div className={styles.fullStatus}>
          <div><strong>{config.releasePlan.status === "confirmed" ? "逐项删除已启用" : config.releasePlan.status === "ready" ? "释放计划待确认" : "释放计划被阻止"}</strong><span>{config.releasePlan.message}</span></div>
          <dl><div><dt>本地通过校验文件</dt><dd>{config.releasePlan.eligibleCount}</dd></div><div><dt>已校验容量</dt><dd>{formatBytes(config.releasePlan.eligibleBytes)}</dd></div><div><dt>匹配云端项目</dt><dd>{config.releasePlan.matchedAssetCount ?? config.releasePlan.assets?.length ?? 0}</dd></div><div><dt>匹配本地文件</dt><dd>{config.releasePlan.matchedLocalFileCount ?? 0}</dd></div><div><dt>未匹配本地文件</dt><dd>{config.releasePlan.unmatchedLocalFileCount ?? 0}</dd></div><div><dt>校验失败</dt><dd>{config.releasePlan.failedCount}</dd></div></dl>
          <p className={styles.releaseExplanation}>本地文件与云端项目按不同单位计数：{config.releasePlan.matchedAssetCount ?? config.releasePlan.assets.length} 个云端项目对应 {config.releasePlan.matchedLocalFileCount ?? 0} 个本地文件，其中 {config.releasePlan.livePhotoAssetCount ?? 0} 个实况照片包含配对视频；另有 {config.releasePlan.unmatchedLocalFileCount ?? 0} 个通过校验的本地文件未完成精确匹配，不开放云端删除。容量是本地已校验文件大小，不代表可释放的 iCloud 容量。</p>
          {Boolean(config.releasePlan.unmatchedLocalFileCount) && <details className={styles.unmatchedFiles}><summary>查看未匹配文件（{config.releasePlan.unmatchedLocalFileCount} 个）</summary><p>这些文件未满足云端项目的唯一匹配条件。可重新统计云端内容后生成计划；本地文件仍保留。</p><ul>{config.releasePlan.unmatchedFiles?.map(file => <li key={file.relativePath}>{file.relativePath} · {formatBytes(file.size)}</li>)}</ul>{config.releasePlan.unmatchedLocalFileCount > 100 && <small>显示前 100 个未匹配文件。</small>}</details>}
          {config.releasePlan.files.length > 0 && <ul className={styles.releaseFiles}>{config.releasePlan.files.slice(0, 5).map(item => <li key={item.relativePath}><span>{item.mediaType === "video" ? "视频" : "图片"}</span><strong>{item.name}</strong><small>{formatBytes(item.size)}</small></li>)}</ul>}
        </div> : <p className={styles.releaseIntro}>{verifiedManifestCount === 0 ? "先在“完整增量备份”中选择至少一个时间范围并完成备份，系统才会建立可用于安全释放的 SHA-256 清单。" : !hasPreciseCloudCatalog ? `本地已有 ${verifiedManifestCount} 个 SHA-256 验证文件，不需要重新备份；但当前时间统计是旧格式，请先到上方第 4 区点击“刷新统计”，保存云端资产 ID。` : `本地持久化清单已有 ${verifiedManifestCount} 个 SHA-256 验证文件，可以直接生成释放计划；即使上方任务因服务重启显示“已暂停”，也不需要重新下载。`}</p>}
        <div className={styles.actions}><button onClick={() => void createReleasePlan()} disabled={busy !== null || verifiedManifestCount === 0 || !hasPreciseCloudCatalog}>{releaseStatus === "running" ? "正在复核 " + (releaseProgress?.checked || 0) + " / " + (releaseProgress?.total || verifiedManifestCount) + " 个本地文件…" : busy === "release" ? "正在处理…" : !hasPreciseCloudCatalog && verifiedManifestCount > 0 ? "请先刷新上方时间统计" : config?.releasePlan ? "重新生成释放计划" : "生成只读释放计划"}</button></div>
        {config?.releasePlan?.status === "ready" && <form className={styles.confirmRelease} onSubmit={confirmReleasePlan}><label className={styles.releaseAcknowledgement}><input type="checkbox" checked={releaseAcknowledged} onChange={event => setReleaseAcknowledged(event.target.checked)} /><span>我了解仅对上方精确匹配的项目开放删除；实际删除时仍需逐项选择并确认。此操作只启用删除入口，不会立即删除文件。</span></label><button className={styles.primary} disabled={busy !== null || !releaseAcknowledged || (config.releasePlan.matchedAssetCount ?? config.releasePlan.assets.length) === 0}>启用逐项删除</button></form>}
        {config?.releasePlan?.status === "confirmed" && <div className={styles.manualRelease}><strong>已开放逐项安全释放</strong><span>打开图片库，点击图片卡片的删除按钮，可选择仅本地、仅 iCloud 或两边都删除。云端选项只对通过精确匹配的图片开放。</span><a href="/photos">打开图片库</a></div>}
      </article>
    </section>

    <footer><span>配置只保存在这台电脑，并按 FrameBase 用户隔离</span><a href="/?library=video">返回视频库 →</a></footer>
    {confirmation && <ConfirmationDialog key={confirmation.title} request={confirmation} onResolve={resolveConfirmation} />}
    {backupCompletion && !confirmation && <ConfirmationDialog key={backupCompletion.title} request={backupCompletion} onResolve={() => setBackupCompletion(null)} />}
  </main>;
}
