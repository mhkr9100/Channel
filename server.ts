// Vercel entry (https://vercel.com/docs/frameworks/backend/hono): Vercel finds this file, which imports hono, and
// serves its default export as one function. It also serves the screen, packed into web-assets.ts at build time.
// Online mode only: needs the Supabase settings and OWNER_EMAIL (see src/server/backend.ts).
import type { Hono } from "hono";
import { createApi } from "./src/server/http.ts";
import { onlineBackend } from "./src/server/backend.ts";
import { WEB_FILES } from "./src/server/web-assets.ts";

const app = createApi(onlineBackend()) as unknown as Hono;

// The screen: exact files first, then index.html for any other page address (not for /api or /mcp).
app.get("*", (c) => {
  const path = c.req.path === "/" ? "/index.html" : c.req.path;
  const file = WEB_FILES[path] ?? (path.startsWith("/api/") || path === "/mcp" ? undefined : WEB_FILES["/index.html"]);
  if (!file) return c.text("Not found", 404);
  const body = file.base64 ? Buffer.from(file.body, "base64") : file.body;
  const cache = path.startsWith("/assets/") ? "public, max-age=31536000, immutable" : "no-cache";
  return c.body(body as never, 200, { "content-type": file.type, "cache-control": cache });
});

export default app;
