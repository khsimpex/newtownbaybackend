import type { FastifyReply, FastifyRequest } from "fastify";
import { createServiceClient } from "../db/supabaseClient.js";

declare module "fastify" {
  interface FastifyRequest {
    adminUser?: { id: string; email: string | null };
  }
}

const BEARER = /^Bearer\s+(.+)$/i;

/**
 * Single admin gate for the backend.
 *
 * - Verifies the JWT with Supabase (getUser), once per request.
 * - Authorises ONLY via the is_admin() RPC. There is deliberately no fallback
 *   to profiles.role: if the RPC errors or returns a non-boolean we deny.
 * - Attaches the verified identity to request.adminUser so handlers never
 *   re-parse the token.
 */
export function makeRequireAdmin(getClient: () => any = createServiceClient) {
  return async function requireAdmin(request: FastifyRequest, reply: FastifyReply) {
    const token = request.headers.authorization?.match(BEARER)?.[1];
    if (!token) return reply.status(401).send({ error: "Authentication required" });

    const supabase = getClient();
    const { data, error } = await supabase.auth.getUser(token);
    if (error || !data?.user) return reply.status(401).send({ error: "Invalid session" });

    let isAdmin = false;
    try {
      const result = await supabase.rpc("is_admin", { uid: data.user.id });
      if (result.error || typeof result.data !== "boolean") {
        request.log.error({ err: result.error, userId: data.user.id }, "is_admin check failed; denying");
        return reply.status(503).send({ error: "Authorization unavailable" });
      }
      isAdmin = result.data;
    } catch (err) {
      request.log.error({ err, userId: data.user.id }, "is_admin threw; denying");
      return reply.status(503).send({ error: "Authorization unavailable" });
    }

    if (!isAdmin) return reply.status(403).send({ error: "Admin access required" });

    request.adminUser = { id: data.user.id, email: data.user.email ?? null };
    // Minimal audit trail: who hit which route (route pattern, not the URL, so PII in params stays out of logs).
    request.log.info(
      { adminId: data.user.id, method: request.method, route: request.routeOptions?.url },
      "admin request"
    );
  };
}

export const requireAdmin = makeRequireAdmin();

/** Use inside handlers; throws loudly if the hook was never applied. */
export function adminOf(request: FastifyRequest) {
  if (!request.adminUser) throw new Error("adminUser missing: requireAdmin hook not applied");
  return request.adminUser;
}