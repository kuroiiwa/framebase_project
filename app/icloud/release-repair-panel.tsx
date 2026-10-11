import { releaseFailureAdvice, type ReleaseFailure } from "./release-repair";
import styles from "./icloud.module.css";

export default function ReleaseRepairPanel({ failures, failedCount, backupDirectory, busy, onRecheck, onSelectBackup }: {
  failures: ReleaseFailure[]; failedCount: number; backupDirectory?: string | null; busy: boolean; onRecheck: () => void; onSelectBackup: () => void;
}) {
  return <section className={styles.releaseRepair} aria-label="复核失败修复指引">
    <h3>修复本地备份后重新复核</h3>
    <p>以下文件未通过复核，当前释放计划禁止删除 iCloud 内容。手动删除文件后，备份清单仍保留历史记录；重新统计云端内容不能恢复缺失的本地文件。</p>
    {backupDirectory && <p>备份目录：<code>{backupDirectory}</code></p>}
    <ol>
      <li>查看下方失败文件及原因。缺失的 MOV 也可能是实况照片的配对视频，只有图片仍在不能替代视频备份。</li>
      <li>从 Windows 回收站恢复，或将移动、改名的文件放回列出的原路径。无法恢复时，点击“自动选择需修复月份”，再点击“备份所选范围”，等待备份完成。月份是当前支持的最小备份分区。</li>
      <li>点击“修复后重新复核”。全部通过后，才可继续确认释放计划；此按钮只复核，不执行删除。</li>
    </ol>
    <p>如果这些文件是刻意删除且不打算重新备份，当前计划会继续被阻止，以保留云端内容。</p>
    <details open><summary>查看失败文件（{failedCount} 个）</summary>
      <ul>{failures.map(file => { const advice = releaseFailureAdvice(file.reason); return <li key={file.relativePath}>
        <strong>{file.relativePath}</strong><span>{advice.label}</span><p>{advice.guidance}</p>
        <details><summary>原始错误详情</summary><code>{file.reason || "未提供错误详情"}</code></details>
      </li>; })}</ul>
      {failedCount > failures.length && <small>当前显示 {failures.length} / {failedCount} 个失败文件；修复后再次复核可查看剩余问题。</small>}
    </details>
    <div className={styles.actions}>
      <button disabled={busy} onClick={onSelectBackup}>自动选择需修复月份</button>
      <button disabled={busy} onClick={onRecheck}>修复后重新复核</button>
    </div>
  </section>;
}
