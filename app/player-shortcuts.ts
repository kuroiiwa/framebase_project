import { useEffect, type RefObject } from "react";

export function usePlayerShortcuts(active: boolean, ref: RefObject<HTMLVideoElement | null>, close: () => void) {
  useEffect(() => {
    if (!active) return;
    const handle = (event: KeyboardEvent) => handlePlaybackKey(event, ref.current, close);
    window.addEventListener("keydown", handle, true);
    return () => window.removeEventListener("keydown", handle, true);
  }, [active, ref, close]);
}

export function handlePlaybackKey(event: KeyboardEvent, video: HTMLVideoElement | null, close: () => void) {
      if (event.altKey || event.ctrlKey || event.metaKey || event.isComposing) return;
      const target = event.target;
      if (target instanceof HTMLElement && (target.isContentEditable || target.closest('textarea,select,input:not([type="range"])'))) return;
      if (!video || !["Escape", " ", "ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "m", "M", "f", "F"].includes(event.key)) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      if (event.key === "Escape") {
        if (document.fullscreenElement) void document.exitFullscreen().catch(() => undefined);
        else close();
      } else if (event.key === " " && !event.repeat) {
        if (video.paused) void video.play().catch(() => undefined); else video.pause();
      } else if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
        video.currentTime = Math.max(0, Math.min(Number.isFinite(video.duration) ? video.duration : Infinity, video.currentTime + (event.key === "ArrowLeft" ? -10 : 10)));
      } else if (event.key === "ArrowUp" || event.key === "ArrowDown") {
        video.volume = Math.max(0, Math.min(1, Math.round((video.volume + (event.key === "ArrowUp" ? .05 : -.05)) * 100) / 100));
        video.muted = false;
      } else if (event.key.toLowerCase() === "m" && !event.repeat) video.muted = !video.muted;
      else if (event.key.toLowerCase() === "f" && !event.repeat) {
        if (document.fullscreenElement) void document.exitFullscreen().catch(() => undefined);
        else void video.requestFullscreen?.().catch(() => undefined);
      }
}
