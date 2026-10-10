"use client";

import { useEffect, useId, useRef, useState } from "react";
import { createPortal } from "react-dom";
import styles from "./icloud.module.css";

const steps = [
  { label: "设置目录", title: "设置备份目录", description: "选择保存原片的文件夹，也可以手动输入绝对路径。系统会为当前账户创建独立备份目录。", note: "先设置目录，再配置 iCloud 连接。" },
  { label: "连接账户", title: "连接 iCloud", description: "填写 Apple ID 和服务区域，保存连接配置，再验证已有会话；需要登录时按提示完成 Apple 登录。", note: "连接验证不会下载或删除照片。" },
  { label: "选择时间", title: "统计并选择时间", description: "先刷新云端统计，再按年份、季度或月份选择备份范围。", note: "此步骤只读取元数据，不下载或删除文件。" },
  { label: "备份校验", title: "备份与完整性校验", description: "点击“备份所选范围”，或在此处开始完整备份。任务会下载原片、校验文件并保存清单；可以暂停或继续。", note: "下载进度达到 100% 后仍需完成校验。备份任务不会删除云端内容。" },
  { label: "容量释放", title: "复核与容量释放", description: "备份校验完成后生成只读释放计划，查看精确匹配结果，再前往图片库选择删除范围。", note: "实际删除按当前账户的复核与确认设置执行；报错时停止。移入“最近删除”后仍保留恢复窗口。" },
];

export default function IcloudTutorial({ onClose }: { onClose: () => void }) {
  const [step, setStep] = useState(0);
  const [rect, setRect] = useState({ x: 0, y: 0, width: 0, height: 0 });
  const [panelLeft, setPanelLeft] = useState<number>();
  const panelRef = useRef<HTMLDivElement>(null);
  const maskId = useId().replace(/:/g, "");
  const current = steps[step];

  useEffect(() => {
    const previousFocus = document.activeElement as HTMLElement | null;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    panelRef.current?.querySelector<HTMLButtonElement>("button")?.focus();
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") { event.preventDefault(); onClose(); }
      if (event.key !== "Tab") return;
      const controls = Array.from(document.querySelectorAll<HTMLButtonElement>('[data-icloud-tutorial] button:not(:disabled):not([tabindex="-1"])'));
      const first = controls[0];
      const last = controls.at(-1);
      if (event.shiftKey && (document.activeElement === first || !controls.includes(document.activeElement as HTMLButtonElement))) { event.preventDefault(); last?.focus(); }
      else if (!event.shiftKey && (document.activeElement === last || !controls.includes(document.activeElement as HTMLButtonElement))) { event.preventDefault(); first?.focus(); }
    };
    document.addEventListener("keydown", onKeyDown);
    return () => { document.body.style.overflow = previousOverflow; document.removeEventListener("keydown", onKeyDown); previousFocus?.focus(); };
  }, [onClose]);

  useEffect(() => {
    const target = document.querySelector<HTMLElement>(`[data-icloud-step="${step + 1}"]`);
    if (!target) return;
    let frame = 0;
    const measure = () => {
      const bounds = target.getBoundingClientRect();
      setRect({ x: bounds.left - 5, y: bounds.top - 5, width: bounds.width + 10, height: bounds.height + 10 });
      const panelWidth = Math.min(360, window.innerWidth - 32);
      setPanelLeft(bounds.right + panelWidth + 24 <= window.innerWidth ? bounds.right + 18 : bounds.left >= panelWidth + 24 ? bounds.left - panelWidth - 18 : window.innerWidth - panelWidth - 16);
    };
    const schedule = () => { cancelAnimationFrame(frame); frame = requestAnimationFrame(measure); };
    target.scrollIntoView({ block: "center", behavior: "instant" });
    schedule();
    const observer = new ResizeObserver(schedule);
    observer.observe(target);
    window.addEventListener("resize", schedule);
    window.addEventListener("scroll", schedule, true);
    return () => { cancelAnimationFrame(frame); observer.disconnect(); window.removeEventListener("resize", schedule); window.removeEventListener("scroll", schedule, true); };
  }, [step]);

  return createPortal(<div className={styles.tutorialOverlay} data-icloud-tutorial role="dialog" aria-modal="true" aria-labelledby="icloud-tutorial-title">
    <svg className={styles.tutorialMask} width="100%" height="100%" aria-hidden="true"><defs><mask id={maskId}><rect width="100%" height="100%" fill="white" /><rect x={rect.x} y={rect.y} width={rect.width} height={rect.height} rx="12" fill="black" /></mask></defs><rect width="100%" height="100%" fill="black" opacity=".58" mask={`url(#${maskId})`} /><rect x={rect.x} y={rect.y} width={rect.width} height={rect.height} rx="12" fill="none" stroke="var(--lime)" strokeWidth="2" /></svg>
    <button className={styles.tutorialBackdrop} onClick={onClose} tabIndex={-1} aria-label="关闭教程蒙版" />
    <div ref={panelRef} className={styles.tutorialPanel} style={{ left: panelLeft }}>
      <button className={styles.tutorialClose} onClick={onClose} aria-label="关闭使用教程">×</button>
      <h2 id="icloud-tutorial-title"><span className={styles.stepNumber}>{step + 1}</span>{current.title}</h2>
      <div aria-live="polite"><p>{current.description}</p><small>{current.note}</small></div>
      <footer><span>步骤 {step + 1} / {steps.length}</span><button disabled={step === 0} onClick={() => setStep(value => value - 1)}>上一步</button><button className={styles.tutorialNext} onClick={() => step === steps.length - 1 ? onClose() : setStep(value => value + 1)}>{step === steps.length - 1 ? "完成教程" : "下一步"}</button></footer>
    </div>
    <nav className={styles.tutorialSteps} aria-label="教程步骤">{steps.map((item, index) => <button key={item.label} aria-current={step === index ? "step" : undefined} onClick={() => setStep(index)}><span>{index + 1}</span>{item.label}</button>)}<small>可随时关闭，不影响正在运行的任务 · Esc 关闭</small></nav>
  </div>, document.body);
}
