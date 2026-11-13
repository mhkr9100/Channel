// The web API. Three kinds of caller, each with its own key:
//   - you, through the screen: local mode needs no login but only answers on this Mac; online mode needs your
//     Supabase login (a JWT in "Authorization: Bearer ...") and your email must be OWNER_EMAIL.
//   - the Mac bridge: a bridge token ("Authorization: Bearer chn_...").
//   - outside agents on the MCP door (/mcp): their own agent token.
// Local-mode guards against other web pages: the Host header must be a loopback name (blocks DNS rebinding), and
// changes need the header "x-channel: 1", which another site cannot add without this server agreeing (it never does).
import { Hono, type Context } from "hono";
import { streamSSE } from "hono/streaming";
import type { Engine, ChannelEvent } from "./engine.ts";
import { A2AError } from "./a2a.ts";
import { handleMcp } from "./mcp.ts";
import { newToken, sha256, type TokenInfo } from "./types.ts";

const LOOPBACK = /^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/i;

export interface Backend {
  mode: "local" | "online";
  /** The engine for one owner. Local: always the same one. Online: a fresh one per request. */
  engineFor(owner: string): Engine;
  /** Who is using the screen, or null. */
  ownerFromRequest(c: Context): Promise<string | null>;
  findToken(hash: string): Promise<TokenInfo | null>;
  /** Public settings the screen needs (never secrets). */
  publicConfig: Record<string, unknown>;
  /** Local mode only: live events for the screen. */
  events?: Engine;
}

type Vars = { owner: string; engine: Engine; token: TokenInfo };

