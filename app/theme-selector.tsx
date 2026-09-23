"use client";

import { useEffect, useState } from "react";

const themes = { light: "经典青柠 · 浅色", dark: "经典青柠 · 深色", latte: "晴空浅蓝", mocha: "午夜紫" };
type Theme = keyof typeof themes;
function applyTheme(theme: Theme) {
  document.documentElement.dataset.theme = theme === "mocha" || theme === "dark" ? "dark" : "light";
  document.documentElement.dataset.palette = theme;
}
export default function ThemeSelector() {
  const [theme, setTheme] = useState<Theme>("light");
  useEffect(() => {
    function restore() {
      let saved: string | null = null;
      try { saved = localStorage.getItem("framebase-theme"); } catch { /* Storage may be unavailable. */ }
      const value: Theme = saved && Object.hasOwn(themes, saved) ? saved as Theme : matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
      applyTheme(value);
      setTheme(value);
    }
    restore();
    window.addEventListener("storage", restore);
    return () => window.removeEventListener("storage", restore);
  }, []);
  return <select className="theme-selector" aria-label="配色主题" value={theme} onChange={event => {
    const value = event.target.value as Theme;
    setTheme(value); applyTheme(value);
    try { localStorage.setItem("framebase-theme", value); } catch { /* The current selection still works. */ }
  }}>{Object.entries(themes).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select>;
}
