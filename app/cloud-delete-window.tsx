"use client";

import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { CloudDeleteProgress, type CloudDeleteJob } from "./icloud-delete-progress";
import styles from "./photos/photos.module.css";
import actions from "./media-actions.module.css";

export default function CloudDeleteWindow({ job, onClose }: { job: CloudDeleteJob; onClose: () => void }) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const [mini, setMini] = useState(false);
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    if (job.status !== "running") return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [job.status]);
  useLayoutEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    if (mini) dialog.show(); else dialog.showModal();
    return () => dialog.close();
  }, [mini]);
  const elapsed = job.status === "running" && job.startedAt ? Math.max(0, Math.floor((now - job.startedAt) / 1000)) : job.elapsedSeconds;
  return <dialog ref={dialogRef} className={`${styles.deleteDialog} ${mini ? styles.deleteMini : ""}`} aria-modal={!mini} aria-labelledby="video-cloud-delete-title" onCancel={event => {
    event.preventDefault();
    if (job.status === "running") setMini(true); else onClose();
  }}>
    <header className={styles.deleteHeader}><div><h2 id="video-cloud-delete-title">{job.preview ? "视频删除前复核" : "视频删除进度"}</h2><p>{job.status === "running" ? "任务在后台继续，可缩小后浏览视频库。" : "操作已结束，请查看结果。"}</p></div><button className={actions.button} onClick={() => setMini(value => !value)}>{mini ? "恢复" : "缩小"}</button></header>
    <div className={styles.deleteBody}><CloudDeleteProgress job={job} elapsedSeconds={elapsed} /></div>
    <div className={styles.deleteActions}>{job.status === "running" ? <button className={actions.button} onClick={() => setMini(true)}>后台继续</button> : <button className={actions.button} onClick={onClose}>关闭</button>}</div>
  </dialog>;
}
