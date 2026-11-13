// Talks to the Channel server. Local mode: every change carries "x-channel: 1" (see src/server/http.ts).
// Online mode: every request carries your Supabase login (a JWT) instead.
import { createClient, type SupabaseClient } from "@supabase/supabase-js";

export interface Agent { id: string; name: string; description: string; skills: string[]; kind: "a2a" | "mcp"; baseUrl: string; rpcUrl: string; hasToken: boolean }
export interface HandoffMeta { sourceId: number; from: string; to: string; status: "pending" | "sent" | "skipped"; editedText?: string }
export interface Message {
  id: number; chatId: number; author: string; kind: "text" | "handoff" | "notice" | "error"; text: string;
  meta: Record<string, unknown> | null; rootId: number | null; hop: number; createdAt: string;
}
export interface Delivery { id: number; chatId: number; agentId: string; agentKind: "a2a" | "mcp"; status: "queued" | "working" | "done" | "failed" | "dropped"; createdAt: string }
export interface Chat { id: number; title: string; kind: "direct" | "group"; auto: boolean; hopLimit: number; agentIds: string[]; createdAt: string; last: Message | null }
export interface Config { mode: "local" | "online"; mcpUrl: string; supabaseUrl?: string; supabaseKey?: string; setupError?: string | null }

let supabase: SupabaseClient | null = null;
export const getSupabase = () => supabase;

export async function loadConfig(): Promise<Config> {
  const cfg = (await (await fetch("/api/config")).json()) as Config;
  if (cfg.mode === "online" && !cfg.setupError && cfg.supabaseUrl && cfg.supabaseKey && !supabase) {
    supabase = createClient(cfg.supabaseUrl, cfg.supabaseKey, { auth: { persistSession: true, detectSessionInUrl: true } });
  }
  return cfg;
}

async function authHeaders(): Promise<Record<string, string>> {
  if (!supabase) return { "x-channel": "1" };
  const { data } = await supabase.auth.getSession();
  return data.session ? { authorization: `Bearer ${data.session.access_token}` } : {};
}

async function call<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(path, {
    method,
    headers: { ...(await authHeaders()), ...(body ? { "content-type": "application/json" } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error((data as { error?: string }).error ?? `HTTP ${res.status}`);
  return data as T;
}

export const api = {
  agents: () => call<Agent[]>("GET", "/api/agents"),
  addA2A: (url: string, token: string, handle: string) => call<Agent>("POST", "/api/agents", { kind: "a2a", url, token, handle }),
  addMcp: (name: string, handle: string) => call<{ agent: Agent; token: string }>("POST", "/api/agents", { kind: "mcp", name, handle }),
  removeAgent: (id: string) => call("DELETE", `/api/agents/${id}`),
  bridgeToken: () => call<{ token: string }>("POST", "/api/bridge-token"),
  chats: () => call<Chat[]>("GET", "/api/chats"),
  createChat: (title: string, agentIds: string[]) => call<Chat>("POST", "/api/chats", { title, agentIds }),
  updateChat: (id: number, patch: Partial<Pick<Chat, "title" | "auto" | "hopLimit">>) => call<Chat>("PATCH", `/api/chats/${id}`, patch),
  deleteChat: (id: number) => call("DELETE", `/api/chats/${id}`),
  messages: (chatId: number) => call<Message[]>("GET", `/api/chats/${chatId}/messages`),
  deliveries: (chatId: number) => call<Delivery[]>("GET", `/api/chats/${chatId}/deliveries`),
  send: (chatId: number, text: string) => call<Message>("POST", `/api/chats/${chatId}/messages`, { text }),
  stop: (chatId: number) => call("POST", `/api/chats/${chatId}/stop`),
  handoff: (id: number, action: "send" | "skip", text?: string) => call("POST", `/api/handoffs/${id}`, { action, text }),
};

/** Live updates. Local: the server's event stream. Online: Supabase Realtime on your own rows. */
export function subscribe(handlers: {
  ready: (ok: boolean) => void;
  message: (m: Message) => void;
  delivery: (d: Delivery) => void;
  chats: () => void;
  agents: () => void;
}): () => void {
  if (!supabase) {
    const es = new EventSource("/api/events");
    es.addEventListener("ready", () => handlers.ready(true));
    es.onerror = () => handlers.ready(false);
    const on = (name: string, f: (e: any) => void) => es.addEventListener(name, (ev) => f(JSON.parse((ev as MessageEvent).data)));
    on("message", (e) => handlers.message(e.message));
    on("message-updated", (e) => handlers.message(e.message));
    on("delivery", (e) => handlers.delivery(e.delivery));
    on("chats", () => handlers.chats());
    on("agents", () => handlers.agents());
    return () => es.close();
  }
  const ch = supabase
    .channel("channel-live")
    .on("postgres_changes", { event: "*", schema: "public", table: "messages" }, (p) => p.new && "id" in p.new && handlers.message(rowMessage(p.new)))
    .on("postgres_changes", { event: "*", schema: "public", table: "deliveries" }, (p) => p.new && "id" in p.new && handlers.delivery(rowDelivery(p.new)))
    .on("postgres_changes", { event: "*", schema: "public", table: "chats" }, () => handlers.chats())
    .subscribe((status) => handlers.ready(status === "SUBSCRIBED"));
  return () => { supabase?.removeChannel(ch); };
}

const rowMessage = (r: Record<string, any>): Message => ({ id: Number(r.id), chatId: Number(r.chat_id), author: r.author, kind: r.kind, text: r.text, meta: r.meta ?? null, rootId: r.root_id == null ? null : Number(r.root_id), hop: Number(r.hop), createdAt: r.created_at });
const rowDelivery = (r: Record<string, any>): Delivery => ({ id: Number(r.id), chatId: Number(r.chat_id), agentId: r.agent_id, agentKind: r.agent_kind, status: r.status, createdAt: r.created_at });
