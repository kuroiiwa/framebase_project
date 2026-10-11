import { randomUUID } from "node:crypto";

export function createReleaseDeleteJobs({ icloud, provider, recycleBin, debugLogs }) {
  const jobs = new Map();
  const pending = new Map();
  function read(username) {
    const job = jobs.get(username);
    return job ? { ...job, elapsedSeconds: Math.floor(((job.finishedAt || Date.now()) - job.startedAt) / 1000) } : { status: "idle" };
  }
  function start(username, { assets, recycleLocal, preview = false, autoBatches = false }) {
    if (autoBatches && (preview || recycleLocal)) throw new Error("自动分批仅支持释放 iCloud，本地原片保留。");
    if (jobs.get(username)?.status === "running") throw Object.assign(new Error("当前用户已有云端删除任务，请等待结果。"), { status: 409 });
    const job = { id: randomUUID(), status: "running", phase: "preparing", name: assets.length > 1 ? `批量删除 ${assets.length} 个云端项目` : assets[0].name, startedAt: Date.now(), phaseStartedAt: Date.now(), message: "正在准备已确认的删除任务…", processed: 0, deleted: 0, total: assets.length, recycleLocal, preview, autoBatches };
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
        if (autoBatches) {
          const results = [];
          let releaseHistory;
          let timeline;
          const batchCount = Math.ceil(assets.length / 100);
          for (let offset = 0; offset < assets.length; offset += 100) {
            if (job.stopRequested) throw new Error("已按要求停止自动分批。");
            const batch = assets.slice(offset, offset + 100);
            const prefix = `自动分批 ${Math.floor(offset / 100) + 1}/${batchCount} · `;
            const context = await icloud.connectionContext(username);
            const report = progress => update({ ...progress, status: "running", total: assets.length, processed: offset + (progress.processed || 0), deleted: job.deleted, message: prefix + (progress.message || "正在复核…") });
            report({ phase: "verifying", message: "正在重新复核本批云端项目，尚未提交本批删除…" });
            const reviewed = await provider.deleteAssets({ ...context, jobKey: username, assets: batch, commit: false, onProgress: report, debugLog: log });
            log?.write("batch_preview", { offset, ...reviewed });
            if (job.stopRequested) throw new Error("已按要求停止自动分批，本批尚未提交删除。");
            const matched = new Set((reviewed.results || []).filter(item => item.status === "matched").map(item => `${item.library}:${item.id}`));
            if (reviewed.status !== "matched" || reviewed.results?.length !== batch.length || matched.size !== batch.length || batch.some(asset => !matched.has(`${asset.library}:${asset.id}`))) {
              throw new Error(`${prefix}${reviewed.message || "复核结果不完整"} 自动分批已停止，本批未提交删除，剩余项目保留。`);
            }
            report({ phase: "deleting", message: "本批复核通过，正在提交删除；本地原片保留…" });
            const released = await provider.deleteAssets({ ...context, jobKey: username, assets: batch, commit: true, onProgress: report, debugLog: log });
            log?.write("batch_result", { offset, ...released });
            const expected = new Set(batch.map(asset => `${asset.library}:${asset.id}`));
            const seen = new Set();
            const validResults = (released.results || []).filter(item => {
              const key = `${item.library}:${item.id}`;
              if (!expected.has(key) || seen.has(key)) return false;
              seen.add(key); return true;
            });
            results.push(...validResults);
            job.deleted = results.filter(item => item.status === "deleted").length;
            job.result = { releaseResult: { ...released, results }, releaseHistory, timeline };
            releaseHistory = await icloud.recordReleasedAssets(username, batch, { ...released, results: validResults }, null);
            timeline = await icloud.readTimeline(username);
            job.result = { releaseResult: { ...released, results }, releaseHistory, timeline };
            if (released.status !== "deleted" || validResults.filter(item => item.status === "deleted").length !== batch.length) {
              throw new Error(`${prefix}${released.message || "删除结果不完整"} 自动分批已停止；未确认删除的项目保留，请查看结果后重试。`);
            }
            update({ phase: "recording", processed: offset + batch.length, deleted: job.deleted, message: `${prefix}本批完成，累计确认删除 ${job.deleted}/${assets.length} 个项目。` });
          }
          job.status = "completed"; job.phase = "completed";
          job.message = `自动分批完成，已确认将 ${job.deleted}/${assets.length} 个云端项目移入“最近删除”。本地原片已保留。`;
          return;
        }
        const localPlan = recycleLocal ? (update({ phase: "local_verifying", message: "正在重新校验要回收的本地原片…" }), await icloud.prepareLocalRecycle(username, assets)) : { files: [] };
        const context = await icloud.connectionContext(username);
        update({ phase: preview ? "verifying" : "deleting", message: preview ? "正在连接 Apple 并检查目标及最近删除状态…" : "正在连接 Apple 并提交精确资产删除…" });
        const releaseResult = await provider.deleteAssets({ ...context, jobKey: username, assets, commit: !preview, onProgress: update, debugLog: log });
        log?.write("provider_result", releaseResult);
        if (preview) {
          job.result = { releaseResult, localRecyclePlan: { fileCount: localPlan.fileCount || 0, bytes: localPlan.bytes || 0 } };
          const matchedKeys = new Set((releaseResult.results || []).filter(result => result.status === "matched").map(result => `${result.library}:${result.id}`));
          const verifiedCount = assets.filter(asset => matchedKeys.has(`${asset.library}:${asset.id}`)).length;
          job.status = verifiedCount === assets.length ? "completed" : verifiedCount > 0 ? "partial" : "failed";
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
        job.status = autoBatches && job.deleted ? "partial" : "failed"; job.phase = job.status;
        job.message = autoBatches ? `${error instanceof Error ? error.message : "自动分批未完成。"} 已确认删除 ${job.deleted}/${assets.length} 个；剩余项目未继续处理，本地原片保留。请刷新计划确认结果后重试。` : job.deleted ? "云端已返回删除成功，但后续记录更新失败，请刷新统计确认状态；不要重复提交删除。" : error instanceof Error ? error.message : "删除任务失败，请刷新云端状态后确认结果。";
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
  function stop(username, id) {
    const job = jobs.get(username);
    if (!job || job.id !== id || job.status !== "running" || !job.autoBatches) throw new Error("没有可停止的自动分批任务。");
    job.stopRequested = true;
    job.message = "已请求停止；已提交的当前批次会完成并保存结果，不再提交后续批次。";
    return read(username);
  }
  return { read, start, wait, stop };
}
