// The Channel bridge: runs on the Mac where your A2A agents live (Hermes, OpenClaw).
// It only makes OUTGOING connections: it asks the Channel server for the next delivery, calls the agent on this Mac,
// and posts the answer back. The agents' tokens stay in the bridge's config file on this Mac; the server never has them.
import { sendMessage, fetchCard, A2AError } from "../src/server/a2a.ts";

export interface BridgeConfig {
  server: string; // for example https://channel-xyz.vercel.app
  token: string; // the bridge token from Channel (Agents → Bridge)
  agents: Record<string, { rpcUrl?: string; url?: string; token?: string }>; // key = the agent's @handle in Channel
}

const headers = (cfg: BridgeConfig) => ({ authorization: `Bearer ${cfg.token}`, "content-type": "application/json" });

/** Tells the server about each local agent (name, skills), read from its own agent card. */
export async function registerAgents(cfg: BridgeConfig, log = console.log): Promise<void> {
  for (const [handle, a] of Object.entries(cfg.agents)) {
    try {
      const card = await fetchCard(a.url ?? a.rpcUrl!, a.token);
      a.rpcUrl = a.rpcUrl ?? card.rpcUrl;
      const r = await fetch(`${cfg.server}/api/bridge/agents`, { method: "POST", headers: headers(cfg), body: JSON.stringify({ name: card.name, description: card.description, skills: card.skills, baseUrl: a.url ?? "", rpcUrl: a.rpcUrl, handle }) });
      log(r.ok ? `registered @${handle} (${card.name})` : `could not register @${handle}: HTTP ${r.status} ${await r.text()}`);
    } catch (e) {
      log(`could not read @${handle}'s card: ${(e as Error).message}`);
    }
  }
}

/** Takes at most one delivery and carries it. Returns 1 if one was handled, 0 if there was nothing to do. */
export async function runBridgeOnce(cfg: BridgeConfig, waitSeconds = 20): Promise<number> {
  const ids = Object.keys(cfg.agents).join(",");
  const r = await fetch(`${cfg.server}/api/bridge/next?agents=${encodeURIComponent(ids)}&wait=${waitSeconds}`, { headers: headers(cfg) });
  if (r.status === 204) return 0;
  if (!r.ok) throw new Error(`Channel server answered HTTP ${r.status}: ${await r.text()}`);
  const d = (await r.json()) as { id: number; agentId: string; payload: string; contextId: string | null };
  const agent = cfg.agents[d.agentId];
  let result: Record<string, unknown>;
  if (!agent?.rpcUrl) result = { error: `The bridge has no address for @${d.agentId}.` };
  else {
    try {
      const reply = await sendMessage({ rpcUrl: agent.rpcUrl, token: agent.token }, d.payload, { contextId: d.contextId });
      result = { text: reply.text, contextId: reply.contextId, inputRequired: reply.state === "input_required" };
    } catch (e) {
      result = { error: e instanceof A2AError ? e.message : `Unexpected error: ${(e as Error).message}` };
    }
  }
  const back = await fetch(`${cfg.server}/api/bridge/deliveries/${d.id}`, { method: "POST", headers: headers(cfg), body: JSON.stringify(result) });
  if (!back.ok) throw new Error(`Could not post the answer back: HTTP ${back.status} ${await back.text()}`);
  return 1;
}

/** Runs until stopped, with several workers so a slow agent does not hold up the others. */
export async function runBridge(cfg: BridgeConfig, workers = 3, log = console.log): Promise<never> {
  await registerAgents(cfg, log);
  const loop = async (n: number) => {
    let backoff = 1000;
    for (;;) {
      try {
        if (await runBridgeOnce(cfg)) log(`[worker ${n}] carried a delivery`);
        backoff = 1000;
      } catch (e) {
        log(`[worker ${n}] ${(e as Error).message}; retrying in ${backoff / 1000} s`);
        await new Promise((r) => setTimeout(r, backoff));
        backoff = Math.min(backoff * 2, 60_000);
      }
    }
  };
  await Promise.all(Array.from({ length: workers }, (_, i) => loop(i + 1)));
  throw new Error("unreachable");
}
