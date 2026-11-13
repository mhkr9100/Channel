// Chooses how Channel runs.
//   Local mode (default): SQLite on this Mac, no login, agents called directly, live events from this process.
//   Online mode (SUPABASE_URL set): Supabase Postgres, owner login, a2a agents served by the Mac bridge.
import { createClient } from "@supabase/supabase-js";
import type { Context } from "hono";
import { Engine } from "./engine.ts";
import { SqliteStore, LOCAL_OWNER } from "./sqlite-store.ts";
import { SupabaseStore, findApiTokenOnline } from "./supabase-store.ts";
import type { Backend } from "./http.ts";

export function localBackend(dataDir: string, publicUrl = "http://127.0.0.1:8787"): Backend {
  const store = new SqliteStore(dataDir);
  const engine = new Engine(store, { directA2A: true });
  return {
    mode: "local",
    engineFor: () => engine,
    ownerFromRequest: async () => LOCAL_OWNER,
    findToken: (hash) => store.findApiToken(hash),
    publicConfig: { mcpUrl: `${publicUrl}/mcp` },
    events: engine,
  };
}

/**
 * Environment (set on the host, never in git):
 *   SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY   server only
 *   SUPABASE_PUBLISHABLE_KEY                  safe for the browser (sign-in and live updates)
 *   OWNER_EMAIL                               the only email allowed to sign in to the screen
 *   PUBLIC_URL                                for example https://channel-xyz.vercel.app (used to show the MCP address)
 */
export function onlineBackend(env: Record<string, string | undefined> = process.env): Backend {
  const url = need(env, "SUPABASE_URL");
  const db = createClient(url, need(env, "SUPABASE_SERVICE_ROLE_KEY"), { auth: { persistSession: false, autoRefreshToken: false } });
  const ownerEmail = need(env, "OWNER_EMAIL").trim().toLowerCase();
  const publicUrl = (env.PUBLIC_URL ?? "").replace(/\/+$/, "");
  return {
    mode: "online",
    engineFor: (owner) => new Engine(new SupabaseStore(db, owner), { directA2A: false }),
    async ownerFromRequest(c: Context) {
      const jwt = (c.req.header("authorization") ?? "").replace(/^Bearer\s+/i, "").trim();
      if (!jwt || jwt.startsWith("chn_")) return null;
      const { data, error } = await db.auth.getUser(jwt);
      if (error || !data.user) return null;
      return (data.user.email ?? "").toLowerCase() === ownerEmail ? data.user.id : null;
    },
    findToken: (hash) => findApiTokenOnline(db, hash),
    publicConfig: { supabaseUrl: url, supabaseKey: need(env, "SUPABASE_PUBLISHABLE_KEY"), mcpUrl: publicUrl ? `${publicUrl}/mcp` : "/mcp" },
  };
}

function need(env: Record<string, string | undefined>, name: string): string {
  const v = env[name];
  if (!v) throw new Error(`Missing environment variable ${name}.`);
  return v;
}
