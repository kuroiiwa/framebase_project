"use client";

import { DebugLogLink, type DebugLog } from "./icloud-debug-log";
import styles from "./media-actions.module.css";

export type CloudDeleteJob = {
  autoBatches?: boolean; stopRequested?: boolean;
  debugLog?: DebugLog;
  preview?: boolean; id?: string; status: "idle" | "running" | "completed" | "partial" | "failed";
  phase?: string; name?: string; message?: string; startedAt?: number; elapsedSeconds?: number;
  processed?: number; deleted?: number; total?: number;
};

export async function waitForCloudDelete<T extends CloudDeleteJob>(id: string, onProgress: (job: T) => void, signal?: AbortSignal): Promise<T> {
  let last: T | undefined;
  while (!signal?.aborted) {
    let response: Response;
    try { response = await fetch("/api/icloud/release/delete/status", { cache: "no-store", signal }); }
    catch (reason) {
      if (signal?.aborted) throw reason;
      if (last) onProgress({ ...last, message: "连接暂时中断，正在重新读取后台状态；勿重复提交删除。" });
      await new Promise(resolve => setTimeout(resolve, 1000));
      continue;
    }
    const data = await response.json() as { deleteJob?: T; error?: string };
    if (!response.ok || !data.deleteJob || data.deleteJob.id !== id) throw new Error(data.error || "无法读取删除任务状态，请刷新页面确认结果，勿重复提交。");
    onProgress(data.deleteJob);
    last = data.deleteJob;
    if (data.deleteJob.status !== "running") return data.deleteJob;
    await new Promise(resolve => setTimeout(resolve, 1000));
  }
  throw new DOMException("页面已关闭；后台任务会继续。", "AbortError");
}

export function CloudDeleteProgress({ job, elapsedSeconds }: { job: CloudDeleteJob; elapsedSeconds?: number }) {
  return <div className={styles.progress} role="status" aria-live="polite">
    <strong>{job.status === "running" ? job.preview || job.phase === "preview" ? "确认前：正在复核云端项目" : "已确认，云端删除任务执行中" : job.status === "completed" ? job.preview ? "云端复核通过，尚未删除" : "删除完成" : job.status === "partial" ? job.preview ? "部分云端项目复核通过，尚未删除" : "部分操作完成" : "删除未完成"}</strong>
    <p>{job.name}</p><p>{job.message}</p>
    <dl><div><dt>已耗时</dt><dd>{elapsedSeconds ?? job.elapsedSeconds ?? 0} 秒</dd></div><div><dt>云端已返回结果</dt><dd>{job.processed || 0} / {job.total || 1}</dd></div><div><dt>已确认移入最近删除</dt><dd>{job.deleted || 0} / {job.total || 1}</dd></div></dl>
    <DebugLogLink log={job.debugLog} />
    {job.status === "running" && <small>Apple 尚未返回结果时不显示估算百分比。任务在后台继续，请勿重复提交。</small>}
    {job.status === "running" && job.autoBatches && <button disabled={job.stopRequested} onClick={async event => {
      const button = event.currentTarget;
      button.disabled = true;
      try {
        const response = await fetch("/api/icloud/release/delete/stop", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ jobId: job.id }) });
        const data = await response.json() as { error?: string };
        if (!response.ok) throw new Error(data.error || "停止请求未成功，请重试。");
      } catch (reason) { button.disabled = false; window.alert(reason instanceof Error ? reason.message : "停止请求未成功，请重试。"); }
    }}>{job.stopRequested ? "已请求停止，等待本批结束" : "停止后续批次"}</button>}
  </div>;
}
