import { useCallback, useEffect, useState } from "react";
import { flushSync } from "react-dom";

export type Theme = "dark" | "light";

/* index.html reads the same key before first paint; keep the two in step. */
const STORAGE_KEY = "dotabuff-picker.theme";
const LIGHT_QUERY = "(prefers-color-scheme: light)";
const THEME_COLOR: Record<Theme, string> = { dark: "#0f1419", light: "#e9eef3" };

function readStored(): Theme | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw === "dark" || raw === "light" ? raw : null;
  } catch {
    return null;
  }
}

function systemTheme(): Theme {
  return window.matchMedia(LIGHT_QUERY).matches ? "light" : "dark";
}

function applyTheme(theme: Theme) {
  document.documentElement.dataset.theme = theme;
  document.querySelector('meta[name="theme-color"]')?.setAttribute("content", THEME_COLOR[theme]);
}

/**
 * Follows the system until the reader picks a theme, then keeps their pick.
 * `origin` is where the reveal circle opens from, in viewport pixels.
 */
export function useTheme() {
  const [stored, setStored] = useState<Theme | null>(readStored);
  const [system, setSystem] = useState<Theme>(systemTheme);
  const theme = stored ?? system;

  useEffect(() => {
    const query = window.matchMedia(LIGHT_QUERY);
    const onChange = () => setSystem(query.matches ? "light" : "dark");
    query.addEventListener("change", onChange);
    return () => query.removeEventListener("change", onChange);
  }, []);

  useEffect(() => applyTheme(theme), [theme]);

  const toggle = useCallback(
    (origin?: { x: number; y: number }) => {
      const next: Theme = theme === "dark" ? "light" : "dark";
      try {
        localStorage.setItem(STORAGE_KEY, next);
      } catch {
        /* ignore */
      }
      // The view transition snapshots the page when the callback returns, so
      // the new theme has to be on the DOM by then rather than after an effect.
      const commit = () => {
        flushSync(() => setStored(next));
        applyTheme(next);
      };
      const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
      if (!document.startViewTransition || reduceMotion) {
        commit();
        return;
      }
      if (origin) {
        const root = document.documentElement.style;
        const radius = Math.hypot(
          Math.max(origin.x, window.innerWidth - origin.x),
          Math.max(origin.y, window.innerHeight - origin.y),
        );
        root.setProperty("--theme-x", `${origin.x}px`);
        root.setProperty("--theme-y", `${origin.y}px`);
        root.setProperty("--theme-r", `${radius}px`);
      }
      // A transition skipped part-way (say, by a window resize) still runs
      // `commit`; only the animation is lost, so the rejection is not an error.
      document.startViewTransition(commit).ready.catch(() => {});
    },
    [theme],
  );

  return { theme, toggle };
}
