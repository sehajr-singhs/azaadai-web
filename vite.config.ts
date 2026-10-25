import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Served from https://<user>.github.io/<repo>/, so assets need the repo base.
export default defineConfig({
  base: process.env.VITE_BASE ?? "/azaadai-web/",
  plugins: [react()],
  worker: { format: "es" },
  build: { target: "es2022" },
  optimizeDeps: { exclude: ["@mlc-ai/web-llm"] },
});
