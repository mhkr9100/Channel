// Talks to the Channel server. Every change carries "x-channel: 1" (see src/server/http.ts for why).
export interface Agent { id: string; name: string; description: string; skills: string[]; baseUrl: string; rpcUrl: string; hasToken: boolean }
export interface HandoffMeta { sourceId: number; from: string; to: string; status: "pending" | "sent" | "skipped"; editedText?: string }
export interface Message {
  id: number; chatId: number; author: string; kind: "text" | "handoff" | "notice" | "error"; text: string;
  meta: (HandoffMeta & Record<string, unknown>) | Record<string, unknown> | null; rootId: number | null; hop: number; createdAt: string;
}
export interface Chat { id: number; title: string; kind: "direct" | "group"; auto: boolean; hopLimit: number; agentIds: string[]; createdAt: string; last: Message | null }

async function call<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(path, {
    method,
    headers: { "x-channel": "1", ...(body ? { "content-type": "application/json" } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error((data as { error?: string }).error ?? `HTTP ${res.status}`);
  return data as T;
}

export const api = {
  agents: () => call<Agent[]>("GET", "/api/agents"),
  addAgent: (url: string, token: string, handle: string) => call<Agent>("POST", "/api/agents", { url, token, handle }),
  removeAgent: (id: string) => call("DELETE", `/api/agents/${id}`),
  chats: () => call<Chat[]>("GET", "/api/chats"),
  createChat: (title: string, agentIds: string[]) => call<Chat>("POST", "/api/chats", { title, agentIds }),
  updateChat: (id: number, patch: Partial<Pick<Chat, "title" | "auto" | "hopLimit">>) => call<Chat>("PATCH", `/api/chats/${id}`, patch),
  deleteChat: (id: number) => call("DELETE", `/api/chats/${id}`),
  messages: (chatId: number) => call<Message[]>("GET", `/api/chats/${chatId}/messages`),
  send: (chatId: number, text: string) => call<Message>("POST", `/api/chats/${chatId}/messages`, { text }),
  stop: (chatId: number) => call("POST", `/api/chats/${chatId}/stop`),
  handoff: (id: number, action: "send" | "skip", text?: string) => call("POST", `/api/handoffs/${id}`, { action, text }),
};
