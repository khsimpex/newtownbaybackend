import type { FastifyReply, FastifyRequest } from "fastify";
import { createServiceClient } from "../db/supabaseClient.js";

const BEARER = /^Bearer\s+(.+)$/i;

/**
 * Customer authentication gate.
 *
 * Verifies the JWT with Supabase, once per request. No role check — this
 * answers "is there a signed-in account", not "is this an admin" (that is
 * requireAdmin's job).
 *
 * Verification is getUser, not a local decode: a forged or expired token is
 * rejected by Supabase rather than trusted off the header.
 */
export function makeRequireUser(getClient: () => any = createServiceClient) {
  return async function requireUser(request: FastifyRequest, reply: FastifyReply) {
    const token = request.headers.authorization?.match(BEARER)?.[1];
    if (!token) return reply.status(401).send({ error: "Sign in to place an order" });

    const supabase = getClient();
    const { data, error } = await supabase.auth.getUser(token);
    if (error || !data?.user) return reply.status(401).send({ error: "Invalid session" });
  };
}

export const requireUser = makeRequireUser();
