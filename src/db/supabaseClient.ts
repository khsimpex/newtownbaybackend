/**
 * Server-only Supabase client using the SERVICE ROLE key.
 *
 * This bypasses RLS entirely — same role/key type as `service.ts` on the
 * Next.js side. Never expose this key to a browser, never commit it.
 *
 * This backend and the Next.js app point at the SAME Supabase project, so
 * the schemas, RLS policies, and RPCs (reserve_stock / release_stock /
 * commit_stock) are shared infrastructure. No SQL changes needed here.
 */
import { createClient } from "@supabase/supabase-js";
import { env } from "../config/env.js";
import type { Database } from "../types/database.types.js";

export function createServiceClient() {
  return createClient<Database>(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
    auth: {
      persistSession: false,
      autoRefreshToken: false,
    },
  });
}
