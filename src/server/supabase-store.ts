// Online storage: Supabase Postgres (schema in supabase/migrations). Runs on the server with the service role key,
// which never reaches the browser. Every query is limited to one owner. Agent tokens for a2a agents are not stored
// online at all: the Mac bridge keeps them.
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Agent, AgentKind, Chat, Delivery, DeliveryStatus, Member, Message, MessageKind, Store, TokenInfo } from "./types.ts";

type Row = Record<string, any>;

function check<T>(r: { data: T; error: { message: string } | null }): T {
  if (r.error) throw new Error(`Database error: ${r.error.message}`);
  return r.data;
}

export class SupabaseStore implements Store {
  constructor(private db: SupabaseClient, readonly owner: string) {}

  // ---- agents ----
  async addAgent(a: Agent) {
    check(await this.db.from("agents").upsert({ owner: this.owner, id: a.id, name: a.name, description: a.description, skills: a.skills, kind: a.kind, base_url: a.baseUrl, rpc_url: a.rpcUrl, created_at: a.createdAt }));
  }
  async removeAgent(id: string) {
    check(await this.db.from("agents").delete().eq("owner", this.owner).eq("id", id));
    await this.removeApiTokens(id);
  }
  async listAgents() {
    return (check(await this.db.from("agents").select("*").eq("owner", this.owner).order("created_at")) as Row[]).map(rowAgent);
  }
  async getAgent(id: string) {
    const r = check(await this.db.from("agents").select("*").eq("owner", this.owner).eq("id", id).maybeSingle()) as Row | null;
    return r ? rowAgent(r) : null;
  }

  // ---- chats ----
  async createChat(title: string, agentIds: string[]) {
    const kind = agentIds.length === 1 ? "direct" : "group";
    const chat = check(await this.db.from("chats").insert({ owner: this.owner, title, kind }).select("id").single()) as Row;
    check(await this.db.from("members").insert(agentIds.map((agent_id, position) => ({ chat_id: chat.id, owner: this.owner, agent_id, position }))));
    return (await this.getChat(Number(chat.id)))!;
  }
  async getChat(id: number): Promise<Chat | null> {
    const r = check(await this.db.from("chats").select("*, members(agent_id, position)").eq("owner", this.owner).eq("id", id).maybeSingle()) as Row | null;
    return r ? rowChat(r) : null;
  }
  async listChats() {
    const rows = check(await this.db.from("chats").select("*, members(agent_id, position)").eq("owner", this.owner).order("id", { ascending: false })) as Row[];
    const out = [];
    for (const r of rows) {
      const last = check(await this.db.from("messages").select("*").eq("chat_id", r.id).order("id", { ascending: false }).limit(1).maybeSingle()) as Row | null;
      out.push({ ...rowChat(r), last: last ? rowMessage(last) : null });
    }
    return out;
  }
  async updateChat(id: number, patch: { title?: string; auto?: boolean; hopLimit?: number }) {
    const row: Row = {};
    if (patch.title !== undefined) row.title = patch.title;
    if (patch.auto !== undefined) row.auto = patch.auto;
    if (patch.hopLimit !== undefined) row.hop_limit = patch.hopLimit;
    if (Object.keys(row).length) check(await this.db.from("chats").update(row).eq("owner", this.owner).eq("id", id));
  }
  async bumpGeneration(id: number) {
    const chat = (await this.getChat(id))!;
    check(await this.db.from("chats").update({ generation: chat.generation + 1 }).eq("owner", this.owner).eq("id", id));
    return chat.generation + 1;
  }
  async deleteChat(id: number) {
    check(await this.db.from("chats").delete().eq("owner", this.owner).eq("id", id));
  }

  // ---- members ----
  async getMember(chatId: number, agentId: string): Promise<Member | null> {
    const r = check(await this.db.from("members").select("*").eq("owner", this.owner).eq("chat_id", chatId).eq("agent_id", agentId).maybeSingle()) as Row | null;
    return r ? { chatId, agentId, contextId: r.context_id ?? null, lastSeen: Number(r.last_seen), introSent: !!r.intro_sent } : null;
  }
  async updateMember(chatId: number, agentId: string, patch: { contextId?: string | null; lastSeen?: number; introSent?: boolean }) {
    const row: Row = {};
    if (patch.contextId !== undefined) row.context_id = patch.contextId;
    if (patch.introSent !== undefined) row.intro_sent = patch.introSent;
    if (patch.lastSeen !== undefined) {
      const m = await this.getMember(chatId, agentId);
      if (!m || patch.lastSeen > m.lastSeen) row.last_seen = patch.lastSeen;
    }
    if (Object.keys(row).length) check(await this.db.from("members").update(row).eq("owner", this.owner).eq("chat_id", chatId).eq("agent_id", agentId));
  }

