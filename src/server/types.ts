// Shared shapes and the storage contract. Two storages implement it: SQLite on this Mac (local mode, tests) and
// Supabase Postgres (online). The engine only talks to this interface.

export type AgentKind = "a2a" | "mcp";

export interface Agent {
  id: string; // the handle used in mentions: @Hermes -> "hermes"
  name: string;
  description: string;
  skills: string[];
  kind: AgentKind; // a2a: Channel (or the Mac bridge) calls it; mcp: it calls Channel's MCP door on its schedule
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
  meta: Record<string, unknown> | null;
  rootId: number | null; // the message of yours that started this exchange
  hop: number; // 0 = answer to you, 1 = first hand-off, ...
  createdAt: string;
}

export interface Member {
  chatId: number;
  agentId: string;
  contextId: string | null; // the agent's own thread id for this chat (A2A contextId)
  lastSeen: number; // the newest message id this agent has been sent
  introSent: boolean;
}

export type DeliveryStatus = "queued" | "working" | "done" | "failed" | "dropped";

/** One message (or batch) waiting for one agent. The payload already follows the privacy rule. */
export interface Delivery {
  id: number;
  chatId: number;
  agentId: string;
  agentKind: AgentKind;
  payload: string;
  upTo: number;
  rootId: number;
  hop: number;
  generation: number;
  status: DeliveryStatus;
  createdAt: string;
  takenAt: string | null;
}

export interface TokenInfo {
  owner: string;
  kind: "bridge" | "agent";
  agentId: string | null;
}

export interface Store {
  // agents
  addAgent(a: Agent): Promise<void>;
  removeAgent(id: string): Promise<void>;
  listAgents(): Promise<Agent[]>;
  getAgent(id: string): Promise<Agent | null>;
  // chats
  createChat(title: string, agentIds: string[]): Promise<Chat>;
  getChat(id: number): Promise<Chat | null>;
  listChats(): Promise<(Chat & { last: Message | null })[]>;
  updateChat(id: number, patch: { title?: string; auto?: boolean; hopLimit?: number }): Promise<void>;
  bumpGeneration(id: number): Promise<number>;
  deleteChat(id: number): Promise<void>;
  // members
  getMember(chatId: number, agentId: string): Promise<Member | null>;
  updateMember(chatId: number, agentId: string, patch: { contextId?: string | null; lastSeen?: number; introSent?: boolean }): Promise<void>;
  // messages
  addMessage(m: Omit<Message, "id" | "createdAt">): Promise<Message>;
  getMessage(id: number): Promise<Message | null>;
  updateMeta(id: number, meta: Record<string, unknown>): Promise<Message>;
  messages(chatId: number, afterId?: number): Promise<Message[]>;
  handoffs(chatId: number): Promise<Message[]>;
  // deliveries
  addDelivery(d: Omit<Delivery, "id" | "createdAt" | "takenAt" | "status">): Promise<Delivery>;
  getDelivery(id: number): Promise<Delivery | null>;
  setDeliveryStatus(id: number, status: DeliveryStatus): Promise<Delivery>;
  openDeliveries(chatId: number): Promise<Delivery[]>;
  /** Marks the oldest queued delivery of this kind (optionally for these agents) as working and returns it. */
  claimDelivery(kind: AgentKind, agentIds?: string[]): Promise<Delivery | null>;
  /** Marks every queued delivery for one agent as working and returns them. */
  claimInbox(agentId: string): Promise<Delivery[]>;
  // secrets for local mode only (online, the bridge keeps a2a tokens on the Mac)
  tokenFor(agentId: string): Promise<string | undefined>;
  setToken(agentId: string, token: string | undefined): Promise<void>;
  // api tokens (bridge and outside agents), stored as SHA-256 hashes
  addApiToken(hash: string, kind: "bridge" | "agent", agentId: string | null, label: string): Promise<void>;
  removeApiTokens(agentId: string): Promise<void>;
  /** Looks a token hash up across all owners (it tells us who the owner is). */
  findApiToken(hash: string): Promise<TokenInfo | null>;
}

export const sha256 = async (s: string) =>
  Buffer.from(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s))).toString("hex");

export const newToken = () => "chn_" + Buffer.from(crypto.getRandomValues(new Uint8Array(24))).toString("hex");
