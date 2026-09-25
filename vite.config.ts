import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  base: "./",
  // A preview pane that starts the server hands it a free port in PORT and has
  // its own browser, so parallel worktrees neither collide nor pop a tab open.
  server: process.env.PORT
    ? { port: Number(process.env.PORT), strictPort: true, open: false }
    : { port: 5180, open: true },
  build: { outDir: "dist", target: "es2022" },
});
