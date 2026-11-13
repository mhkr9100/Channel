// Storage: one SQLite file for chats and messages, one JSON file for agent tokens.
// Both live in the data folder (default ./data), which git ignores. Tokens never go into the database
// and are never sent to the browser.
import { DatabaseSync } from "node:sqlite";
import { mkdirSync, readFileSync, writeFileSync, existsSync, chmodSync } from "node:fs";
import { join } from "node:path";

export interface Agent {
  id: string; // the handle used in mentions: @Hermes -> "hermes"
  name: string;
  description: string;
  skills: string[];
  baseUrl: string;
  rpcUrl: string;
  createdAt: string;
}

export interface Chat {
  id: number;
  title: string;
  kind: "direct" | "group";
  auto: boolean;
  hopLimit: number;
  generation: number; // goes up on Stop: work started before it is dropped
  createdAt: string;
  agentIds: string[];
}

export type MessageKind = "text" | "handoff" | "notice" | "error";

export interface HandoffMeta {
  sourceId: number; // the agent message that mentioned another agent
  from: string;
  to: string;
  status: "pending" | "sent" | "skipped";
  editedText?: string;
}

export interface Message {
  id: number;
  chatId: number;
  author: string; // "you", "channel", or an agent id
  kind: MessageKind;
  text: string;
  meta: HandoffMeta | Record<string, unknown> | null;
  rootId: number | null; // the message of yours that started this exchange
  hop: number; // 0 = answer to you, 1 = first hand-off, ...
  createdAt: string;
}

export interface Member {
  chatId: number;
  agentId: string;
  contextId: string | null; // the agent's own thread id for this chat
  lastSeen: number; // the newest message id this agent has been sent
  introSent: boolean;
}

export class Store {
  readonly db: DatabaseSync;
  private tokensFile: string;

