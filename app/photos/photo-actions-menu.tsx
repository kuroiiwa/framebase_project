"use client";

import { useId, useRef, useState } from "react";
import styles from "./photo-actions-menu.module.css";

export default function PhotoActionsMenu({ name, liked, cleanup, busy, onOpen, onFavorite, onCleanup, onDelete }: {
  name: string; liked: boolean; cleanup: boolean; busy: boolean;
  onOpen: () => void; onFavorite: () => void; onCleanup: () => void; onDelete: () => void;
}) {
  const id = useId();
  const [expanded, setExpanded] = useState(false);
  const menu = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  function toggle() {
    const panel = menu.current;
    const button = trigger.current;
    if (!panel || !button) return;
    if (panel.matches(":popover-open")) { panel.hidePopover(); return; }
    const rect = button.getBoundingClientRect();
    const width = Math.min(216, window.innerWidth - 24);
    panel.style.width = `${width}px`;
    panel.style.left = `${Math.max(12, Math.min(rect.right - width, window.innerWidth - width - 12))}px`;
    panel.style.top = `${Math.max(12, rect.bottom + 8 + 204 < window.innerHeight ? rect.bottom + 8 : rect.top - 212)}px`;
    panel.showPopover();
    panel.querySelector<HTMLButtonElement>("button:not(:disabled)")?.focus();
  }
  function choose(action: () => void) {
    menu.current?.hidePopover(); trigger.current?.focus(); action();
  }
  return <>
    <button ref={trigger} type="button" className={styles.trigger} aria-label={`图片操作：${name}`} title="图片操作" aria-haspopup="menu" aria-expanded={expanded} aria-controls={id} onClick={toggle}>⋯</button>
    <div ref={menu} id={id} popover="auto" className={styles.menu} role="menu" tabIndex={-1} aria-label={`${name} 的操作`} onToggle={() => setExpanded(Boolean(menu.current?.matches(":popover-open")))} onKeyDown={event => {
      const buttons = Array.from(menu.current?.querySelectorAll<HTMLButtonElement>("button:not(:disabled)") || []);
      const index = buttons.indexOf(document.activeElement as HTMLButtonElement);
      if (["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) {
        event.preventDefault();
        const next = event.key === "Home" ? 0 : event.key === "End" ? buttons.length - 1 : (index + (event.key === "ArrowDown" ? 1 : -1) + buttons.length) % buttons.length;
        buttons[next]?.focus();
      }
      if (event.key === "Escape") { event.preventDefault(); menu.current?.hidePopover(); trigger.current?.focus(); }
    }}>
      <button type="button" role="menuitem" onClick={() => choose(onOpen)}><span aria-hidden="true">▣</span>打开图片</button>
      <button type="button" role="menuitem" onClick={() => choose(onFavorite)}><span aria-hidden="true">{liked ? "♥" : "♡"}</span>{liked ? "取消收藏" : "收藏"}</button>
      <button type="button" role="menuitem" onClick={() => choose(onCleanup)}><span aria-hidden="true">{cleanup ? "✓" : "☷"}</span>{cleanup ? "移出待整理" : "加入待整理"}</button>
      <hr />
      <button type="button" role="menuitem" className={styles.danger} disabled={busy} onClick={() => choose(onDelete)}><span aria-hidden="true">⌫</span>删除…</button>
    </div>
  </>;
}
