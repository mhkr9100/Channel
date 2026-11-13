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
 * Environment (set on the host, never in git). Names accepted, first match wins:
 *   SUPABASE_URL                                              (also NEXT_PUBLIC_SUPABASE_URL)
 *   SUPABASE_SERVICE_ROLE_KEY, SUPABASE_SECRET_KEY            server only
 *   SUPABASE_PUBLISHABLE_KEY, SUPABASE_ANON_KEY               safe for the browser (sign-in, live updates)
 *   OWNER_EMAIL                                               the only email allowed to sign in to the screen
 *   PUBLIC_URL      optional; on Vercel it defaults to the production address (VERCEL_PROJECT_PRODUCTION_URL)
 * The Vercel Supabase integration sets the Supabase names automatically; OWNER_EMAIL has to be added by hand.
 */
export function onlineBackend(env: Record<string, string | undefined> = process.env): Backend {
  const url = pick(env, "SUPABASE_URL", "NEXT_PUBLIC_SUPABASE_URL");
  const serviceKey = pick(env, "SUPABASE_SERVICE_ROLE_KEY", "SUPABASE_SECRET_KEY");
  const publishableKey = pick(env, "SUPABASE_PUBLISHABLE_KEY", "SUPABASE_ANON_KEY", "NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY", "NEXT_PUBLIC_SUPABASE_ANON_KEY");
  const ownerEmail = (env.OWNER_EMAIL ?? "").trim().toLowerCase();
  const host = env.VERCEL_PROJECT_PRODUCTION_URL ? `https://${env.VERCEL_PROJECT_PRODUCTION_URL}` : "";
  const publicUrl = (env.PUBLIC_URL || host).replace(/\/+$/, "");

  const missing = [!url && "SUPABASE_URL", !serviceKey && "SUPABASE_SERVICE_ROLE_KEY", !publishableKey && "SUPABASE_PUBLISHABLE_KEY", !ownerEmail && "OWNER_EMAIL"].filter(Boolean) as string[];
  const setupError = missing.length ? `Channel is not set up yet. Add ${missing.join(", ")} in Vercel → Settings → Environment Variables, then redeploy.` : null;

  const db = url && serviceKey ? createClient(url, serviceKey, { auth: { persistSession: false, autoRefreshToken: false } }) : null;
  const needDb = () => {
    if (!db || setupError) throw new Error(setupError ?? "Database not configured.");
    return db;
  };
  return {
    mode: "online",
    engineFor: (owner) => new Engine(new SupabaseStore(needDb(), owner), { directA2A: false }),
    async ownerFromRequest(c: Context) {
      if (setupError || !db) return null;
      const jwt = (c.req.header("authorization") ?? "").replace(/^Bearer\s+/i, "").trim();
      if (!jwt || jwt.startsWith("chn_")) return null;
      const { data, error } = await db.auth.getUser(jwt);
      if (error || !data.user) return null;
      return (data.user.email ?? "").toLowerCase() === ownerEmail ? data.user.id : null;
    },
    findToken: async (hash) => (setupError || !db ? null : findApiTokenOnline(db, hash)),
    publicConfig: { supabaseUrl: url, supabaseKey: publishableKey, mcpUrl: publicUrl ? `${publicUrl}/mcp` : "/mcp", setupError },
  };
}

function pick(env: Record<string, string | undefined>, ...names: string[]): string {
  for (const n of names) if (env[n]) return env[n]!;
  return "";
}
