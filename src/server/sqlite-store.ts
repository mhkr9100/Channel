// Local storage: one SQLite file for chats, messages and deliveries, one JSON file for agent tokens.
// Both live in the data folder (default ./data), which git ignores. Used in local mode and by the tests.
import { DatabaseSync } from "node:sqlite";
import { mkdirSync, readFileSync, writeFileSync, existsSync, chmodSync } from "node:fs";
import { join } from "node:path";
import type { Agent, AgentKind, Chat, Delivery, DeliveryStatus, Member, Message, MessageKind, Store, TokenInfo } from "./types.ts";

export const LOCAL_OWNER = "00000000-0000-0000-0000-000000000000";

export class SqliteStore implements Store {
  readonly db: DatabaseSync;
  private tokensFile: string;
  private tokensCache: Record<string, string> | null = null;

  constructor(dataDir: string) {
    if (dataDir !== ":memory:") mkdirSync(dataDir, { recursive: true });
    this.db = new DatabaseSync(dataDir === ":memory:" ? ":memory:" : join(dataDir, "channel.db"));
    this.tokensFile = dataDir === ":memory:" ? "" : join(dataDir, "agents.json");
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA foreign_keys = ON;
      CREATE TABLE IF NOT EXISTS agents (
        id TEXT PRIMARY KEY, name TEXT NOT NULL, description TEXT NOT NULL DEFAULT '', skills TEXT NOT NULL DEFAULT '[]',
        kind TEXT NOT NULL DEFAULT 'a2a', base_url TEXT NOT NULL DEFAULT '', rpc_url TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS chats (
        id INTEGER PRIMARY KEY AUTOINCREMENT, title TEXT NOT NULL, kind TEXT NOT NULL, auto INTEGER NOT NULL DEFAULT 0,
        hop_limit INTEGER NOT NULL DEFAULT 4, generation INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS members (
        chat_id INTEGER NOT NULL REFERENCES chats(id) ON DELETE CASCADE, agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
        context_id TEXT, last_seen INTEGER NOT NULL DEFAULT 0, intro_sent INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (chat_id, agent_id));
      CREATE TABLE IF NOT EXISTS messages (
        id INTEGER PRIMARY KEY AUTOINCREMENT, chat_id INTEGER NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
        author TEXT NOT NULL, kind TEXT NOT NULL, text TEXT NOT NULL, meta TEXT, root_id INTEGER, hop INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS messages_chat ON messages(chat_id, id);
      CREATE TABLE IF NOT EXISTS deliveries (
        id INTEGER PRIMARY KEY AUTOINCREMENT, chat_id INTEGER NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
        agent_id TEXT NOT NULL, agent_kind TEXT NOT NULL, payload TEXT NOT NULL, up_to INTEGER NOT NULL, root_id INTEGER NOT NULL,
        hop INTEGER NOT NULL, generation INTEGER NOT NULL, status TEXT NOT NULL DEFAULT 'queued', created_at TEXT NOT NULL, taken_at TEXT);
      CREATE TABLE IF NOT EXISTS api_tokens (
        token_hash TEXT PRIMARY KEY, kind TEXT NOT NULL, agent_id TEXT, label TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL);
    `);
    // Databases made by version 0.1 have no agents.kind column.
    const cols = (this.db.prepare("PRAGMA table_info(agents)").all() as { name: string }[]).map((c) => c.name);
    if (!cols.includes("kind")) this.db.exec("ALTER TABLE agents ADD COLUMN kind TEXT NOT NULL DEFAULT 'a2a'");
  }

  // ---- local agent tokens (separate file, readable by this user only) ----
  private tokens(): Record<string, string> {
    if (!this.tokensCache) this.tokensCache = this.tokensFile && existsSync(this.tokensFile) ? JSON.parse(readFileSync(this.tokensFile, "utf8")) : {};
    return this.tokensCache!;
  }
  async tokenFor(agentId: string) {
    return this.tokens()[agentId];
  }
  async setToken(agentId: string, token: string | undefined) {
    const t = this.tokens();
    if (token) t[agentId] = token;
    else delete t[agentId];
    if (!this.tokensFile) return;
    writeFileSync(this.tokensFile, JSON.stringify(t, null, 1), { mode: 0o600 });
    chmodSync(this.tokensFile, 0o600);
  }

  // ---- agents ----
  async addAgent(a: Agent) {
    this.db.prepare(`INSERT INTO agents (id, name, description, skills, kind, base_url, rpc_url, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET name = excluded.name, description = excluded.description, skills = excluded.skills,
      kind = excluded.kind, base_url = excluded.base_url, rpc_url = excluded.rpc_url`)
      .run(a.id, a.name, a.description, JSON.stringify(a.skills), a.kind, a.baseUrl, a.rpcUrl, a.createdAt);
  }
  async removeAgent(id: string) {
    this.db.prepare("DELETE FROM agents WHERE id = ?").run(id);
    await this.setToken(id, undefined);
    await this.removeApiTokens(id);
  }
  async listAgents() {
    return (this.db.prepare("SELECT * FROM agents ORDER BY created_at").all() as Row[]).map(rowAgent);
  }
  async getAgent(id: string) {
    const r = this.db.prepare("SELECT * FROM agents WHERE id = ?").get(id) as Row | undefined;
    return r ? rowAgent(r) : null;
  }

  // ---- chats ----
  async createChat(title: string, agentIds: string[]) {
    const kind = agentIds.length === 1 ? "direct" : "group";
    const r = this.db.prepare("INSERT INTO chats (title, kind, created_at) VALUES (?, ?, ?)").run(title, kind, now());
    const id = Number(r.lastInsertRowid);
    const add = this.db.prepare("INSERT INTO members (chat_id, agent_id) VALUES (?, ?)");
    for (const a of agentIds) add.run(id, a);
    return (await this.getChat(id))!;
  }
  async getChat(id: number): Promise<Chat | null> {
    const r = this.db.prepare("SELECT * FROM chats WHERE id = ?").get(id) as Row | undefined;
    if (!r) return null;
    const agentIds = (this.db.prepare("SELECT agent_id FROM members WHERE chat_id = ? ORDER BY rowid").all(id) as { agent_id: string }[]).map((m) => m.agent_id);
    return { id: Number(r.id), title: String(r.title), kind: r.kind as Chat["kind"], auto: !!r.auto, hopLimit: Number(r.hop_limit), generation: Number(r.generation), createdAt: String(r.created_at), agentIds };
  }
  async listChats() {
    const ids = this.db.prepare("SELECT id FROM chats ORDER BY id DESC").all() as { id: number }[];
    const out = [];
    for (const { id } of ids) {
      const last = this.db.prepare("SELECT * FROM messages WHERE chat_id = ? ORDER BY id DESC LIMIT 1").get(id) as Row | undefined;
      out.push({ ...(await this.getChat(id))!, last: last ? rowMessage(last) : null });
    }
    return out;
  }
  async updateChat(id: number, patch: { title?: string; auto?: boolean; hopLimit?: number }) {
    if (patch.title !== undefined) this.db.prepare("UPDATE chats SET title = ? WHERE id = ?").run(patch.title, id);
    if (patch.auto !== undefined) this.db.prepare("UPDATE chats SET auto = ? WHERE id = ?").run(patch.auto ? 1 : 0, id);
    if (patch.hopLimit !== undefined) this.db.prepare("UPDATE chats SET hop_limit = ? WHERE id = ?").run(patch.hopLimit, id);
  }
  async bumpGeneration(id: number) {
    this.db.prepare("UPDATE chats SET generation = generation + 1 WHERE id = ?").run(id);
    return (await this.getChat(id))!.generation;
  }
  async deleteChat(id: number) {
    this.db.prepare("DELETE FROM chats WHERE id = ?").run(id);
  }

  // ---- members ----
  async getMember(chatId: number, agentId: string): Promise<Member | null> {
    const r = this.db.prepare("SELECT * FROM members WHERE chat_id = ? AND agent_id = ?").get(chatId, agentId) as Row | undefined;
    return r ? { chatId, agentId, contextId: (r.context_id as string) ?? null, lastSeen: Number(r.last_seen), introSent: !!r.intro_sent } : null;
  }
  async updateMember(chatId: number, agentId: string, patch: { contextId?: string | null; lastSeen?: number; introSent?: boolean }) {
    if (patch.contextId !== undefined) this.db.prepare("UPDATE members SET context_id = ? WHERE chat_id = ? AND agent_id = ?").run(patch.contextId, chatId, agentId);
    if (patch.lastSeen !== undefined) this.db.prepare("UPDATE members SET last_seen = MAX(last_seen, ?) WHERE chat_id = ? AND agent_id = ?").run(patch.lastSeen, chatId, agentId);
    if (patch.introSent !== undefined) this.db.prepare("UPDATE members SET intro_sent = ? WHERE chat_id = ? AND agent_id = ?").run(patch.introSent ? 1 : 0, chatId, agentId);
  }

  // ---- messages ----
  async addMessage(m: Omit<Message, "id" | "createdAt">) {
    const r = this.db.prepare("INSERT INTO messages (chat_id, author, kind, text, meta, root_id, hop, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
      .run(m.chatId, m.author, m.kind, m.text, m.meta ? JSON.stringify(m.meta) : null, m.rootId, m.hop, now());
    return (await this.getMessage(Number(r.lastInsertRowid)))!;
  }
  async getMessage(id: number) {
    const r = this.db.prepare("SELECT * FROM messages WHERE id = ?").get(id) as Row | undefined;
    return r ? rowMessage(r) : null;
  }
  async updateMeta(id: number, meta: Record<string, unknown>) {
    this.db.prepare("UPDATE messages SET meta = ? WHERE id = ?").run(JSON.stringify(meta), id);
    return (await this.getMessage(id))!;
  }
  async messages(chatId: number, afterId = 0) {
    return (this.db.prepare("SELECT * FROM messages WHERE chat_id = ? AND id > ? ORDER BY id").all(chatId, afterId) as Row[]).map(rowMessage);
  }
  async handoffs(chatId: number) {
    return (this.db.prepare("SELECT * FROM messages WHERE chat_id = ? AND kind = 'handoff' ORDER BY id").all(chatId) as Row[]).map(rowMessage);
  }

  // ---- deliveries ----
  async addDelivery(d: Omit<Delivery, "id" | "createdAt" | "takenAt" | "status">) {
    const r = this.db.prepare(`INSERT INTO deliveries (chat_id, agent_id, agent_kind, payload, up_to, root_id, hop, generation, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(d.chatId, d.agentId, d.agentKind, d.payload, d.upTo, d.rootId, d.hop, d.generation, now());
    return (await this.getDelivery(Number(r.lastInsertRowid)))!;
  }
  async getDelivery(id: number) {
    const r = this.db.prepare("SELECT * FROM deliveries WHERE id = ?").get(id) as Row | undefined;
    return r ? rowDelivery(r) : null;
  }
  async setDeliveryStatus(id: number, status: DeliveryStatus) {
    this.db.prepare(`UPDATE deliveries SET status = ?, taken_at = CASE WHEN ? = 'working' THEN ? ELSE taken_at END WHERE id = ?`).run(status, status, now(), id);
    return (await this.getDelivery(id))!;
  }
  async openDeliveries(chatId: number) {
    return (this.db.prepare("SELECT * FROM deliveries WHERE chat_id = ? AND status IN ('queued', 'working') ORDER BY id").all(chatId) as Row[]).map(rowDelivery);
  }
  async claimDelivery(kind: AgentKind, agentIds?: string[]) {
    const rows = (this.db.prepare("SELECT * FROM deliveries WHERE agent_kind = ? AND status = 'queued' ORDER BY id").all(kind) as Row[]).map(rowDelivery);
    const d = rows.find((x) => !agentIds || agentIds.includes(x.agentId));
    return d ? this.setDeliveryStatus(d.id, "working") : null;
  }
  async claimInbox(agentId: string) {
    const rows = (this.db.prepare("SELECT * FROM deliveries WHERE agent_id = ? AND status = 'queued' ORDER BY id").all(agentId) as Row[]).map(rowDelivery);
    const out = [];
    for (const d of rows) out.push(await this.setDeliveryStatus(d.id, "working"));
    return out;
  }

  // ---- api tokens ----
  async addApiToken(hash: string, kind: "bridge" | "agent", agentId: string | null, label: string) {
    this.db.prepare("INSERT OR REPLACE INTO api_tokens (token_hash, kind, agent_id, label, created_at) VALUES (?, ?, ?, ?, ?)").run(hash, kind, agentId, label, now());
  }
  async removeApiTokens(agentId: string) {
    this.db.prepare("DELETE FROM api_tokens WHERE agent_id = ?").run(agentId);
  }
  async findApiToken(hash: string): Promise<TokenInfo | null> {
    const r = this.db.prepare("SELECT * FROM api_tokens WHERE token_hash = ?").get(hash) as Row | undefined;
    return r ? { owner: LOCAL_OWNER, kind: r.kind as TokenInfo["kind"], agentId: (r.agent_id as string) ?? null } : null;
  }
}

type Row = Record<string, unknown>;
const now = () => new Date().toISOString();

function rowAgent(r: Row): Agent {
  return { id: String(r.id), name: String(r.name), description: String(r.description), skills: JSON.parse(String(r.skills)), kind: (r.kind as AgentKind) ?? "a2a", baseUrl: String(r.base_url), rpcUrl: String(r.rpc_url), createdAt: String(r.created_at) };
}
function rowMessage(r: Row): Message {
  return {
    id: Number(r.id), chatId: Number(r.chat_id), author: String(r.author), kind: r.kind as MessageKind, text: String(r.text),
    meta: r.meta ? JSON.parse(String(r.meta)) : null, rootId: r.root_id == null ? null : Number(r.root_id), hop: Number(r.hop), createdAt: String(r.created_at),
  };
}
function rowDelivery(r: Row): Delivery {
  return {
    id: Number(r.id), chatId: Number(r.chat_id), agentId: String(r.agent_id), agentKind: r.agent_kind as AgentKind, payload: String(r.payload),
    upTo: Number(r.up_to), rootId: Number(r.root_id), hop: Number(r.hop), generation: Number(r.generation), status: r.status as DeliveryStatus,
    createdAt: String(r.created_at), takenAt: (r.taken_at as string) ?? null,
  };
}
