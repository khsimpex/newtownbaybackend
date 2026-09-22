import crypto from "node:crypto";
import type { FastifyInstance } from "fastify";
import { env } from "../config/env.js";
import { processPaymentEvent } from "../services/checkoutService.js";

function verifySignature(rawBody: string, signature: string): boolean {
  const expected = crypto
    .createHmac("sha256", env.RAZORPAY_WEBHOOK_SECRET)
    .update(rawBody)
    .digest("hex");

  // constant-time comparison to avoid timing attacks
  const a = Buffer.from(expected);
  const b = Buffer.from(signature);
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

export async function webhookRoutes(app: FastifyInstance) {
  // No rate limit: Razorpay retries deliveries, and throttling them drops
  // payment events. Auth is the HMAC below, not a request budget.
  app.post("/webhooks/payment", { config: { rateLimit: false } }, async (request, reply) => {
    // rawBody is attached by the content-type parser registered in
    // server.ts â€” HMAC verification MUST run over the exact raw bytes,
    // never the re-serialized parsed JSON object.
    const rawBody = (request as any).rawBody as string | undefined;
    const signature = request.headers["x-razorpay-signature"] as string | undefined;

    if (!rawBody || !signature) {
      return reply.status(400).send({ error: "Missing signature or body" });
    }

    if (!verifySignature(rawBody, signature)) {
      return reply.status(401).send({ error: "Invalid signature" });
    }

    const payload = JSON.parse(rawBody);
    const event = payload.event as string;
    const razorpayOrderId = payload.payload?.payment?.entity?.order_id as string | undefined;
    const razorpayPaymentId = payload.payload?.payment?.entity?.id as string | undefined;

    const result = await processPaymentEvent(event, razorpayOrderId, razorpayPaymentId);
    return reply.send(result);
  });
}

