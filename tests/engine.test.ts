// Engine tests against two scripted test agents (no AI model, no cost).
import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { startMockAgent, type MockAgent } from "../test-agents/mock-agent.ts";
import { SqliteStore } from "../src/server/sqlite-store.ts";
import { Engine, mentionsIn, handleFor } from "../src/server/engine.ts";
import { sendMessage } from "../src/server/a2a.ts";
import type { HandoffMeta } from "../src/server/types.ts";

let ada: MockAgent, bo: MockAgent;
let engine: Engine;
const texts = async (chatId: number) => (await engine.store.messages(chatId)).map((m) => `${m.author}:${m.kind}:${m.text}`);
const meta = (m: { meta: unknown }) => m.meta as HandoffMeta;

before(async () => {
  ada = await startMockAgent({ name: "Ada", port: 9201, token: "t-ada", style: "task", partner: "Bo", path: "/a2a/v1" });
  bo = await startMockAgent({ name: "Bo", port: 9202, token: "t-bo", style: "message", partner: "Ada" });
});
after(async () => { await ada.close(); await bo.close(); });

beforeEach(async () => {
  ada.received.length = 0;
  bo.received.length = 0;
  engine = new Engine(new SqliteStore(":memory:"), { directA2A: true, sendOptions: { pollMs: 100 } });
  await engine.addA2AAgent(ada.url, "t-ada");
  await engine.addA2AAgent(bo.url, "t-bo");
});

test("handles and mentions", async () => {
  assert.equal(handleFor("Hermes Agent"), "hermesagent");
  const members = (await engine.store.listAgents());
  assert.deepEqual(mentionsIn("hi @Ada and @bo", members).ids.sort(), ["ada", "bo"]);
  assert.deepEqual(mentionsIn("mail me at x@ada.com", members).ids, []);
  assert.deepEqual(mentionsIn("@all go", members).ids.sort(), ["ada", "bo"]);
});

test("adding an agent reads its card and keeps the token out of the agent record", async () => {
  const a = (await engine.store.getAgent("ada"))!;
  assert.equal(a.name, "Ada");
  assert.equal(a.rpcUrl, "http://127.0.0.1:9201/a2a/v1");
  assert.ok(!JSON.stringify(a).includes("t-ada"));
  assert.equal(await engine.store.tokenFor("ada"), "t-ada");
});

test("direct chat: the agent gets your plain text and answers", async () => {
  const chat = await engine.createChat("", ["ada"]);
  await (await engine.postUserMessage(chat.id, "hello there")).done;
  assert.deepEqual((await texts(chat.id)), ["you:text:hello there", "ada:text:Ada heard: hello there"]);
  assert.equal(ada.received[0]!.text, "hello there");
});

test("plain-message replies work too, and the agent's thread id is kept for the next message", async () => {
  const chat = await engine.createChat("", ["bo"]);
  await (await engine.postUserMessage(chat.id, "one")).done;
  await (await engine.postUserMessage(chat.id, "two")).done;
  assert.equal(bo.received[0]!.contextId, null);
  assert.equal(bo.received[1]!.contextId, "bo-ctx-1");
});

test("group of two, no mention: both answer; group intro is sent once", async () => {
  const chat = await engine.createChat("Team", ["ada", "bo"]);
  await (await engine.postUserMessage(chat.id, "status?")).done;
  const t = (await texts(chat.id));
  assert.ok(t.includes("ada:text:Ada heard: status?"));
  assert.ok(t.includes("bo:text:Bo heard: status?"));
  assert.match(ada.received[0]!.text, /group chat called "Team"/);
  await (await engine.postUserMessage(chat.id, "@ada again")).done;
  assert.doesNotMatch(ada.received[1]!.text, /group chat called/);
});

test("privacy: an agent gets only messages addressed to it, never another agent's answer by itself", async () => {
  const chat = await engine.createChat("Team", ["ada", "bo"]);
  await (await engine.postUserMessage(chat.id, "@bo first")).done;
  assert.equal(ada.received.length, 0);
  await (await engine.postUserMessage(chat.id, "@ada second")).done;
  const sent = ada.received[0]!.text;
  assert.match(sent, /second/);
  assert.doesNotMatch(sent, /first/, "a message for Bo is not sent to Ada");
  assert.doesNotMatch(sent, /Bo heard/, "Bo's answer is not sent to Ada without a hand-off");
  await (await engine.postUserMessage(chat.id, "both of you")).done;
  assert.match(ada.received[1]!.text, /both of you/);
  assert.match(bo.received[1]!.text, /both of you/);
});

