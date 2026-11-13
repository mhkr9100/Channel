// A2A client: how Channel talks to an agent.
//
// A2A (Agent2Agent, https://a2a-protocol.org, v1.0) is JSON-RPC over HTTP. Channel uses three things:
//   GET  <base>/.well-known/agent-card.json   the agent's "business card": name, skills, where to send messages
//   POST <rpcUrl>  method "SendMessage"       send one message, get back a reply or a task still running
//   POST <rpcUrl>  method "GetTask"           check on a running task until it finishes
//
// Agents differ in small ways (checked 2026-11-13 against the installed Hermes docs,
// ~/.hermes/hermes-agent/website/docs/user-guide/messaging/a2a.md, and https://docs.openclaw.ai/channels/a2a):
//   - Hermes answers at POST / on port 9900; OpenClaw at POST /a2a/v1 on its gateway port (18789).
//   - The reply can come back as a Message or as a Task (with the text in artifacts or in status.message).
//   - v1.0 wraps the result ({ task } or { message }); older agents return the object itself (kind: "task").
// This file hides those differences behind one function: sendMessage().

export interface AgentEndpoint {
  rpcUrl: string;
  token?: string;
}

export interface AgentCardInfo {
  name: string;
  description: string;
  skills: string[];
  rpcUrl: string;
  protocolVersion: string | null;
}

export interface Reply {
  text: string;
  contextId: string | null;
  taskId: string | null;
  state: "completed" | "input_required" | "failed" | "rejected" | "canceled" | "auth_required";
}

export class A2AError extends Error {
  constructor(message: string, readonly kind: "network" | "http" | "rpc" | "timeout" | "protocol" | "task") {
    super(message);
  }
}

const DONE = new Set(["completed", "input_required", "failed", "rejected", "canceled", "auth_required"]);

/** "TASK_STATE_COMPLETED" (v1.0) and "completed" (older) both become "completed". */
export function normaliseState(s: unknown): string {
  return String(s ?? "").toLowerCase().replace(/^task_state_/, "").replace(/-/g, "_");
}

function textOfParts(parts: unknown): string {
  if (!Array.isArray(parts)) return "";
  return parts
    .map((p) => (p && typeof p === "object" && typeof (p as { text?: unknown }).text === "string" ? (p as { text: string }).text : ""))
    .filter(Boolean)
    .join("\n");
}

type Obj = Record<string, unknown>;
const obj = (v: unknown): Obj | null => (v && typeof v === "object" && !Array.isArray(v) ? (v as Obj) : null);

/** Pulls { kind, task | message } out of a SendMessage or GetTask result in either the v1.0 or the older shape. */
export function unwrapResult(result: unknown): { task: Obj } | { message: Obj } {
  const r = obj(result);
  if (!r) throw new A2AError("The agent sent an empty result.", "protocol");
  if (obj(r.task)) return { task: r.task as Obj };
  if (obj(r.message)) return { message: r.message as Obj };
  if (r.kind === "task" || ("status" in r && "id" in r)) return { task: r };
  if (r.kind === "message" || "parts" in r) return { message: r };
  throw new A2AError("The agent's result is neither a task nor a message.", "protocol");
}

export function textOfTask(task: Obj): string {
  const fromArtifacts = Array.isArray(task.artifacts) ? task.artifacts.map((a) => textOfParts(obj(a)?.parts)).filter(Boolean).join("\n") : "";
  if (fromArtifacts) return fromArtifacts;
  const status = obj(task.status);
  return textOfParts(obj(status?.message)?.parts);
}

let rpcId = 0;

async function rpc(ep: AgentEndpoint, method: string, params: unknown, timeoutMs: number): Promise<unknown> {
  let res: Response;
  try {
    res = await fetch(ep.rpcUrl, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json",
        "a2a-version": "1.0",
        ...(ep.token ? { authorization: `Bearer ${ep.token}` } : {}),
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: ++rpcId, method, params }),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (e) {
    const name = (e as Error).name;
    if (name === "TimeoutError" || name === "AbortError") throw new A2AError(`The agent did not answer within ${Math.round(timeoutMs / 1000)} s.`, "timeout");
    throw new A2AError(`Could not reach the agent at ${ep.rpcUrl}. Is it running?`, "network");
  }
  const body = await res.text();
  if (!res.ok) {
    const hint = res.status === 401 ? " Check the access token." : res.status === 403 ? " The agent refused the request." : "";
    throw new A2AError(`The agent answered HTTP ${res.status}.${hint}`, "http");
  }
  let json: Obj | null;
  try {
    json = obj(JSON.parse(body));
  } catch {
    throw new A2AError("The agent did not answer in JSON.", "protocol");
  }
  const err = obj(json?.error);
  if (err) throw new A2AError(`The agent returned an error: ${String(err.message ?? "unknown")} (${String(err.code ?? "?")}).`, "rpc");
  return json?.result;
}