  // ---- messages ----
  async addMessage(m: Omit<Message, "id" | "createdAt">) {
    const r = check(await this.db.from("messages").insert({ chat_id: m.chatId, owner: this.owner, author: m.author, kind: m.kind, text: m.text, meta: m.meta, root_id: m.rootId, hop: m.hop }).select("*").single()) as Row;
    return rowMessage(r);
  }
  async getMessage(id: number) {
    const r = check(await this.db.from("messages").select("*").eq("owner", this.owner).eq("id", id).maybeSingle()) as Row | null;
    return r ? rowMessage(r) : null;
  }
  async updateMeta(id: number, meta: Record<string, unknown>) {
    return rowMessage(check(await this.db.from("messages").update({ meta }).eq("owner", this.owner).eq("id", id).select("*").single()) as Row);
  }
  async messages(chatId: number, afterId = 0) {
    return (check(await this.db.from("messages").select("*").eq("owner", this.owner).eq("chat_id", chatId).gt("id", afterId).order("id")) as Row[]).map(rowMessage);
  }
  async handoffs(chatId: number) {
    return (check(await this.db.from("messages").select("*").eq("owner", this.owner).eq("chat_id", chatId).eq("kind", "handoff").order("id")) as Row[]).map(rowMessage);
  }

  // ---- deliveries ----
  async addDelivery(d: Omit<Delivery, "id" | "createdAt" | "takenAt" | "status">) {
    const r = check(await this.db.from("deliveries").insert({ chat_id: d.chatId, owner: this.owner, agent_id: d.agentId, agent_kind: d.agentKind, payload: d.payload, up_to: d.upTo, root_id: d.rootId, hop: d.hop, generation: d.generation }).select("*").single()) as Row;
    return rowDelivery(r);
  }
  async getDelivery(id: number) {
    const r = check(await this.db.from("deliveries").select("*").eq("owner", this.owner).eq("id", id).maybeSingle()) as Row | null;
    return r ? rowDelivery(r) : null;
  }
  async setDeliveryStatus(id: number, status: DeliveryStatus) {
    const row: Row = { status };
    if (status === "working") row.taken_at = new Date().toISOString();
    if (status === "done" || status === "failed" || status === "dropped") row.finished_at = new Date().toISOString();
    return rowDelivery(check(await this.db.from("deliveries").update(row).eq("owner", this.owner).eq("id", id).select("*").single()) as Row);
  }
  async openDeliveries(chatId: number) {
    return (check(await this.db.from("deliveries").select("*").eq("owner", this.owner).eq("chat_id", chatId).in("status", ["queued", "working"]).order("id")) as Row[]).map(rowDelivery);
  }
  async claimDelivery(kind: AgentKind, agentIds?: string[]) {
    const rows = check(await this.db.rpc("claim_delivery", { p_owner: this.owner, p_kind: kind, p_agent_ids: agentIds ?? null })) as Row[];
    return rows[0] ? rowDelivery(rows[0]) : null;
  }
  async claimInbox(agentId: string) {
    return (check(await this.db.rpc("claim_inbox", { p_owner: this.owner, p_agent_id: agentId })) as Row[]).map(rowDelivery);
  }

  // ---- secrets: a2a tokens live on the Mac (bridge), never online ----
  async tokenFor() {
    return undefined;
  }
  async setToken() {}

  // ---- api tokens ----
  async addApiToken(hash: string, kind: "bridge" | "agent", agentId: string | null, label: string) {
    check(await this.db.from("api_tokens").upsert({ token_hash: hash, owner: this.owner, kind, agent_id: agentId, label }));
  }
  async removeApiTokens(agentId: string) {
    check(await this.db.from("api_tokens").delete().eq("owner", this.owner).eq("agent_id", agentId));
  }
  async findApiToken(hash: string): Promise<TokenInfo | null> {
    return findApiTokenOnline(this.db, hash);
  }
}

/** Looks a token up across all owners and records when it was last used. */
export async function findApiTokenOnline(db: SupabaseClient, hash: string): Promise<TokenInfo | null> {
  const r = check(await db.from("api_tokens").select("owner, kind, agent_id").eq("token_hash", hash).maybeSingle()) as Row | null;
  if (!r) return null;
  await db.from("api_tokens").update({ last_used_at: new Date().toISOString() }).eq("token_hash", hash);
  return { owner: r.owner, kind: r.kind, agentId: r.agent_id ?? null };
}

function rowAgent(r: Row): Agent {
  return { id: r.id, name: r.name, description: r.description, skills: r.skills ?? [], kind: r.kind, baseUrl: r.base_url, rpcUrl: r.rpc_url, createdAt: r.created_at };
}
function rowChat(r: Row): Chat {
  const members = ((r.members ?? []) as Row[]).sort((a, b) => a.position - b.position).map((m) => String(m.agent_id));
  return { id: Number(r.id), title: r.title, kind: r.kind, auto: !!r.auto, hopLimit: Number(r.hop_limit), generation: Number(r.generation), createdAt: r.created_at, agentIds: members };
}
function rowMessage(r: Row): Message {
  return { id: Number(r.id), chatId: Number(r.chat_id), author: r.author, kind: r.kind as MessageKind, text: r.text, meta: r.meta ?? null, rootId: r.root_id == null ? null : Number(r.root_id), hop: Number(r.hop), createdAt: r.created_at };
}
function rowDelivery(r: Row): Delivery {
  return { id: Number(r.id), chatId: Number(r.chat_id), agentId: r.agent_id, agentKind: r.agent_kind, payload: r.payload, upTo: Number(r.up_to), rootId: Number(r.root_id), hop: Number(r.hop), generation: Number(r.generation), status: r.status, createdAt: r.created_at, takenAt: r.taken_at ?? null };
}
