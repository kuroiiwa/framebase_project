"use client";

import { useEffect, useState } from "react";
import { signOut } from "./account-gate";

type Source = { name: string; videoCount: number; totalSize: number };
type User = { username: string; sources: Source[]; videoCount: number; totalSize: number };
const size = (bytes: number) => bytes >= 1024 ** 3 ? `${(bytes / 1024 ** 3).toFixed(1)} GB` : bytes >= 1024 ** 2 ? `${(bytes / 1024 ** 2).toFixed(1)} MB` : `${Math.round(bytes / 1024)} KB`;

export default function AdminDashboard() {
  const [users, setUsers] = useState<User[]>([]);
  const [error, setError] = useState("");
  useEffect(() => {
    void fetch("/api/account/users", { cache: "no-store" }).then(async response => {
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "无法读取用户信息");
      setUsers(data.users);
    }).catch(reason => setError(reason.message));
  }, []);
  return <main className="admin-page"><header><div className="account-logo">F</div><span>Framebase · 管理员</span><button onClick={() => void signOut()}>退出登录</button></header>
    <section className="admin-content"><h1>用户概况</h1><p>查看各账户在这台电脑上保存的源文件夹、视频数量与总大小。</p>
    {error && <p role="alert" className="account-error">{error}</p>}
    <div className="admin-users">{users.map(user => <article key={user.username}><div className="admin-user-head"><strong>{user.username}</strong><span>{user.videoCount} 个视频 · {size(user.totalSize)}</span></div>
      {user.sources.length ? <ul>{user.sources.map((source, index) => <li key={`${source.name}-${index}`}><span>{source.name}</span><span>{source.videoCount} 个 · {size(source.totalSize)}</span></li>)}</ul> : <p>尚无源文件夹</p>}
    </article>)}</div></section>
  </main>;
}
