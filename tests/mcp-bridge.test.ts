// The online flow, end to end on this Mac: an outside agent uses the MCP door through the official MCP client
// (like Muse or Hark would), and the bridge carries deliveries to an A2A agent (like Hermes on the Mac).
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { serve, type ServerType } from "@hono/node-server";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { startMockAgent, type MockAgent } from "../test-agents/mock-agent.ts";
import { SqliteStore } from "../src/server/sqlite-store.ts";
import { Engine } from "../src/server/engine.ts";
import { createApi, type Backend } from "../src/server/http.ts";
import { runBridgeOnce } from "../bridge/bridge.ts";
import type { HandoffMeta } from "../src/server/types.ts";

const PORT = 9231;
const BASE = `http://localhost:${PORT}`;
let server: ServerType;
let ada: MockAgent;
let engine: Engine;
const json = { "x-channel": "1", "content-type": "application/json" };
const api = (path: string, init: RequestInit = {}) => fetch(BASE + path, init);

before(async () => {
  ada = await startMockAgent({ name: "Ada", port: 9232, token: "t-ada", style: "task", path: "/a2a/v1" });
  // Online-like engine: a2a agents are NOT called by the server; the bridge does it.
  const store = new SqliteStore(":memory:");
  engine = new Engine(store, { directA2A: false });
  const backend: Backend = { mode: "local", engineFor: () => engine, ownerFromRequest: async () => "local", findToken: (h) => store.findApiToken(h), publicConfig: {} };
  server = serve({ fetch: createApi(backend).fetch, port: PORT, hostname: "127.0.0.1" });
});
after(async () => { server.close(); await ada.close(); });

async function mcpClient(token: string) {
  const client = new Client({ name: "test-muse", version: "1.0.0" });
  await client.connect(new StreamableHTTPClientTransport(new URL(`${BASE}/mcp`), { requestInit: { headers: { authorization: `Bearer ${token}` } } }));
  return client;
}
const textOf = (r: unknown) => ((r as { content: { text: string }[] }).content ?? []).map((c) => c.text).join("\n");

test("bridge + MCP agent in one group: messages, inbox, replies and an approved hand-off", async () => {
  // The bridge registers its local A2A agent (it keeps the token itself).
  const bridgeToken = (await (await api("/api/bridge-token", { method: "POST", headers: json })).json()).token as string;
  const reg = await api("/api/bridge/agents", { method: "POST", headers: { authorization: `Bearer ${bridgeToken}`, "content-type": "application/json" }, body: JSON.stringify({ name: "Ada", rpcUrl: "http://127.0.0.1:9232/a2a/v1", handle: "ada" }) });
  assert.equal(reg.status, 201);

  // An outside agent (Muse) is added and gets its token once.
  const { token: museToken } = await (await api("/api/agents", { method: "POST", headers: json, body: JSON.stringify({ kind: "mcp", name: "Muse" }) })).json();
  const chat = await (await api("/api/chats", { method: "POST", headers: json, body: JSON.stringify({ title: "Trip", agentIds: ["ada", "muse"] }) })).json();

  // You write to both.
  await api(`/api/chats/${chat.id}/messages`, { method: "POST", headers: json, body: JSON.stringify({ text: "plan the trip" }) });
  await new Promise((r) => setTimeout(r, 50));
  const open = await (await api(`/api/chats/${chat.id}/deliveries`)).json();
  assert.equal(open.length, 2, "one delivery each, both waiting");

  // The bridge carries Ada's delivery.
  const handled = await runBridgeOnce({ server: BASE, token: bridgeToken, agents: { ada: { rpcUrl: "http://127.0.0.1:9232/a2a/v1", token: "t-ada" } } }, 0);
  assert.equal(handled, 1);

  // Muse checks its inbox over MCP, like on its schedule.
  const muse = await mcpClient(museToken);
  const tools = (await muse.listTools()).tools.map((t) => t.name).sort();
  assert.deepEqual(tools, ["check_inbox", "list_chats", "post_message"]);
  const inbox = textOf(await muse.callTool({ name: "check_inbox", arguments: {} }));
  assert.match(inbox, /plan the trip/);
  const deliveryId = Number(/delivery_id (\d+)/.exec(inbox)![1]);
  assert.equal(textOf(await muse.callTool({ name: "check_inbox", arguments: {} })), "No new messages.");

  // Muse answers and asks Ada something: a hand-off that waits for you.
  await muse.callTool({ name: "post_message", arguments: { chat_id: chat.id, text: "You wanted Lisbon. @ada can you check flights?", reply_to: deliveryId } });
  const msgs = await (await api(`/api/chats/${chat.id}/messages`)).json();
  const authors = msgs.filter((m: { kind: string }) => m.kind === "text").map((m: { author: string }) => m.author);
  assert.deepEqual(authors, ["you", "ada", "muse"]);
  const hand = msgs.find((m: { kind: string }) => m.kind === "handoff");
  assert.equal((hand.meta as HandoffMeta).status, "pending");

  // You approve it; the bridge carries it to Ada, who sees Muse's words labelled as another agent's.
  await api(`/api/handoffs/${hand.id}`, { method: "POST", headers: json, body: JSON.stringify({ action: "send" }) });
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(await runBridgeOnce({ server: BASE, token: bridgeToken, agents: { ada: { rpcUrl: "http://127.0.0.1:9232/a2a/v1", token: "t-ada" } } }, 0), 1);
  assert.match(ada.received.at(-1)!.text, /\[Muse, another AI agent, not the user\]: You wanted Lisbon/);

  // Muse cannot post into a chat it is not in.
  const other = await (await api("/api/chats", { method: "POST", headers: json, body: JSON.stringify({ title: "Private", agentIds: ["ada"] }) })).json();
  const denied = await muse.callTool({ name: "post_message", arguments: { chat_id: other.id, text: "hi" } });
  assert.equal((denied as { isError?: boolean }).isError, true);
  await muse.close();
});