test("a hand-off waits for approval, and Send delivers it", async () => {
  const chat = await engine.createChat("Team", ["ada", "bo"]);
  await (await engine.postUserMessage(chat.id, "@ada ask Bo the time")).done;
  const h = (await engine.store.handoffs(chat.id));
  assert.equal(h.length, 1);
  assert.deepEqual({ ...meta(h[0]!), sourceId: 0 }, { sourceId: 0, from: "ada", to: "bo", status: "pending" });
  assert.equal(bo.received.length, 0, "nothing reaches Bo before approval");
  await (await engine.resolveHandoff(h[0]!.id, "send")).done;
  assert.equal(bo.received.length, 1);
  assert.match(bo.received[0]!.text, /\[Ada, another AI agent, not the user\]: @Bo the time/);
  assert.equal(meta((await engine.store.handoffs(chat.id))[0]!).status, "sent");
  await assert.rejects(engine.resolveHandoff(h[0]!.id, "send"), /already sent/);
});

test("Skip delivers nothing; an edited hand-off sends your text instead", async () => {
  const chat = await engine.createChat("Team", ["ada", "bo"]);
  await (await engine.postUserMessage(chat.id, "@ada ask Bo secret plans")).done;
  const [h1] = (await engine.store.handoffs(chat.id));
  await (await engine.resolveHandoff(h1!.id, "skip")).done;
  assert.equal(bo.received.length, 0);

  await (await engine.postUserMessage(chat.id, "@ada ask Bo private details")).done;
  const h2 = (await engine.store.handoffs(chat.id)).find((h) => meta(h).status === "pending")!;
  await (await engine.resolveHandoff(h2.id, "send", "@Bo please share only the summary")).done;
  assert.match(bo.received[0]!.text, /please share only the summary/);
  assert.doesNotMatch(bo.received[0]!.text, /private details/);
});

test("auto mode passes hand-offs on by itself and stops at the hop limit", async () => {
  const chat = await engine.createChat("Team", ["ada", "bo"]);
  await engine.updateChat(chat.id, { auto: true, hopLimit: 3 });
  await (await engine.postUserMessage(chat.id, "@ada loop")).done;
  const agentTurns = (await engine.store.messages(chat.id)).filter((m) => m.kind === "text" && m.author !== "you");
  assert.equal(agentTurns.length, 4, "the first answer plus 3 hand-offs");
  assert.ok((await texts(chat.id)).some((t) => t.includes("reached its limit of 3 hand-offs")));
});

test("hop limit is clamped to 1..10", async () => {
  const chat = await engine.createChat("Team", ["ada", "bo"]);
  await engine.updateChat(chat.id, { hopLimit: 99 });
  assert.equal((await engine.store.getChat(chat.id))!.hopLimit, 10);
  await engine.updateChat(chat.id, { hopLimit: 0 });
  assert.equal((await engine.store.getChat(chat.id))!.hopLimit, 1);
});

test("Stop skips waiting hand-offs and drops answers that arrive afterwards", async () => {
  const chat = await engine.createChat("Team", ["ada", "bo"]);
  await (await engine.postUserMessage(chat.id, "@ada ask Bo something")).done;
  const run = await engine.postUserMessage(chat.id, "@bo slow");
  await new Promise((r) => setTimeout(r, 150));
  await engine.stop(chat.id);
  await run.done;
  assert.equal(meta((await engine.store.handoffs(chat.id))[0]!).status, "skipped");
  const t = (await texts(chat.id));
  assert.ok(!t.some((x) => x.startsWith("bo:text:Bo heard: @bo slow")), "the late answer is not shown");
  assert.ok(t.some((x) => x.includes("after you pressed Stop")));
});

test("a running task is checked until it finishes", async () => {
  const chat = await engine.createChat("", ["ada"]);
  await (await engine.postUserMessage(chat.id, "slow")).done;
  assert.ok((await texts(chat.id)).includes("ada:text:Ada heard: slow"));
});

test("agent errors are shown in the chat, not thrown", async () => {
  const chat = await engine.createChat("", ["ada"]);
  await (await engine.postUserMessage(chat.id, "fail")).done;
  assert.match((await texts(chat.id)).at(-1)!, /^ada:error:The agent returned an error: Scripted failure/);
});

test("a wrong token gives a clear error", async () => {
  await assert.rejects(sendMessage({ rpcUrl: "http://127.0.0.1:9201/a2a/v1", token: "wrong" }, "hi"), /HTTP 401.*access token/);
});

test("an agent that is not running gives a clear error", async () => {
  await assert.rejects(sendMessage({ rpcUrl: "http://127.0.0.1:9299/" }, "hi", { requestTimeoutMs: 2000 }), /Could not reach the agent/);
});

test("a group of three needs a mention", async () => {
  const cara = await startMockAgent({ name: "Cara", port: 9203, token: "t-cara" });
  try {
    await engine.addA2AAgent(cara.url, "t-cara");
    const chat = await engine.createChat("Three", ["ada", "bo", "cara"]);
    await (await engine.postUserMessage(chat.id, "hello")).done;
    assert.match((await texts(chat.id)).at(-1)!, /^channel:notice:Nobody was asked/);
    assert.equal(ada.received.length + bo.received.length + cara.received.length, 0);
  } finally {
    await cara.close();
  }
});