export interface SendOptions {
  contextId?: string | null;
  /** How long one request may take. Hermes waits up to 300 s for its reply by default. */
  requestTimeoutMs?: number;
  /** Total time to keep checking on a running task. */
  taskTimeoutMs?: number;
  pollMs?: number;
}

/** Sends one message and returns the agent's final reply. */
export async function sendMessage(ep: AgentEndpoint, text: string, opts: SendOptions = {}): Promise<Reply> {
  const requestTimeoutMs = opts.requestTimeoutMs ?? 310_000;
  const message: Obj = { messageId: crypto.randomUUID(), role: "ROLE_USER", parts: [{ text }] };
  if (opts.contextId) message.contextId = opts.contextId;
  const first = unwrapResult(await rpc(ep, "SendMessage", { message }, requestTimeoutMs));

  if ("message" in first) {
    return { text: textOfParts(first.message.parts), contextId: (first.message.contextId as string) ?? opts.contextId ?? null, taskId: null, state: "completed" };
  }

  let task = first.task;
  const started = Date.now();
  const taskTimeoutMs = opts.taskTimeoutMs ?? 600_000;
  while (!DONE.has(normaliseState(obj(task.status)?.state))) {
    if (Date.now() - started > taskTimeoutMs) throw new A2AError("The agent's task did not finish in time.", "timeout");
    await new Promise((r) => setTimeout(r, opts.pollMs ?? 1500));
    const next = unwrapResult(await rpc(ep, "GetTask", { id: task.id }, 30_000));
    if (!("task" in next)) break;
    task = next.task;
  }
  const state = normaliseState(obj(task.status)?.state) as Reply["state"];
  const out = { text: textOfTask(task), contextId: (task.contextId as string) ?? opts.contextId ?? null, taskId: (task.id as string) ?? null, state };
  if (state === "failed" || state === "rejected" || state === "canceled") {
    throw new A2AError(`The agent's task ended as "${state}"${out.text ? `: ${out.text}` : "."}`, "task");
  }
  return out;
}

/** Reads an agent's card from its base address. Accepts the base URL or the card URL itself. */
export async function fetchCard(baseOrCardUrl: string, token?: string): Promise<AgentCardInfo> {
  const base = baseOrCardUrl.replace(/\/\.well-known\/agent(-card)?\.json$/, "").replace(/\/+$/, "");
  let res: Response | null = null;
  for (const path of ["/.well-known/agent-card.json", "/.well-known/agent.json"]) {
    try {
      res = await fetch(base + path, { headers: { accept: "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) }, signal: AbortSignal.timeout(10_000) });
    } catch {
      throw new A2AError(`Could not reach ${base}. Is the agent running, and is its A2A door turned on?`, "network");
    }
    if (res.ok) break;
  }
  if (!res || !res.ok) throw new A2AError(`No agent card at ${base} (HTTP ${res?.status}).`, "http");
  const card = obj(await res.json().catch(() => null));
  if (!card) throw new A2AError("The agent card is not valid JSON.", "protocol");

  // v1.0 lists endpoints in supportedInterfaces; older cards have a single url.
  const ifaces = Array.isArray(card.supportedInterfaces) ? card.supportedInterfaces.map(obj).filter((x): x is Obj => !!x) : [];
  const jsonrpc = ifaces.find((i) => /jsonrpc/i.test(String(i.protocolBinding ?? i.transport ?? ""))) ?? ifaces[0];
  let rpcUrl = String(jsonrpc?.url ?? card.url ?? base);
  // A card may advertise the address the agent is bound to; keep our own host so a loopback agent stays reachable.
  try {
    const advertised = new URL(rpcUrl), ours = new URL(base);
    if (["0.0.0.0", "::", "[::]"].includes(advertised.hostname)) { advertised.hostname = ours.hostname; rpcUrl = advertised.toString(); }
  } catch {
    rpcUrl = base;
  }
  const skills = Array.isArray(card.skills) ? card.skills.map((s) => String(obj(s)?.name ?? obj(s)?.id ?? "")).filter(Boolean) : [];
  return {
    name: String(card.name ?? "Agent"),
    description: String(card.description ?? ""),
    skills,
    rpcUrl,
    protocolVersion: (jsonrpc?.protocolVersion as string) ?? (card.protocolVersion as string) ?? null,
  };
}
