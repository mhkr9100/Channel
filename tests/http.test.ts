// Web API guards: tokens never leave the server, and other web pages cannot drive Channel.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { startMockAgent, type MockAgent } from "../test-agents/mock-agent.ts";
import { localBackend } from "../src/server/backend.ts";
import { createApi } from "../src/server/http.ts";

let ada: MockAgent;
let app: ReturnType<typeof createApi>;
const req = (path: string, init: RequestInit & { host?: string } = {}) =>
  app.request(`http://localhost:8787${path}`, { ...init, headers: { host: init.host ?? "localhost:8787", ...(init.headers as Record<string, string>) } });
const json = { "x-channel": "1", "content-type": "application/json" };

before(async () => {
  ada = await startMockAgent({ name: "Ada", port: 9211, token: "secret-ada-token" });
  app = createApi(localBackend(":memory:"));
});
after(() => ada.close());

test("adding an agent works and the token is never returned", async () => {
  const add = await req("/api/agents", { method: "POST", headers: json, body: JSON.stringify({ url: ada.url, token: "secret-ada-token" }) });
  assert.equal(add.status, 201);
  assert.ok(!(await add.text()).includes("secret-ada-token"));
  const text = await (await req("/api/agents")).text();
  assert.ok(!text.includes("secret-ada-token"));
  assert.equal(JSON.parse(text)[0].hasToken, true);
});

test("changes without the x-channel header are refused", async () => {
  const r = await req("/api/chats", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ agentIds: ["ada"] }) });
  assert.equal(r.status, 403);
});

test("requests addressed to another host name are refused", async () => {
  assert.equal((await req("/api/chats", { host: "evil.example:8787" })).status, 403);
  assert.equal((await req("/mcp", { method: "POST", host: "evil.example:8787" })).status, 403);
});

test("an unreachable agent address gives a readable error", async () => {
  const r = await req("/api/agents", { method: "POST", headers: json, body: JSON.stringify({ url: "http://127.0.0.1:9298" }) });
  assert.equal(r.status, 502);
  assert.match((await r.json()).error, /Could not reach/);
});

test("the MCP door and the bridge refuse missing or wrong tokens", async () => {
  assert.equal((await req("/mcp", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" })).status, 401);
  assert.equal((await req("/mcp", { method: "POST", headers: { authorization: "Bearer chn_wrong" }, body: "{}" })).status, 401);
  assert.equal((await req("/api/bridge/next?wait=0", { headers: { authorization: "Bearer chn_wrong" } })).status, 401);
});

test("an outside agent's token is shown once and works only on the MCP door, not on the bridge", async () => {
  const r = await req("/api/agents", { method: "POST", headers: json, body: JSON.stringify({ kind: "mcp", name: "Muse" }) });
  assert.equal(r.status, 201);
  const { agent, token } = await r.json();
  assert.equal(agent.id, "muse");
  assert.match(token, /^chn_[0-9a-f]{48}$/);
  assert.ok(!(await (await req("/api/agents")).text()).includes(token));
  assert.equal((await req("/api/bridge/next?wait=0", { headers: { authorization: `Bearer ${token}` } })).status, 401);
});
