import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import App from "./App";
import "./styles.css";

/*
 * Two facts the stylesheet needs and cannot ask for: whether this is the
 * desktop shell, and whether it is running on macOS. Both are in the user
 * agent, which is why they are read here rather than passed over a preload
 * bridge — the desktop window deliberately has no bridge.
 */
const root = document.documentElement;
if (/Electron\//.test(navigator.userAgent)) root.dataset.shell = "desktop";
if (/Mac OS X|Macintosh/.test(navigator.userAgent)) root.dataset.os = "mac";

const container = document.getElementById("root");
if (!container) throw new Error("#root is missing from index.html");

createRoot(container).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
