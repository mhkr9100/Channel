// Web API guards: tokens never leave the server, and other web pages cannot drive Channel.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { startMockAgent, type MockAgent } from "../test-agents/mock-agent.ts";
import { Store } from "../src/server/store.ts";
import { Engine } from "../src/server/engine.ts";
import { createApi } from "../src/server/http.ts";

let ada: MockAgent;
let app: ReturnType<typeof createApi>;
const req = (path: string, init: RequestInit & { host?: string } = {}) =>
  app.request(`http://localhost:8787${path}`, { ...init, headers: { host: init.host ?? "localhost:8787", ...(init.headers as Record<string, string>) } });

before(async () => {
  ada = await startMockAgent({ name: "Ada", port: 9211, token: "secret-ada-token" });
  app = createApi(new Engine(new Store(":memory:")));
});
after(() => ada.close());

test("adding an agent works and the token is never returned", async () => {
  const add = await req("/api/agents", { method: "POST", headers: { "x-channel": "1", "content-type": "application/json" }, body: JSON.stringify({ url: ada.url, token: "secret-ada-token" }) });
  assert.equal(add.status, 201);
  assert.ok(!(await add.text()).includes("secret-ada-token"));
  const list = await req("/api/agents");
  const text = await list.text();
  assert.ok(!text.includes("secret-ada-token"));
  assert.equal(JSON.parse(text)[0].hasToken, true);
});

test("changes without the x-channel header are refused", async () => {
  const r = await req("/api/chats", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ agentIds: ["ada"] }) });
  assert.equal(r.status, 403);
});

test("requests addressed to another host name are refused", async () => {
  const r = await req("/api/chats", { host: "evil.example:8787" });
  assert.equal(r.status, 403);
});

test("an unreachable agent address gives a readable error", async () => {
  const r = await req("/api/agents", { method: "POST", headers: { "x-channel": "1", "content-type": "application/json" }, body: JSON.stringify({ url: "http://127.0.0.1:9298" }) });
  assert.equal(r.status, 502);
  assert.match((await r.json()).error, /Could not reach/);
});
