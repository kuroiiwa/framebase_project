import { setTimeout as delay } from "node:timers/promises";

const retryableStatuses = new Set(["network_error", "error", "photos_error", "tool_error", "verification_failed"]);

export async function runBackupWithRetries({ run, onRetry, signal, wait = (ms, signal) => delay(ms, undefined, { signal }) }) {
  const aborted = () => ({ status: "aborted", message: "备份任务已安全停止，可稍后继续。", files: [] });
  for (let attempt = 0; attempt <= 2; attempt += 1) {
    if (signal.aborted) return aborted();
    let result;
    try { result = await run(attempt); }
    catch (error) {
      if (signal.aborted || error?.name === "AbortError") return aborted();
      result = { status: "error", message: "完整备份任务意外停止。", files: [] };
    }
    if (signal.aborted) return aborted();
    if (!retryableStatuses.has(result.status)) return result;
    if (attempt === 2) return { ...result, message: `${result.message} 已自动重试 2 次，仍未完成；可稍后手动继续。` };
    const retry = attempt + 1;
    const waitMs = retry * 5000;
    await onRetry({ retry, waitMs, result });
    try { await wait(waitMs, signal); }
    catch (error) { if (signal.aborted || error?.name === "AbortError") return aborted(); throw error; }
  }
}
