import { env } from "../config/env.js";

/**
 * Is a human admin around right now?
 *
 * There is no presence table and no heartbeat from the admin app, so presence
 * is inferred from the only admin signal the database holds: the timestamp of
 * the most recent admin support message. An admin who replied within
 * ADMIN_OFFLINE_AFTER_MINUTES counts as online.
 *
 * Deliberately treated as offline when the lookup fails. A stuck query must
 * not leave a customer staring at silence — the bot answering during a live
 * conversation is noise, while silence is a lost customer.
 */
export async function isAdminOnline(supabase: any): Promise<boolean> {
  // ponytail: one unfiltered read per call, and the customer chat polls
  // /support/conversations every few seconds. support_messages has no index on
  // sender_role, so this can scan. Upgrade path when it shows up in timings:
  // cache the boolean in memory for ~60s — the offline window is 15 minutes, so
  // a minute of staleness changes nothing.
  const { data, error } = await supabase
    .schema("orders")
    .from("support_messages")
    .select("created_at")
    .eq("sender_role", "admin")
    .order("created_at", { ascending: false })
    .limit(1);

  if (error) {
    console.error("[Presence] admin activity lookup failed; treating admin as offline:", error.message);
    return false;
  }

  const latest = data?.[0]?.created_at;
  if (!latest) return false;

  const ageMinutes = (Date.now() - new Date(latest).getTime()) / 60000;
  if (!Number.isFinite(ageMinutes)) return false;

  return ageMinutes <= env.ADMIN_OFFLINE_AFTER_MINUTES;
}
