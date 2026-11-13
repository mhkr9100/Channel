// Starts the Channel server on this Mac only (127.0.0.1). In production it also serves the built screen.
import { serve } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import { Store } from "./store.ts";
import { Engine } from "./engine.ts";
import { createApi } from "./http.ts";

const port = Number(process.env.CHANNEL_PORT ?? 8787);
const store = new Store(process.env.CHANNEL_DATA ?? "data");
const engine = new Engine(store);
const app = createApi(engine);

if (process.env.NODE_ENV === "production") {
  app.use("/*", serveStatic({ root: "dist/web" }));
  app.get("*", serveStatic({ path: "dist/web/index.html" }));
}

serve({ fetch: app.fetch, port, hostname: "127.0.0.1" }, (info) => {
  console.log(`Channel server on http://127.0.0.1:${info.port}`);
});
