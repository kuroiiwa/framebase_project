export type TimeGranularity = "years" | "quarters" | "months";
type DatedPhoto = { path: string; sourceName: string; modified: number };

export function photoTimeKeys(item: DatedPhoto): Record<TimeGranularity, string> | null {
  // Backup directory dates survive copying and match the iCloud backup ranges.
  const path = `${item.sourceName}/${item.path}`.replaceAll("\\", "/");
  const match = /(?:^|\/)((?:19|20)\d{2})\/(0?[1-9]|1[0-2])(?=\/)/.exec(path);
  const modified = new Date(item.modified);
  const year = match ? Number(match[1]) : modified.getFullYear();
  const month = match ? Number(match[2]) : modified.getMonth() + 1;
  if (!match && (!Number.isFinite(item.modified) || item.modified <= 0 || Number.isNaN(modified.getTime()))) return null;
  return { years: String(year), quarters: `${year}-Q${Math.ceil(month / 3)}`, months: `${year}-${String(month).padStart(2, "0")}` };
}

export function timePeriodLabel(key: string, granularity: TimeGranularity) {
  if (key === "unknown") return "时间未知";
  if (granularity === "years") return `${key} 年`;
  if (granularity === "quarters") { const [year, quarter] = key.split("-Q"); return `${year} 年第 ${quarter} 季度`; }
  const [year, month] = key.split("-");
  return `${year} 年 ${Number(month)} 月`;
}

export function matchesPhotoTime(keys: Record<TimeGranularity, string> | null, granularity: TimeGranularity, selected: string[]) {
  return selected.length === 0 || selected.includes(keys?.[granularity] || "unknown");
}
