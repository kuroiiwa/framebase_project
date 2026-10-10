type PreviewJob = { priority: boolean; background: boolean; cancelled: () => boolean; start: () => Promise<void>; skip: () => void };
export type PreviewQueue = { pending: PreviewJob[]; active: number; limit: number; scheduled?: boolean };
const queues = new Set<PreviewQueue>();
let scrolling = false;

export function setPreviewScrolling(value: boolean) {
  scrolling = value;
  if (!value) queues.forEach(queue => drainPreviewQueue(queue));
}

function drainPreviewQueue(queue: PreviewQueue, idle = false) {
  while (queue.pending.length && queue.active < queue.limit) {
    const job = queue.pending[0];
    if (job.cancelled()) { queue.pending.shift(); job.skip(); continue; }
    if (!job.priority) {
      if (scrolling) return;
      // Speculative work yields to visible thumbnails in either codec queue.
      if (job.background && [...queues].some(other => other !== queue && (other.active > 0 || other.pending.some(entry => !entry.background && !entry.cancelled())))) return;
      if (!idle) {
        if (!queue.scheduled) {
          queue.scheduled = true;
          const resume = () => { queue.scheduled = false; drainPreviewQueue(queue, true); };
          if (typeof requestIdleCallback === "function") requestIdleCallback(resume, { timeout: 250 });
          else setTimeout(resume, 32);
        }
        return;
      }
    }
    queue.pending.shift();
    queue.active++;
    void job.start().finally(() => { queue.active--; queues.forEach(other => drainPreviewQueue(other)); });
    // Start one thumbnail per idle turn, giving scrolling and painting time between jobs.
    idle = false;
  }
}

export function schedulePreview<T>(queue: PreviewQueue, task: () => Promise<T>, cancelled: () => boolean, priority = false, background = false) {
  queues.add(queue);
  return new Promise<T | null>((resolve, reject) => {
    const job: PreviewJob = {
      priority, background, cancelled, skip: () => resolve(null),
      start: async () => {
        try { const result = await task(); resolve(cancelled() ? null : result); }
        catch (error) { if (cancelled()) resolve(null); else reject(error); }
      },
    };
    if (priority) queue.pending.unshift(job);
    else if (background) queue.pending.push(job);
    else {
      const index = queue.pending.findIndex(entry => entry.background);
      queue.pending.splice(index < 0 ? queue.pending.length : index, 0, job);
    }
    drainPreviewQueue(queue);
  });
}
