export type ReleaseFailure = { relativePath: string; reason?: string };

export function repairBackupMonths(failures: ReleaseFailure[], availableMonths: string[]) {
  const available = new Set(availableMonths);
  const selected = new Set<string>();
  const unavailable = new Set<string>();
  let unknownCount = 0;
  for (const file of failures) {
    const match = /^((?:19|20|21)\d{2})\/(0[1-9]|1[0-2])\/(0[1-9]|[12]\d|3[01])\//.exec(file.relativePath.replaceAll("\\", "/"));
    if (!match) { unknownCount += 1; continue; }
    const [, year, month, day] = match;
    const date = new Date(Date.UTC(Number(year), Number(month) - 1, Number(day)));
    if (date.getUTCMonth() !== Number(month) - 1) { unknownCount += 1; continue; }
    const key = `${year}-${month}`;
    (available.has(key) ? selected : unavailable).add(key);
  }
  return { months: [...selected].sort(), unavailableMonths: [...unavailable].sort(), unknownCount };
}

export function releaseFailureAdvice(reason = "") {
  if (/ENOENT|no such file|文件不存在/i.test(reason)) return {
    label: "本地文件缺失",
    guidance: "备份清单仍记录此文件，但原路径下已找不到。若曾手动删除，请从 Windows 回收站恢复到原路径；若已移动或改名，请放回原位置。无法恢复时，重新备份该日期范围。",
  };
  if (/文件大小不一致|SHA-256 不一致/.test(reason)) return {
    label: "文件内容与备份记录不一致",
    guidance: "文件大小或内容已变化。请保留当前文件的副本，再恢复已验证的原片，或重新备份该日期范围。",
  };
  if (/文件在校验过程中发生变化/.test(reason)) return {
    label: "复核期间文件发生变化",
    guidance: "等待复制或下载完成，关闭正在编辑此文件的软件，再重新复核。",
  };
  if (/EACCES|EPERM|EBUSY|权限|占用/i.test(reason)) return {
    label: "文件无法读取",
    guidance: "检查备份磁盘是否连接、文件读取权限和占用情况，关闭占用文件的软件后重新复核。",
  };
  return { label: "文件复核失败", guidance: "检查下方错误详情及备份目录。修复原文件后重新复核；无法恢复时，重新备份对应日期范围。" };
}
