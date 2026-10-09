"use client";

import { useEffect, useState } from "react";
import styles from "./media-actions.module.css";

export type DebugLog = { id: string; path: string; downloadUrl: string; error?: string; updatedAt?: string };
export function DebugLogLink({ log }: { log?: DebugLog }) {
  const [copied, setCopied] = useState(false);
  const [copyError, setCopyError] = useState(false);
  if (!log) return null;
  return <details className={styles.debugLog}>
    <summary>诊断日志 · 展开查看</summary>
    <p>诊断日志编号：{log.id}</p>
    <p>日志地址：<code>{log.path}</code></p>
    {log.error ? <p className={styles.error}>{log.error}</p> : <a className={styles.button} href={log.downloadUrl} download>下载诊断日志</a>}
    <button className={styles.button} type="button" onClick={() => void navigator.clipboard.writeText(log.path).then(() => { setCopied(true); setCopyError(false); }).catch(() => setCopyError(true))}>{copied ? "地址已复制" : "复制日志地址"}</button>
    {copyError && <p>无法自动复制，请选中上方地址复制。</p>}
    <small>反馈问题时请附上日志文件。日志包含所选图片名称和资产编号，不包含密码、验证码或会话令牌。</small>
  </details>;
}

export function RecentDebugLogs() {
  const [logs, setLogs] = useState<DebugLog[]>([]);
  const [error, setError] = useState("");
  async function refresh() {
    try {
      const response = await fetch("/api/icloud/debug/logs", { cache: "no-store" });
      if (!response.ok) throw new Error("无法读取诊断日志。");
      const data = await response.json() as { logs: DebugLog[] };
      setLogs(data.logs); setError("");
    } catch { setError("无法读取诊断日志，请重试。"); }
  }
  useEffect(() => { const timer = setTimeout(() => void refresh(), 0); return () => clearTimeout(timer); }, []);
  return <section className={styles.sessionPanel}>
    <h3>运行诊断日志</h3>
    <p>云端删除、确认前复核和 Apple 会话验证会自动记录日志。每个用户保留最近 30 份，每份最多约 1 MB。</p>
    <button className={styles.button} type="button" onClick={() => void refresh()}>刷新日志列表</button>
    {error && <p role="alert">{error}</p>}
    {!logs.length && <p>暂无日志，执行一次复核或会话验证后会自动生成。</p>}
    {logs.map(log => <details key={log.id}><summary>{log.updatedAt ? new Date(log.updatedAt).toLocaleString() : "诊断日志"} · {log.id.slice(0, 8)}</summary><DebugLogLink log={log} /></details>)}
  </section>;
}
