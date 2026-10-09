"use client";

import { useCallback, useEffect, useState } from "react";
import { DebugLogLink, type DebugLog } from "./icloud-debug-log";
import styles from "./media-actions.module.css";

type AuthState = { status: string; message: string };
const activeStates = new Set(["starting", "waiting_password", "waiting_mfa", "verifying"]);

export default function AppleSessionControls({ disabled = false, onVerified, onBusyChange }: { disabled?: boolean; onVerified?: () => void; onBusyChange?: (busy: boolean) => void }) {
  const [auth, setAuth] = useState<AuthState | null>(null);
  const [debugLog, setDebugLog] = useState<DebugLog>();
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const [password, setPassword] = useState("");
  const [code, setCode] = useState("");
  const verify = useCallback(async () => {
    setBusy(true); setError(""); setMessage("正在验证 Apple 会话和照片图库访问…");
    try {
      const response = await fetch("/api/icloud/verify", { method: "POST" });
      const data = await response.json() as { verification?: AuthState; debugLog?: DebugLog; error?: string };
      setDebugLog(data.debugLog);
      if (!response.ok || data.verification?.status !== "connected") throw new Error(data.error || data.verification?.message || "会话或图库访问未通过，请重新登录 Apple。");
      setMessage(`${data.verification.message} 可重新点击“继续”复核，验证不会自动删除图片。`);
      onVerified?.();
    } catch (reason) { setMessage(""); setError(reason instanceof Error ? reason.message : "会话验证失败。"); }
    finally { setBusy(false); }
  }, [onVerified]);

  const authStatus = auth?.status;
  const active = Boolean(authStatus && activeStates.has(authStatus));
  useEffect(() => { onBusyChange?.(busy || active); }, [busy, active, onBusyChange]);
  useEffect(() => {
    let stopped = false;
    void fetch("/api/icloud/auth/status", { cache: "no-store" }).then(response => response.ok ? response.json() as Promise<AuthState> : null).then(data => {
      if (!stopped && data && activeStates.has(data.status)) setAuth(data);
    }).catch(() => undefined);
    return () => { stopped = true; onBusyChange?.(false); };
  }, [onBusyChange]);
  useEffect(() => {
    if (!authStatus || !activeStates.has(authStatus)) return;
    let stopped = false;
    let polling = false;
    const timer = setInterval(async () => {
      if (polling) return;
      polling = true;
      try {
        const response = await fetch("/api/icloud/auth/status", { cache: "no-store" });
        const next = await response.json() as AuthState & { error?: string };
        if (stopped) return;
        if (!response.ok) throw new Error(next.error || "无法读取 Apple 登录状态。");
        setAuth(next);
        if (next.status === "connected") { clearInterval(timer); setPassword(""); setCode(""); void verify(); }
      } catch (reason) { if (!stopped) setError(reason instanceof Error ? reason.message : "登录状态读取失败。"); }
      finally { polling = false; }
    }, 1000);
    return () => { stopped = true; clearInterval(timer); };
  }, [authStatus, verify]);

  async function start() {
    setBusy(true); setError(""); setMessage("");
    try {
      const response = await fetch("/api/icloud/auth/start", { method: "POST" });
      const data = await response.json() as AuthState & { error?: string };
      if (!response.ok) throw new Error(data.error || "Apple 登录未能启动。");
      setAuth(data);
    } catch (reason) { setError(reason instanceof Error ? reason.message : "Apple 登录未能启动。"); }
    finally { setBusy(false); }
  }
  async function submit(event: React.FormEvent, type: "password" | "mfa") {
    event.preventDefault(); setBusy(true); setError("");
    try {
      const response = await fetch("/api/icloud/auth/input", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ type, value: type === "password" ? password : code.trim() }) });
      const data = await response.json() as AuthState & { error?: string };
      if (!response.ok) throw new Error(data.error || "登录信息提交失败。");
      setAuth(data);
      setPassword(""); setCode("");
    } catch (reason) { setError(reason instanceof Error ? reason.message : "登录信息提交失败。"); }
    finally { setBusy(false); }
  }
  async function cancel() {
    setBusy(true);
    try {
      const response = await fetch("/api/icloud/auth/cancel", { method: "POST" });
      if (!response.ok) throw new Error("无法取消 Apple 登录。");
      setAuth(await response.json() as AuthState); setPassword(""); setCode("");
    } catch (reason) { setError(reason instanceof Error ? reason.message : "无法取消登录。"); }
    finally { setBusy(false); }
  }

  return <section className={styles.sessionPanel} aria-label="Apple 会话验证">
    <h3>Apple 会话</h3>
    <p>Apple 会话验证与 iCloud 备份中心共用。验证通过后可重新复核所选图片。</p>
    <div className={styles.sessionActions}><button className={`${styles.button} ${styles.primaryButton}`} type="button" disabled={disabled || busy || active} onClick={() => void verify()}>{busy && !active ? "正在验证/连接…" : "验证 Apple 会话与图库"}</button>{" "}
    <button className={styles.button} type="button" disabled={disabled || busy || active} onClick={() => void start()}>重新登录 Apple</button></div>
    {auth && <p role="status">{auth.message}</p>}
    {authStatus === "waiting_password" && <form onSubmit={event => void submit(event, "password")}><label>Apple ID 密码 <input type="password" autoComplete="off" value={password} onChange={event => setPassword(event.target.value)} required disabled={disabled || busy} /></label><button className={`${styles.button} ${styles.primaryButton}`} disabled={disabled || busy}>提交密码</button></form>}
    {authStatus === "waiting_mfa" && <form onSubmit={event => void submit(event, "mfa")}><label>六位验证码 <input inputMode="numeric" autoComplete="one-time-code" pattern="[0-9]{6}" maxLength={6} value={code} onChange={event => setCode(event.target.value)} required disabled={disabled || busy} /></label><button className={`${styles.button} ${styles.primaryButton}`} disabled={disabled || busy}>提交验证码</button></form>}
    {active && <button className={styles.button} type="button" disabled={disabled || busy} onClick={() => void cancel()}>取消 Apple 登录</button>}
    {message && <p className={styles.success} role="status">{message}</p>}{error && <p className={styles.error} role="alert">{error}</p>}
    <DebugLogLink log={debugLog} />
  </section>;
}
