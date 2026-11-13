import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// The screen lives in src/web. In development Vite serves it on port 5173 and forwards /api to the
// Channel server on 8787. In production the server serves the built files itself.
export default defineConfig({
  root: "src/web",
  plugins: [react()],
  server: {
    host: "127.0.0.1",
    port: 5173,
    strictPort: true,
    // "^/api/" (not "/api"), so the screen's own src/web/api.ts is not forwarded too.
    proxy: { "^/api/": { target: "http://127.0.0.1:8787", changeOrigin: false } },
  },
  build: { outDir: "../../public", emptyOutDir: true },
});
