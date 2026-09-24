"use client";

import { useEffect, useState, type ReactNode } from "react";
import { migrateGabriLibrary, setStorageUser } from "./account-storage";

export async function signOut() {
  await fetch("/api/account/logout", { method: "POST" });
  localStorage.setItem("framebase-auth-change", String(Date.now()));
  window.location.replace("/");
}

export default function AccountGate({ children }: { children: (username: string) => ReactNode }) {
  const [username, setUsername] = useState<string | null>(null);
  const [ready, setReady] = useState(false);
  const [needsSetup, setNeedsSetup] = useState(false);
  const [mode, setMode] = useState<"login" | "register">("login");
  const [name, setName] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const adminLogin = needsSetup || (mode === "login" && name.trim().toLowerCase() === "admin");

  useEffect(() => {
    if (window.location.hostname === "127.0.0.1") {
      const localUrl = new URL(window.location.href);
      localUrl.hostname = "localhost";
      window.location.replace(localUrl);
      return;
    }
    void (async () => {
      try {
        const response = await fetch("/api/account/session", { cache: "no-store" });
        const data = await response.json() as { user: string | null; needsSetup: boolean; error?: string };
        if (!response.ok) throw new Error(data.error || "无法读取账户状态");
        setNeedsSetup(data.needsSetup);
        if (data.user) {
          setStorageUser(data.user);
          if (data.user === "gabri") await migrateGabriLibrary();
          setUsername(data.user);
        }
      } catch (reason) { setError(reason instanceof Error ? reason.message : "无法连接账户服务。请使用 npm run lan 启动 Framebase。"); }
      finally { setReady(true); }
    })();
  }, []);

  useEffect(() => {
    if (!username) return;
    const verify = async () => {
      try {
        const response = await fetch("/api/account/session", { cache: "no-store" });
        const data = await response.json() as { user: string | null };
        if (data.user !== username) window.location.reload();
      } catch { /* A transient connection failure does not expose another account. */ }
    };
    const onStorage = (event: StorageEvent) => { if (event.key === "framebase-auth-change") void verify(); };
    const onVisible = () => { if (!document.hidden) void verify(); };
    window.addEventListener("storage", onStorage);
    document.addEventListener("visibilitychange", onVisible);
    const timer = setInterval(() => void verify(), 30_000);
    return () => { clearInterval(timer); window.removeEventListener("storage", onStorage); document.removeEventListener("visibilitychange", onVisible); };
  }, [username]);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true); setError("");
    try {
      const endpoint = needsSetup ? "setup" : mode;
      const response = await fetch(`/api/account/${endpoint}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ username: needsSetup ? "admin" : name.trim(), ...(adminLogin ? { password } : {}) }) });
      const data = await response.json() as { error?: string };
      if (!response.ok) throw new Error(data.error || "操作失败");
      localStorage.setItem("framebase-auth-change", String(Date.now()));
      window.location.reload();
    } catch (reason) { setError(reason instanceof Error ? reason.message : "操作失败"); setBusy(false); }
  }

  if (!ready) return <main className="account-screen"><section className="account-card"><h1>Framebase</h1><p>正在读取账户…</p></section></main>;
  if (username) return <>{children(username)}</>;
  return <main className="account-screen"><section className="account-card">
    <div className="account-logo">F</div><h1>Framebase</h1>
    <p>{needsSetup ? "首次使用，请为 admin 设置密码。" : mode === "register" ? "输入用户名，创建你的个人视频库" : adminLogin ? "输入管理员密码" : "输入用户名，进入你的视频库"}</p>
    <form onSubmit={submit}>
      <label>用户名<input value={needsSetup ? "admin" : name} onChange={event => setName(event.target.value)} disabled={needsSetup || busy} autoComplete="username" required minLength={3} maxLength={32} /></label>
      {adminLogin && <label>管理员密码<input type="password" value={password} onChange={event => setPassword(event.target.value)} autoComplete={needsSetup ? "new-password" : "current-password"} required minLength={8} maxLength={128} disabled={busy} /></label>}
      {error && <p role="alert" className="account-error">{error}</p>}
      <button type="submit" disabled={busy}>{busy ? "请稍候…" : needsSetup ? "设置管理员密码" : mode === "register" ? "注册并进入" : "登录"}</button>
    </form>
    {!needsSetup && <button className="account-switch" onClick={() => { setMode(mode === "login" ? "register" : "login"); setError(""); }}>{mode === "login" ? "没有账户？立即注册" : "已有账户？返回登录"}</button>}
  </section></main>;
}
