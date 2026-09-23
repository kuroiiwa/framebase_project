"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import styles from "./power-panel.module.css";

type Device = { id: string; name: string; approved: boolean; created?: number };
type PowerStatus = { enabled: boolean; supported: boolean; computerName: string; authorized: boolean; device: Device | null; devices?: Device[]; serverNow: number; task: null | { id: string; phase: string; deadline: number; error?: string } };

export default function PowerPanel({ admin = false }: { admin?: boolean }) {
  const [status, setStatus] = useState<PowerStatus | null>(null);
  const [error, setError] = useState("");
  const [connected, setConnected] = useState(false);
  const [busy, setBusy] = useState(false);
  const [confirm, setConfirm] = useState(false);
  const [name, setName] = useState("我的手机");
  const [clock, setClock] = useState(0);
  const [deadline, setDeadline] = useState(0);
  const inFlight = useRef(false);
  const version = useRef(0);
  const mutation = useRef(false);
  const requestId = useRef("");

  const apply = useCallback((data: PowerStatus) => {
    setDeadline(Date.now() + Math.max(0, (data.task?.deadline || 0) - data.serverNow));
    setClock(Date.now()); setStatus(data); setConnected(true);
  }, []);
  const refresh = useCallback(async () => {
    if (inFlight.current || mutation.current) return;
    inFlight.current = true;
    const ticket = version.current;
    try {
      const response = await fetch("/api/lan/power", { cache: "no-store", signal: AbortSignal.timeout(4000) });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "无法读取关机状态");
      if (ticket === version.current) apply(data);
    } catch { if (ticket === version.current) setConnected(false); }
    finally { inFlight.current = false; }
  }, [apply]);
  const invalidate = useCallback(() => { version.current++; }, []);
  useEffect(() => {
    const initial = setTimeout(() => void refresh(), 0);
    const polling = setInterval(() => void refresh(), 1000);
    return () => { clearTimeout(initial); clearInterval(polling); invalidate(); };
  }, [refresh, invalidate]);
  useEffect(() => {
    if (status?.task?.phase !== "pending") return;
    const ticking = setInterval(() => setClock(Date.now()), 200);
    return () => clearInterval(ticking);
  }, [status?.task?.phase]);

  async function action(actionName: string, body: Record<string, unknown> = {}) {
    if (mutation.current) return;
    mutation.current = true; version.current++; setBusy(true); setError("");
    try {
      const response = await fetch(`/api/lan/power/${actionName}`, { method: "POST", headers: { "Content-Type": "application/json", "X-Framebase-Power": "1" }, body: JSON.stringify(body), signal: AbortSignal.timeout(5000) });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "操作失败");
      apply(data); setConfirm(false);
    } catch (reason) {
      setError(reason instanceof Error && reason.name !== "TimeoutError" ? reason.message : "请求结果未确认，请刷新状态；不要重复发起关机。");
      void refresh();
    } finally { mutation.current = false; setBusy(false); }
  }
  const pending = status?.task?.phase === "pending";
  const submitted = status?.task && ["executing", "accepted"].includes(status.task.phase);
  const remaining = Math.max(0, Math.ceil((deadline - clock) / 1000));

  return <section className={styles.panel} aria-label={admin ? "远程关机设置" : "远程关闭电脑"}>
    <header><div><strong>{admin ? "远程关机设置" : "远程关闭电脑"}</strong><span>{status?.computerName || "连接到电脑"}</span></div>{admin && status && <label className={styles.toggle}><input type="checkbox" checked={status.enabled} disabled={busy || !connected || !status.supported} onChange={event => void action("settings", { enabled: event.target.checked })} /> 允许手机远程关机</label>}</header>
    {!connected && <p role="status">暂时无法确认电脑状态。{status?.task ? "连接中断不代表关机已完成，倒计时任务可能仍在执行。" : "请确认通过 Framebase 启动窗口访问本页。"}<button onClick={() => void refresh()}>刷新状态</button></p>}
    {status && !status.supported && <p>此功能仅支持 Windows 电脑。</p>}
    {status && <>
      <p>关机前等待 <b>10 秒</b>，期间可取消。不会强制关闭程序；未保存内容可能阻止关机。</p>
      {admin ? <>
        <p>请先让手机申请权限，再核对手机显示的设备编号。关闭此开关或移除发起设备会取消尚未执行的倒计时。</p>
        {status.devices?.length ? <ul className={styles.devices}>{status.devices.map(device => <li key={device.id}><div><strong>{device.name}</strong><span>设备编号：{device.id} · {device.approved ? "已授权" : "等待授权"}</span></div><div>{!device.approved && <button disabled={busy || !connected || !status.enabled} onClick={() => { if (window.confirm(`确认手机上显示的设备编号为 ${device.id}？授权后该设备可以关闭 ${status.computerName}。`)) void action("approve", { deviceId: device.id }); }}>核对并授权</button>}<button disabled={busy || !connected} onClick={() => void action("remove", { deviceId: device.id })}>{device.approved ? "撤销并移除" : "拒绝"}</button></div></li>)}</ul> : <p>尚无设备申请。普通视频配对不会自动获得关机权限。</p>}
      </> : !status.enabled ? <p>尚未开启。请在电脑端“局域网 → 远程关机设置”开启后，为这台手机单独授权。</p> : !status.device ? <div className={styles.register}><input value={name} maxLength={40} onChange={event => setName(event.target.value)} aria-label="设备名称" placeholder="设备名称" /><button disabled={busy || !connected || !status.supported} onClick={() => void action("register", { name })}>申请关机权限</button></div> : !status.authorized ? <p role="status">等待电脑端授权。请核对设备编号：<b>{status.device.id}</b></p> : <p>此手机已授权 · 设备编号 {status.device.id}</p>}
      {pending && <div className={styles.countdown} role="status"><strong>{remaining > 0 ? `${remaining} 秒后向 Windows 提交关机` : "正在确认指令状态…"}</strong><button disabled={busy || (!admin && !status.authorized)} onClick={() => void action("cancel", { taskId: status.task?.id })}>取消关机</button></div>}
      {submitted && <p role="status">{status.task?.phase === "accepted" ? "Windows 已接受关机指令。" : "正在向 Windows 提交关机指令。"}尚不能确认电脑已关机，网页已无法取消。若电脑仍开着，请检查未保存程序。</p>}
      {status.task?.phase === "cancelled" && <p role="status">关机倒计时已取消。</p>}
      {status.task?.phase === "failed" && <p role="alert">{status.task.error || "提交关机指令失败。"}</p>}
      {!admin && status.authorized && !pending && !submitted && <button className={styles.danger} disabled={busy || !connected} onClick={() => { const bytes = new Uint8Array(16); crypto.getRandomValues(bytes); requestId.current = Array.from(bytes, byte => byte.toString(16).padStart(2, "0")).join(""); setConfirm(true); }}>关闭电脑…</button>}
      {confirm && !pending && !submitted && <div className={styles.confirm} role="alertdialog" aria-label="确认关闭电脑"><strong>确认关闭 {status.computerName}？</strong><p>确认后开始 10 秒倒计时，请确保电脑上的工作已保存。</p><div><button disabled={busy} onClick={() => setConfirm(false)}>返回</button><button className={styles.danger} disabled={busy || !connected || !status.authorized} onClick={() => void action("request", { confirm: true, requestId: requestId.current })}>{busy ? "正在提交…" : "确认，10 秒后关机"}</button></div></div>}
    </>}
    {error && <p className={styles.error} role="alert">{error}</p>}
  </section>;
}