  constructor(dataDir: string) {
    if (dataDir !== ":memory:") mkdirSync(dataDir, { recursive: true });
    this.db = new DatabaseSync(dataDir === ":memory:" ? ":memory:" : join(dataDir, "channel.db"));
    this.tokensFile = dataDir === ":memory:" ? "" : join(dataDir, "agents.json");
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA foreign_keys = ON;
      CREATE TABLE IF NOT EXISTS agents (
        id TEXT PRIMARY KEY, name TEXT NOT NULL, description TEXT NOT NULL DEFAULT '', skills TEXT NOT NULL DEFAULT '[]',
        base_url TEXT NOT NULL, rpc_url TEXT NOT NULL, created_at TEXT NOT NULL);
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
    `);
  }

  // ---- tokens (separate file, readable by this user only) ----
  private tokensCache: Record<string, string> | null = null;
  private tokens(): Record<string, string> {
    if (this.tokensCache) return this.tokensCache;
    this.tokensCache = this.tokensFile && existsSync(this.tokensFile) ? JSON.parse(readFileSync(this.tokensFile, "utf8")) : {};
    return this.tokensCache!;
  }
  private saveTokens() {
    if (!this.tokensFile) return;
    writeFileSync(this.tokensFile, JSON.stringify(this.tokensCache ?? {}, null, 1), { mode: 0o600 });
    chmodSync(this.tokensFile, 0o600);
  }
  tokenFor(agentId: string): string | undefined {
    return this.tokens()[agentId];
  }

  // ---- agents ----
  addAgent(a: Agent, token: string | undefined) {
    this.db.prepare(`INSERT INTO agents (id, name, description, skills, base_url, rpc_url, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET name = excluded.name, description = excluded.description, skills = excluded.skills,
      base_url = excluded.base_url, rpc_url = excluded.rpc_url`)
      .run(a.id, a.name, a.description, JSON.stringify(a.skills), a.baseUrl, a.rpcUrl, a.createdAt);
    const t = this.tokens();
    if (token) t[a.id] = token;
    this.saveTokens();
  }
  removeAgent(id: string) {
    this.db.prepare("DELETE FROM agents WHERE id = ?").run(id);
    delete this.tokens()[id];
    this.saveTokens();
  }
  listAgents(): Agent[] {
    return (this.db.prepare("SELECT * FROM agents ORDER BY created_at").all() as Record<string, unknown>[]).map(rowAgent);
  }
  getAgent(id: string): Agent | null {
    const r = this.db.prepare("SELECT * FROM agents WHERE id = ?").get(id) as Record<string, unknown> | undefined;
    return r ? rowAgent(r) : null;
  }

  // ---- chats ----
  createChat(title: string, agentIds: string[]): Chat {
    const kind = agentIds.length === 1 ? "direct" : "group";
    const r = this.db.prepare("INSERT INTO chats (title, kind, created_at) VALUES (?, ?, ?)").run(title, kind, now());
    const id = Number(r.lastInsertRowid);
    const add = this.db.prepare("INSERT INTO members (chat_id, agent_id) VALUES (?, ?)");
    for (const a of agentIds) add.run(id, a);
    return this.getChat(id)!;
  }
  getChat(id: number): Chat | null {
    const r = this.db.prepare("SELECT * FROM chats WHERE id = ?").get(id) as Record<string, unknown> | undefined;
    if (!r) return null;
    const agentIds = (this.db.prepare("SELECT agent_id FROM members WHERE chat_id = ? ORDER BY rowid").all(id) as { agent_id: string }[]).map((m) => m.agent_id);
    return { id: Number(r.id), title: String(r.title), kind: r.kind as Chat["kind"], auto: !!r.auto, hopLimit: Number(r.hop_limit), generation: Number(r.generation), createdAt: String(r.created_at), agentIds };
  }
  listChats(): (Chat & { last: Message | null })[] {
    const ids = this.db.prepare("SELECT id FROM chats ORDER BY id DESC").all() as { id: number }[];
    return ids.map(({ id }) => ({ ...this.getChat(id)!, last: this.lastMessage(id) }));
  }
  updateChat(id: number, patch: { title?: string; auto?: boolean; hopLimit?: number }) {
    if (patch.title !== undefined) this.db.prepare("UPDATE chats SET title = ? WHERE id = ?").run(patch.title, id);
    if (patch.auto !== undefined) this.db.prepare("UPDATE chats SET auto = ? WHERE id = ?").run(patch.auto ? 1 : 0, id);
    if (patch.hopLimit !== undefined) this.db.prepare("UPDATE chats SET hop_limit = ? WHERE id = ?").run(patch.hopLimit, id);
  }
  bumpGeneration(id: number): number {
    this.db.prepare("UPDATE chats SET generation = generation + 1 WHERE id = ?").run(id);
    return this.getChat(id)!.generation;
  }
  deleteChat(id: number) {
    this.db.prepare("DELETE FROM chats WHERE id = ?").run(id);
  }

  // ---- members ----
  getMember(chatId: number, agentId: string): Member | null {
    const r = this.db.prepare("SELECT * FROM members WHERE chat_id = ? AND agent_id = ?").get(chatId, agentId) as Record<string, unknown> | undefined;
    return r ? { chatId, agentId, contextId: (r.context_id as string) ?? null, lastSeen: Number(r.last_seen), introSent: !!r.intro_sent } : null;
  }
  updateMember(chatId: number, agentId: string, patch: { contextId?: string | null; lastSeen?: number; introSent?: boolean }) {
    if (patch.contextId !== undefined) this.db.prepare("UPDATE members SET context_id = ? WHERE chat_id = ? AND agent_id = ?").run(patch.contextId, chatId, agentId);
    if (patch.lastSeen !== undefined) this.db.prepare("UPDATE members SET last_seen = MAX(last_seen, ?) WHERE chat_id = ? AND agent_id = ?").run(patch.lastSeen, chatId, agentId);
    if (patch.introSent !== undefined) this.db.prepare("UPDATE members SET intro_sent = ? WHERE chat_id = ? AND agent_id = ?").run(patch.introSent ? 1 : 0, chatId, agentId);
  }

  // ---- messages ----
  addMessage(m: Omit<Message, "id" | "createdAt">): Message {
    const r = this.db.prepare("INSERT INTO messages (chat_id, author, kind, text, meta, root_id, hop, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
      .run(m.chatId, m.author, m.kind, m.text, m.meta ? JSON.stringify(m.meta) : null, m.rootId, m.hop, now());
    return this.getMessage(Number(r.lastInsertRowid))!;
  }
  getMessage(id: number): Message | null {
    const r = this.db.prepare("SELECT * FROM messages WHERE id = ?").get(id) as Record<string, unknown> | undefined;
    return r ? rowMessage(r) : null;
  }
  updateMeta(id: number, meta: Record<string, unknown>) {
    this.db.prepare("UPDATE messages SET meta = ? WHERE id = ?").run(JSON.stringify(meta), id);
  }
  messages(chatId: number, afterId = 0): Message[] {
    return (this.db.prepare("SELECT * FROM messages WHERE chat_id = ? AND id > ? ORDER BY id").all(chatId, afterId) as Record<string, unknown>[]).map(rowMessage);
  }
  lastMessage(chatId: number): Message | null {
    const r = this.db.prepare("SELECT * FROM messages WHERE chat_id = ? ORDER BY id DESC LIMIT 1").get(chatId) as Record<string, unknown> | undefined;
    return r ? rowMessage(r) : null;
  }
  handoffs(chatId: number): Message[] {
    return (this.db.prepare("SELECT * FROM messages WHERE chat_id = ? AND kind = 'handoff' ORDER BY id").all(chatId) as Record<string, unknown>[]).map(rowMessage);
  }
}

const now = () => new Date().toISOString();

function rowAgent(r: Record<string, unknown>): Agent {
  return { id: String(r.id), name: String(r.name), description: String(r.description), skills: JSON.parse(String(r.skills)), baseUrl: String(r.base_url), rpcUrl: String(r.rpc_url), createdAt: String(r.created_at) };
}

function rowMessage(r: Record<string, unknown>): Message {
  return {
    id: Number(r.id), chatId: Number(r.chat_id), author: String(r.author), kind: r.kind as MessageKind, text: String(r.text),
    meta: r.meta ? JSON.parse(String(r.meta)) : null, rootId: r.root_id == null ? null : Number(r.root_id), hop: Number(r.hop), createdAt: String(r.created_at),
  };
}
