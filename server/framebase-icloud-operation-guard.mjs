export function icloudOperationKind(method, path) {
  if (method !== "POST") return null;
  if (["/api/icloud/backup/test", "/api/icloud/backup/full/start", "/api/icloud/backup/full/resume"].includes(path)) return "backup";
  if (["/api/icloud/release/delete", "/api/icloud/release/delete/preview", "/api/icloud/release/plan"].includes(path)) return "release";
  return null;
}

export function createIcloudOperationGuard({ backupRunning, releaseRunning }) {
  const pending = new Map();
  function acquire(username, kind) {
    const active = pending.get(username)?.kind || (backupRunning(username) ? "backup" : releaseRunning(username) ? "release" : null);
    if (active) {
      const error = active === "backup"
        ? kind === "backup" ? "当前用户已有 iCloud 备份任务正在运行，请等待完成或暂停后再试。" : "iCloud 备份正在运行，暂时不能释放或复核云端项目。请先暂停备份，等待状态显示“已暂停”后再试。"
        : kind === "backup" ? "iCloud 释放或复核正在运行，暂时不能开始或继续备份。请等待当前任务完成后再试。" : "当前用户已有 iCloud 释放或复核任务正在运行，请等待完成后再试。";
      return { error };
    }
    // Reserve before any await, including request parsing and plan validation.
    const reservation = { kind };
    pending.set(username, reservation);
    return { release: () => { if (pending.get(username) === reservation) pending.delete(username); } };
  }
  return { acquire };
}
