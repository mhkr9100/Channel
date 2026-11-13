// The web API the screen uses. Only this Mac can reach it (the server listens on 127.0.0.1), and two more
// guards stop other web pages from driving it:
//   - the Host header must be a loopback name (blocks "DNS rebinding", where a site points its own name at 127.0.0.1)
//   - every request that changes something must carry the header "x-channel: 1"; a browser will not let another
//     site add a custom header to a request here without asking this server first, and this server never agrees.
import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import type { Engine, ChannelEvent } from "./engine.ts";
import { A2AError } from "./a2a.ts";

const LOOPBACK = /^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/i;

export function createApi(engine: Engine) {
  const app = new Hono();
  const store = engine.store;

  app.use("/api/*", async (c, next) => {
    if (!LOOPBACK.test(c.req.header("host") ?? "")) return c.json({ error: "Channel only answers on this Mac." }, 403);
    if (c.req.method !== "GET" && c.req.header("x-channel") !== "1") return c.json({ error: "Missing x-channel header." }, 403);
    await next();
  });

  app.onError((e, c) => {
    const status = e instanceof A2AError ? 502 : 400;
    return c.json({ error: e.message }, status);
  });

  const body = async <T>(c: { req: { json: () => Promise<unknown> } }) => ((await c.req.json().catch(() => ({}))) ?? {}) as T;

  // ---- agents (tokens are never returned) ----
  app.get("/api/agents", (c) => c.json(store.listAgents().map((a) => ({ ...a, hasToken: !!store.tokenFor(a.id) }))));
  app.post("/api/agents", async (c) => {
    const b = await body<{ url?: string; token?: string; handle?: string }>(c);
    if (!b.url || !/^https?:\/\//.test(b.url)) return c.json({ error: "Enter the agent's address, starting with http:// or https://." }, 400);
    const agent = await engine.addAgent(b.url.trim(), b.token?.trim() || undefined, b.handle?.trim() || undefined);
    return c.json(agent, 201);
  });
  app.delete("/api/agents/:id", (c) => {
    engine.removeAgent(c.req.param("id"));
    return c.json({ ok: true });
  });

  // ---- chats ----
  app.get("/api/chats", (c) => c.json(store.listChats()));
  app.post("/api/chats", async (c) => {
    const b = await body<{ title?: string; agentIds?: string[] }>(c);
    return c.json(engine.createChat(b.title ?? "", b.agentIds ?? []), 201);
  });
  app.patch("/api/chats/:id", async (c) => {
    const b = await body<{ title?: string; auto?: boolean; hopLimit?: number }>(c);
    engine.updateChat(Number(c.req.param("id")), b);
    return c.json(store.getChat(Number(c.req.param("id"))));
  });
  app.delete("/api/chats/:id", (c) => {
    store.deleteChat(Number(c.req.param("id")));
    engine.emit("event", { type: "chats" } satisfies ChannelEvent);
    return c.json({ ok: true });
  });
  app.get("/api/chats/:id/messages", (c) => c.json(store.messages(Number(c.req.param("id")))));
  app.post("/api/chats/:id/messages", async (c) => {
    const b = await body<{ text?: string }>(c);
    const { message } = engine.postUserMessage(Number(c.req.param("id")), b.text ?? "");
    return c.json(message, 201);
  });
  app.post("/api/chats/:id/stop", (c) => {
    engine.stop(Number(c.req.param("id")));
    return c.json({ ok: true });
  });
  app.post("/api/handoffs/:id", async (c) => {
    const b = await body<{ action?: "send" | "skip"; text?: string }>(c);
    if (b.action !== "send" && b.action !== "skip") return c.json({ error: "action must be send or skip" }, 400);
    engine.resolveHandoff(Number(c.req.param("id")), b.action, b.text);
    return c.json({ ok: true });
  });

  // ---- live updates: one open connection the server writes events to ----
  app.get("/api/events", (c) =>
    streamSSE(c, async (stream) => {
      const queue: ChannelEvent[] = [];
      let wake: (() => void) | null = null;
      const onEvent = (e: ChannelEvent) => { queue.push(e); wake?.(); };
      engine.on("event", onEvent);
      stream.onAbort(() => { engine.off("event", onEvent); wake?.(); });
      await stream.writeSSE({ event: "ready", data: "{}" });
      while (!stream.aborted) {
        if (!queue.length) {
          await Promise.race([new Promise<void>((r) => (wake = r)), stream.sleep(25_000)]);
          wake = null;
          if (!queue.length && !stream.aborted) await stream.writeSSE({ event: "ping", data: "{}" });
          continue;
        }
        const e = queue.shift()!;
        await stream.writeSSE({ event: e.type, data: JSON.stringify(e) });
      }
    }),
  );

  return app;
}
