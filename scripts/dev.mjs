// Development: starts the Channel server (8787), the screen (5173) and, with --test-agents, two test agents.
import { spawn } from "node:child_process";

const run = (name, cmd, args) => {
  const p = spawn(cmd, args, { stdio: ["ignore", "pipe", "pipe"], env: process.env });
  const tag = (line) => line && console.log(`[${name}] ${line}`);
  p.stdout.on("data", (d) => String(d).split("\n").forEach(tag));
  p.stderr.on("data", (d) => String(d).split("\n").filter((l) => !/ExperimentalWarning|trace-warnings/.test(l)).forEach(tag));
  p.on("exit", (code) => { console.log(`[${name}] exited (${code})`); process.exit(code ?? 1); });
  return p;
};

const kids = [run("server", "npx", ["tsx", "src/server/main.ts"]), run("web", "npx", ["vite"])];
if (process.argv.includes("--test-agents")) kids.push(run("agents", "npx", ["tsx", "test-agents/run.ts"]));
const stop = () => { kids.forEach((k) => k.kill()); process.exit(0); };
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
