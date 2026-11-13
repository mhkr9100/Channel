// Starts the bridge with the config in ~/.channel/bridge.json (or the path in CHANNEL_BRIDGE_CONFIG).
// Example config (keep this file private: chmod 600):
// {
//   "server": "https://your-channel.vercel.app",
//   "token": "chn_...",                       <- from Channel: Agents → Mac bridge → Create bridge token
//   "agents": {
//     "hermes":   { "url": "http://127.0.0.1:9900",  "token": "<the token in A2A_PEER_TOKENS>" },
//     "openclaw": { "url": "http://127.0.0.1:18789", "token": "<channels.a2a.peers.channel.token>" }
//   }
// }
import { readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { runBridge, type BridgeConfig } from "./bridge.ts";

const path = process.env.CHANNEL_BRIDGE_CONFIG ?? join(homedir(), ".channel", "bridge.json");
const mode = statSync(path).mode & 0o777;
if (mode & 0o077) console.warn(`Warning: ${path} can be read by other users. Run: chmod 600 ${path}`);
const cfg = JSON.parse(readFileSync(path, "utf8")) as BridgeConfig;
cfg.server = cfg.server.replace(/\/+$/, "");
console.log(`Channel bridge → ${cfg.server}, agents: ${Object.keys(cfg.agents).map((a) => "@" + a).join(", ")}`);
await runBridge(cfg);