export function createApi(backend: Backend) {
  const app = new Hono<{ Variables: Vars }>();

  app.onError((e, c) => c.json({ error: e.message }, e instanceof A2AError ? 502 : 400));

  if (backend.mode === "local") {
    app.use("*", async (c, next) => {
      if (!LOOPBACK.test(c.req.header("host") ?? "")) return c.json({ error: "Channel only answers on this Mac." }, 403);
      await next();
    });
  }

  const body = async <T>(c: Context) => ((await c.req.json().catch(() => ({}))) ?? {}) as T;
  const bearer = (c: Context) => (c.req.header("authorization") ?? "").replace(/^Bearer\s+/i, "").trim() || (c.req.header("x-api-key") ?? "").trim();

  const tokenAuth = (kind: "bridge" | "agent") => async (c: Context<{ Variables: Vars }>, next: () => Promise<void>) => {
    const t = bearer(c);
    const info = t ? await backend.findToken(await sha256(t)) : null;
    if (!info || info.kind !== kind) return c.json({ error: "Invalid or missing token." }, 401);
    c.set("token", info);
    c.set("owner", info.owner);
    c.set("engine", backend.engineFor(info.owner));
    await next();
  };

  // ---------------- MCP door for outside agents ----------------
  app.all("/mcp", tokenAuth("agent"), (c) => handleMcp(c, c.get("engine"), c.get("token").agentId!));

  // ---------------- bridge (Mac) ----------------
  const bridge = new Hono<{ Variables: Vars }>();
  bridge.use("*", tokenAuth("bridge"));
  bridge.post("/agents", async (c) => {
    const b = await body<{ name?: string; description?: string; skills?: string[]; baseUrl?: string; rpcUrl?: string; handle?: string }>(c);
    if (!b.name || !b.rpcUrl) return c.json({ error: "name and rpcUrl are required" }, 400);
    const agent = await c.get("engine").registerA2A({ name: b.name, description: b.description ?? "", skills: b.skills ?? [], baseUrl: b.baseUrl ?? "", rpcUrl: b.rpcUrl }, b.handle);
    return c.json(agent, 201);
  });
  // Long poll: waits up to `wait` seconds (max 25) for a delivery for one of the bridge's agents.
  bridge.get("/next", async (c) => {
    const agents = (c.req.query("agents") ?? "").split(",").map((s) => s.trim()).filter(Boolean);
    const until = Date.now() + Math.min(25, Math.max(0, Number(c.req.query("wait") ?? 20))) * 1000;
    do {
      const d = await c.get("engine").nextForBridge(agents.length ? agents : undefined);
      if (d) return c.json(d);
      await new Promise((r) => setTimeout(r, 1000));
    } while (Date.now() < until);
    return c.body(null, 204);
  });
  bridge.post("/deliveries/:id", async (c) => {
    const b = await body<{ text?: string; contextId?: string | null; inputRequired?: boolean; error?: string }>(c);
    const id = Number(c.req.param("id"));
    if (b.error) await c.get("engine").failDelivery(id, b.error);
    else await c.get("engine").completeDelivery(id, { text: b.text ?? "", contextId: b.contextId, inputRequired: b.inputRequired });
    return c.json({ ok: true });
  });
  app.route("/api/bridge", bridge);

  // ---------------- the screen (you) ----------------
  // Public settings the sign-in page needs before you are signed in (no secrets).
  app.get("/api/config", (c) => c.json({ mode: backend.mode, ...backend.publicConfig }));

  const ui = new Hono<{ Variables: Vars }>();
  ui.use("*", async (c, next) => {
    if (backend.mode === "local" && c.req.method !== "GET" && c.req.header("x-channel") !== "1") return c.json({ error: "Missing x-channel header." }, 403);
    const owner = await backend.ownerFromRequest(c);
    if (!owner) return c.json({ error: "Please sign in." }, 401);
    c.set("owner", owner);
    c.set("engine", backend.engineFor(owner));
    await next();
  });

  ui.get("/agents", async (c) => {
    const store = c.get("engine").store;
    const out = [];
    for (const a of await store.listAgents()) out.push({ ...a, hasToken: a.kind === "mcp" ? true : !!(await store.tokenFor(a.id)) });
    return c.json(out);
  });
  ui.post("/agents", async (c) => {
    const b = await body<{ kind?: "a2a" | "mcp"; url?: string; token?: string; handle?: string; name?: string }>(c);
    if (b.kind === "mcp") {
      const { agent, token } = await c.get("engine").addMcpAgent(b.name ?? "", b.handle?.trim() || undefined);
      return c.json({ agent, token }, 201); // the token is shown once and never stored in readable form
    }
    if (backend.mode === "online") return c.json({ error: "Agents on your Mac (A2A) are added by the Channel bridge on that Mac. See the README." }, 400);
    if (!b.url || !/^https?:\/\//.test(b.url)) return c.json({ error: "Enter the agent's address, starting with http:// or https://." }, 400);
    return c.json(await c.get("engine").addA2AAgent(b.url.trim(), b.token?.trim() || undefined, b.handle?.trim() || undefined), 201);
  });
  ui.delete("/agents/:id", async (c) => {
    await c.get("engine").removeAgent(c.req.param("id"));
    return c.json({ ok: true });
  });
  ui.post("/bridge-token", async (c) => {
    const token = newToken();
    await c.get("engine").store.addApiToken(await sha256(token), "bridge", null, "Channel bridge");
    return c.json({ token }, 201);
  });

  ui.get("/chats", async (c) => c.json(await c.get("engine").store.listChats()));
  ui.post("/chats", async (c) => {
    const b = await body<{ title?: string; agentIds?: string[] }>(c);
    return c.json(await c.get("engine").createChat(b.title ?? "", b.agentIds ?? []), 201);
  });
  ui.patch("/chats/:id", async (c) => {
    const b = await body<{ title?: string; auto?: boolean; hopLimit?: number }>(c);
    const id = Number(c.req.param("id"));
    await c.get("engine").updateChat(id, b);
    return c.json(await c.get("engine").store.getChat(id));
  });
  ui.delete("/chats/:id", async (c) => {
    await c.get("engine").store.deleteChat(Number(c.req.param("id")));
    c.get("engine").emit("event", { type: "chats" } satisfies ChannelEvent);
    return c.json({ ok: true });
  });
  ui.get("/chats/:id/messages", async (c) => c.json(await c.get("engine").store.messages(Number(c.req.param("id")))));
  ui.get("/chats/:id/deliveries", async (c) => c.json(await c.get("engine").store.openDeliveries(Number(c.req.param("id")))));
  ui.post("/chats/:id/messages", async (c) => {
    const b = await body<{ text?: string }>(c);
    const { message, done } = await c.get("engine").postUserMessage(Number(c.req.param("id")), b.text ?? "");
    // Online, wait until the deliveries are queued (answers come later). Local, agents answer in the background.
    if (backend.mode === "online") await done;
    else done.catch(() => {});
    return c.json(message, 201);
  });
  ui.post("/chats/:id/stop", async (c) => {
    await c.get("engine").stop(Number(c.req.param("id")));
    return c.json({ ok: true });
  });
  ui.post("/handoffs/:id", async (c) => {
    const b = await body<{ action?: "send" | "skip"; text?: string }>(c);
    if (b.action !== "send" && b.action !== "skip") return c.json({ error: "action must be send or skip" }, 400);
    const { done } = await c.get("engine").resolveHandoff(Number(c.req.param("id")), b.action, b.text);
    if (backend.mode === "online") await done;
    else done.catch(() => {});
    return c.json({ ok: true });
  });

  // Live updates in local mode: one open connection the server writes events to. Online, the screen uses Supabase Realtime.
  ui.get("/events", (c) => {
    const engine = backend.events;
    if (!engine) return c.json({ error: "Live events come from Supabase Realtime in online mode." }, 404);
    return streamSSE(c, async (stream) => {
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
    });
  });

  app.route("/api", ui);
  return app;
}
