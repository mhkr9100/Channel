// A stand-in agent for tests. It speaks A2A v1.0 like a real agent but answers from a script, with no AI model
// and no cost. The last line of what it receives decides the answer:
//   "ask Name <text>"    replies "@Name <text>"            (asks another agent: tests hand-offs)
//   "loop"               replies "@<partner> loop"         (never stops on its own: tests loop limits)
//   "slow"               returns a running task, finished 1 s later (tests GetTask polling)
//   "fail"               returns a JSON-RPC error
//   anything else        replies "<name> heard: <line>"
// style "task" answers like OpenClaw (a Task with the text in artifacts); style "message" like a plain Message.
import { createServer, type Server } from "node:http";

export interface MockOptions {
  name: string;
  port: number;
  token: string;
  style?: "task" | "message";
  partner?: string;
  path?: string;
}

export interface MockAgent {
  url: string;
  received: { text: string; contextId: string | null }[];
  close(): Promise<void>;
}

export function startMockAgent(o: MockOptions): Promise<MockAgent> {
  const path = o.path ?? "/";
  const tasks = new Map<string, { contextId: string; text: string; doneAt: number }>();
  const received: MockAgent["received"] = [];
  let contexts = 0;

  const server: Server = createServer(async (req, res) => {
    const send = (status: number, body: unknown) => {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(body));
    };
    if (req.method === "GET" && req.url === "/.well-known/agent-card.json") {
      return send(200, {
        name: o.name,
        description: `Test agent ${o.name}`,
        version: "1.0.0",
        supportedInterfaces: [{ url: `http://127.0.0.1:${o.port}${path}`, protocolBinding: "JSONRPC", protocolVersion: "1.0" }],
        skills: [{ id: "echo", name: "Echo" }],
      });
    }
    if (req.method !== "POST" || req.url !== path) return send(404, { error: "not found" });
    if (req.headers.authorization !== `Bearer ${o.token}`) return send(401, { error: "unauthorized" });

    let body = "";
    for await (const chunk of req) body += chunk;
    const rpc = JSON.parse(body) as { id: number; method: string; params: Record<string, any> };
    const ok = (result: unknown) => send(200, { jsonrpc: "2.0", id: rpc.id, result });

    if (rpc.method === "GetTask") {
      const t = tasks.get(rpc.params.id);
      if (!t) return send(200, { jsonrpc: "2.0", id: rpc.id, error: { code: -32001, message: "Task not found" } });
      const done = Date.now() >= t.doneAt;
      return ok({ task: taskBody(rpc.params.id, t.contextId, done ? "TASK_STATE_COMPLETED" : "TASK_STATE_WORKING", done ? t.text : "") });
    }
    if (rpc.method !== "SendMessage") return send(200, { jsonrpc: "2.0", id: rpc.id, error: { code: -32601, message: "Method not found" } });

    const msg = rpc.params.message ?? {};
    const text: string = (msg.parts ?? []).map((p: { text?: string }) => p.text ?? "").join("\n");
    const contextId: string = msg.contextId ?? `${o.name.toLowerCase()}-ctx-${++contexts}`;
    received.push({ text, contextId: msg.contextId ?? null });
    // The last line decides the answer, without its "[Who]:" label and any leading @mentions.
    const last = text.trim().split("\n").pop()!.replace(/^\[[^\]]+\]:\s*/, "").replace(/^(@\w+\s+)+/, "").trim();

    if (/^fail\b/i.test(last)) return send(200, { jsonrpc: "2.0", id: rpc.id, error: { code: -32603, message: "Scripted failure" } });
    let reply = `${o.name} heard: ${last}`;
    const ask = /^ask @?(\w+)\s*(.*)$/i.exec(last);
    if (ask) reply = `@${ask[1]} ${ask[2]}`.trim();
    if (/\bloop\b/i.test(last) && o.partner) reply = `@${o.partner} loop`;

    const id = crypto.randomUUID();
    if (/^slow\b/i.test(last)) {
      tasks.set(id, { contextId, text: reply, doneAt: Date.now() + 1000 });
      return ok({ task: taskBody(id, contextId, "TASK_STATE_WORKING", "") });
    }
    if (o.style === "message") return ok({ message: { messageId: crypto.randomUUID(), role: "ROLE_AGENT", contextId, parts: [{ text: reply }] } });
    return ok({ task: taskBody(id, contextId, "TASK_STATE_COMPLETED", reply) });
  });

  function taskBody(id: string, contextId: string, state: string, text: string) {
    return { id, contextId, status: { state }, artifacts: text ? [{ artifactId: "a1", parts: [{ text }] }] : [] };
  }

  return new Promise((resolve) => {
    server.listen(o.port, "127.0.0.1", () =>
      resolve({ url: `http://127.0.0.1:${o.port}`, received, close: () => new Promise((r) => server.close(() => r())) }),
    );
  });
}
