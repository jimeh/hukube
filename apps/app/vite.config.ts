import { fileURLToPath } from "node:url";

import tailwindcss from "@tailwindcss/vite";
import { tanstackRouter } from "@tanstack/router-plugin/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// The Engine the dev server proxies the control socket to, so the UI always
// reaches it on its own origin, from this machine or another one.
const engineUrl = process.env["HUKUBE_ENGINE_URL"] ?? "http://127.0.0.1:7443";
// Extra hostnames the dev server answers to, such as a tailnet name.
const allowedHosts = (process.env["HUKUBE_DEV_ALLOWED_HOSTS"] ?? "")
  .split(",")
  .map((host) => host.trim())
  .filter(Boolean);

export default defineConfig({
  plugins: [tanstackRouter({ target: "react", autoCodeSplitting: true }), react(), tailwindcss()],
  resolve: {
    alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) },
  },
  worker: { format: "es" },
  server: {
    port: 5173,
    strictPort: true,
    allowedHosts,
    // Keeps the browser's Host header, so the Engine's same-origin check passes.
    proxy: { "/ws": { target: engineUrl, ws: true } },
  },
  build: { target: "chrome130" },
});
