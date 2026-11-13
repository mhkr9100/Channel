// Runs the Channel server on this Mac only (127.0.0.1). Local mode unless SUPABASE_URL is set.
// In production it also serves the built screen.
import { serve } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import { localBackend, onlineBackend } from "./backend.ts";
import { createApi } from "./http.ts";

const port = Number(process.env.CHANNEL_PORT ?? 8787);
const backend = process.env.SUPABASE_URL ? onlineBackend() : localBackend(process.env.CHANNEL_DATA ?? "data", `http://127.0.0.1:${port}`);
const app = createApi(backend);

if (process.env.NODE_ENV === "production") {
  app.use("/*", serveStatic({ root: "public" }));
  app.get("*", serveStatic({ path: "public/index.html" }));
}

serve({ fetch: app.fetch, port, hostname: "127.0.0.1" }, (info) => {
  console.log(`Channel server (${backend.mode} mode) on http://127.0.0.1:${info.port}`);
});
