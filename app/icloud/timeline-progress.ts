type TimelineProgressJob = { status: string; phase: string; message: string };

export function timelineProgress(job: TimelineProgressJob) {
  // Library index identifies the active library, not how much has finished.
  // The provider buffers each scan, so no overall percentage is available.
  if (job.status === "completed") return { label: "100%", stage: "统计完成", indeterminate: false, value: 100 };
  if (job.status === "failed") return { label: "未完成", stage: "统计未完成", indeterminate: false, value: undefined };
  const stage = job.phase === "discovering" ? "发现图库"
    : job.phase === "recovering" || /反向补扫/.test(job.message) ? "反向补扫"
    : job.phase === "aggregating" ? "生成统计"
    : job.phase === "completed" ? "保存统计"
    : job.phase === "starting" ? "准备连接" : "读取元数据";
  return { label: stage, stage, indeterminate: true, value: undefined };
}
