// Vercel entry (https://vercel.com/docs/frameworks/backend/hono): Vercel finds this file, which imports hono, and
// serves its default export as one function. Static files come from public/ (the built screen).
// Online mode only: needs SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, SUPABASE_PUBLISHABLE_KEY, OWNER_EMAIL, PUBLIC_URL.
import { Hono } from "hono";
import { createApi } from "./src/server/http.ts";
import { onlineBackend } from "./src/server/backend.ts";

const app: Hono = createApi(onlineBackend()) as unknown as Hono;
export default app;
