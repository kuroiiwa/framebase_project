"use client";

import { useEffect, useRef, useState, type ReactNode, type PointerEvent } from "react";
import { intersectingPhotos, mergeDragSelection, selectionRect, type SelectionRect } from "./drag-selection";
import styles from "./photos.module.css";

type Drag = { pointerId: number; startX: number; startY: number; clientX: number; clientY: number; initial: string[]; remove: boolean; active: boolean; last: string[] };

export default function PhotoSelectionGrid({ enabled, selectedIds, limit, onChange, className, children }: { enabled: boolean; selectedIds: string[]; limit: number; onChange(ids: string[]): void; className: string; children: ReactNode }) {
  const gridRef = useRef<HTMLElement>(null);
  const dragRef = useRef<Drag | null>(null);
  const frameRef = useRef(0);
  const suppressClick = useRef(false);
  const [box, setBox] = useState<SelectionRect | null>(null);
  useEffect(() => () => {
    cancelAnimationFrame(frameRef.current);
    dragRef.current = null;
    setBox(null);
  }, [enabled]);

  function updateSelection(scroll = false) {
    const drag = dragRef.current; const grid = gridRef.current;
    if (!drag?.active || !grid) return;
    if (scroll) {
      const edge = 64;
      const amount = drag.clientY < edge ? -Math.ceil((edge - drag.clientY) / 5) : drag.clientY > window.innerHeight - edge ? Math.ceil((drag.clientY - window.innerHeight + edge) / 5) : 0;
      if (amount) window.scrollBy(0, Math.max(-18, Math.min(18, amount)));
    }
    const rect = selectionRect(drag.startX, drag.startY, drag.clientX + window.scrollX, drag.clientY + window.scrollY);
    const cards = [...grid.querySelectorAll<HTMLElement>("[data-photo-id]")].map(card => {
      const bounds = card.getBoundingClientRect();
      return { id: card.dataset.photoId!, rect: { left: bounds.left + window.scrollX, right: bounds.right + window.scrollX, top: bounds.top + window.scrollY, bottom: bounds.bottom + window.scrollY } };
    });
    const next = mergeDragSelection(drag.initial, intersectingPhotos(rect, cards), drag.remove, limit);
    if (next.length !== drag.last.length || next.some((id, index) => id !== drag.last[index])) { drag.last = next; onChange(next); }
    const nextBox = { left: rect.left - window.scrollX, right: rect.right - window.scrollX, top: rect.top - window.scrollY, bottom: rect.bottom - window.scrollY };
    setBox(previous => previous && previous.left === nextBox.left && previous.right === nextBox.right && previous.top === nextBox.top && previous.bottom === nextBox.bottom ? previous : nextBox);
  }
  function animate() {
    updateSelection(true);
    if (dragRef.current?.active) frameRef.current = requestAnimationFrame(animate);
  }
  function finish(event: PointerEvent<HTMLElement>, cancelled = false) {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    if (drag.active && !cancelled) { drag.clientX = event.clientX; drag.clientY = event.clientY; updateSelection(); }
    if (drag.active && cancelled) onChange(drag.initial);
    suppressClick.current = drag.active;
    dragRef.current = null; cancelAnimationFrame(frameRef.current); setBox(null);
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
  }
  return <section ref={gridRef} className={`${className} ${enabled ? styles.dragSelectable : ""}`}
    onPointerDown={event => {
      suppressClick.current = false;
      if (!enabled || event.pointerType !== "mouse" || event.button !== 0 || !event.isPrimary) return;
      const target = event.target as HTMLElement;
      // Thumbnail buttons may start a drag; checkboxes and action menus retain their own gestures.
      if (target.closest("input, label, a, button:not([data-photo-thumb]), [role=menu]")) return;
      const card = target.closest<HTMLElement>("[data-photo-id]");
      dragRef.current = { pointerId: event.pointerId, startX: event.clientX + window.scrollX, startY: event.clientY + window.scrollY, clientX: event.clientX, clientY: event.clientY, initial: [...selectedIds], remove: Boolean(card && selectedIds.includes(card.dataset.photoId!)), active: false, last: [...selectedIds] };
    }}
    onPointerMove={event => {
      const drag = dragRef.current;
      if (!drag || drag.pointerId !== event.pointerId) return;
      drag.clientX = event.clientX; drag.clientY = event.clientY;
      if (!drag.active && Math.hypot(event.clientX + window.scrollX - drag.startX, event.clientY + window.scrollY - drag.startY) > 6) {
        drag.active = true; event.currentTarget.setPointerCapture(event.pointerId); frameRef.current = requestAnimationFrame(animate);
      }
      if (drag.active) event.preventDefault();
    }}
    onPointerUp={event => finish(event)} onPointerCancel={event => finish(event, true)}
    onLostPointerCapture={event => finish(event, true)}
    onDragStart={event => { if (enabled) event.preventDefault(); }}
    onClickCapture={event => { if (suppressClick.current) { event.preventDefault(); event.stopPropagation(); suppressClick.current = false; } }}>
    {children}
    {enabled && box && <div className={styles.selectionBox} style={{ left: box.left, top: box.top, width: box.right - box.left, height: box.bottom - box.top }} />}
  </section>;
}
