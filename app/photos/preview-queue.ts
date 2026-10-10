type PreviewJob = { priority: boolean; background: boolean; cancelled: () => boolean; start: () => Promise<void>; skip: () => void };
export type PreviewQueue = { pending: PreviewJob[]; active: number; limit: number; scheduled?: boolean };
const queues = new Set<PreviewQueue>();
let scrolling = false;
let backgroundReadyAt = 0;
let backgroundTimer: ReturnType<typeof setTimeout> | undefined;

function resumeBackgroundAfter(delay: number) {
  if (backgroundTimer !== undefined) return;
  backgroundTimer = setTimeout(() => {
    backgroundTimer = undefined;
    queues.forEach(queue => drainPreviewQueue(queue));
  }, delay);
}

export function deferBackgroundPreviews() {
  backgroundReadyAt = Math.max(backgroundReadyAt, Date.now() + 600);
  resumeBackgroundAfter(600);
}

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
      if (job.background) {
        if ([...queues].some(other => other.active > 0 || other.pending.some(entry => !entry.background && !entry.cancelled()))) return;
        const delay = backgroundReadyAt - Date.now();
        if (delay > 0) { resumeBackgroundAfter(delay); return; }
      }
      if (!idle) {
        if (!queue.scheduled) {
          queue.scheduled = true;
          const resume = (deadline?: IdleDeadline) => {
            queue.scheduled = false;
            if (queue.pending[0]?.background && deadline && (deadline.didTimeout || deadline.timeRemaining() < 8)) {
              backgroundReadyAt = Math.max(backgroundReadyAt, Date.now() + 100);
              drainPreviewQueue(queue);
              return;
            }
            drainPreviewQueue(queue, true);
          };
          if (typeof requestIdleCallback === "function") {
            // Background decoding waits for real idle time; only visible work
            // has a timeout that can force progress on a busy main thread.
            if (job.background) requestIdleCallback(resume);
            else requestIdleCallback(resume, { timeout: 250 });
          }
          else setTimeout(resume, 32);
        }
        return;
      }
    }
    queue.pending.shift();
    queue.active++;
    const startedAt = Date.now();
    void job.start().finally(() => {
      queue.active--;
      if (job.background) {
        // Give rendering and input a break after each speculative decode.
        const rest = Math.min(1000, Math.max(250, Date.now() - startedAt));
        backgroundReadyAt = Math.max(backgroundReadyAt, Date.now() + rest);
      }
      queues.forEach(other => drainPreviewQueue(other));
    });
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
