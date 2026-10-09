import { randomUUID } from "node:crypto";

export function createReleaseDeleteJobs({ icloud, provider, recycleBin, debugLogs }) {
  const jobs = new Map();
  const pending = new Map();
  function read(username) {
    const job = jobs.get(username);
    return job ? { ...job, elapsedSeconds: Math.floor(((job.finishedAt || Date.now()) - job.startedAt) / 1000) } : { status: "idle" };
  }
  function start(username, { assets, recycleLocal, preview = false }) {
    if (jobs.get(username)?.status === "running") throw Object.assign(new Error("当前用户已有云端删除任务，请等待结果。"), { status: 409 });
    const job = { id: randomUUID(), status: "running", phase: "preparing", name: assets.length > 1 ? `批量删除 ${assets.length} 个云端项目` : assets[0].name, startedAt: Date.now(), phaseStartedAt: Date.now(), message: "正在准备已确认的删除任务…", processed: 0, deleted: 0, total: assets.length, recycleLocal, preview };
    const log = debugLogs?.start(username, preview ? "cloud_delete_preview" : "cloud_delete", { jobId: job.id, recycleLocal, assets });
    if (log) job.debugLog = log.info;
    jobs.set(username, job);
    let lastProgress = "";
    const update = progress => {
      if (progress.phase && progress.phase !== job.phase) job.phaseStartedAt = Date.now();
      Object.assign(job, progress);
      const signature = JSON.stringify([job.phase, job.processed, job.deleted, job.message]);
      if (signature !== lastProgress) { log?.write("progress", progress); lastProgress = signature; }
    };
    const completion = (async () => {
      try {
        const localPlan = recycleLocal ? (update({ phase: "local_verifying", message: "正在重新校验要回收的本地原片…" }), await icloud.prepareLocalRecycle(username, assets)) : { files: [] };
        const context = await icloud.connectionContext(username);
        update({ phase: preview ? "verifying" : "deleting", message: preview ? "正在连接 Apple 并检查目标及最近删除状态…" : "正在连接 Apple 并提交精确资产删除…" });
        const releaseResult = await provider.deleteAssets({ ...context, jobKey: username, assets, commit: !preview, onProgress: update, debugLog: log });
        log?.write("provider_result", releaseResult);
        if (preview) {
          job.result = { releaseResult, localRecyclePlan: { fileCount: localPlan.fileCount || 0, bytes: localPlan.bytes || 0 } };
          job.status = releaseResult.status === "matched" ? "completed" : "failed";
          job.phase = job.status;
          job.message = releaseResult.message + " 尚未执行删除。";
          return;
        }
        job.deleted = (releaseResult.results || []).filter(result => result.status === "deleted").length;
        let recycleResult = null;
        if (job.deleted > 0 && recycleLocal) {
          update({ phase: "recycling", message: "云端已确认删除，正在将本地原片移入 Windows 回收站…" });
          const deletedKeys = new Set(releaseResult.results.filter(result => result.status === "deleted").map(result => `${result.library}:${result.id}`));
          const deletedPaths = new Set(assets.filter(asset => deletedKeys.has(`${asset.library}:${asset.id}`)).flatMap(asset => asset.localFiles || []));
          recycleResult = await recycleBin.recycle(localPlan.files.filter(file => deletedPaths.has(file.relativePath)));
        }
        update({ phase: "recording", message: job.deleted ? "云端已返回删除结果，正在保存记录并更新页面数据…" : releaseResult.message });
        const releaseHistory = await icloud.recordReleasedAssets(username, assets, releaseResult, recycleResult);
        const timeline = await icloud.readTimeline(username);
        job.result = { releaseResult, recycleResult, releaseHistory, timeline };
        job.status = releaseResult.status === "deleted" ? (recycleResult && recycleResult.status !== "recycled" ? "partial" : "completed") : job.deleted ? "partial" : "failed";
        job.phase = job.status;
        job.message = releaseResult.message + (recycleResult ? " " + recycleResult.message : recycleLocal ? " 本地原片未回收。" : " 本地原片已保留。");
      } catch (error) {
        log?.write("exception", { type: error?.name, code: error?.code, frames: String(error?.stack || "").split("\n").filter(line => /^\s+at /.test(line)) });
        job.status = "failed"; job.phase = "failed";
        job.message = job.deleted ? "云端已返回删除成功，但后续记录更新失败，请刷新统计确认状态；不要重复提交删除。" : error instanceof Error ? error.message : "删除任务失败，请刷新云端状态后确认结果。";
      } finally { job.finishedAt = Date.now(); log?.write("finished", { status: job.status, message: job.message, deleted: job.deleted, elapsedMs: job.finishedAt - job.startedAt }); }
    })();
    pending.set(job.id, completion);
    void completion.finally(() => pending.delete(job.id));
    return read(username);
  }
  async function wait(username, id) {
    await pending.get(id);
    const job = read(username);
    if (job.id !== id) throw new Error("删除任务已更新，请刷新状态。");
    return job;
  }
  return { read, start, wait };
}
