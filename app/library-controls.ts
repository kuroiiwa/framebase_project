export function selectRange(selected: Set<string>, order: string[], anchor: string | null, id: string, extend: boolean) {
  const next = new Set(selected);
  const start = anchor === null ? -1 : order.indexOf(anchor);
  const end = order.indexOf(id);
  if (extend && start >= 0 && end >= 0) {
    order.slice(Math.min(start, end), Math.max(start, end) + 1).forEach(key => next.add(key));
  } else if (next.has(id)) next.delete(id);
  else next.add(id);
  return next;
}

export class ScanControl {
  paused = false;
  cancelled = false;
  async checkpoint() {
    while (this.paused && !this.cancelled) await new Promise(resolve => setTimeout(resolve, 100));
    if (this.cancelled) throw new DOMException("任务已取消", "AbortError");
  }
}
