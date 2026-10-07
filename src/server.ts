import Fastify from "fastify";
import cors from "@fastify/cors";
import rateLimit from "@fastify/rate-limit";
import helmet from "@fastify/helmet";
import { env, corsOrigins } from "./config/env.js";
import { checkoutRoutes } from "./routes/checkout.js";
import { webhookRoutes } from "./routes/webhooks.js";
import { adminRoutes } from "./routes/admin.js";
import { supportRoutes } from "./routes/support.js";
import { sweepExpiredReservations } from "./services/expirySweep.js";
import { safeEqual } from "./lib/security.js";

// Only trust X-Forwarded-For when the TCP peer is our own platform proxy.
// Never `trustProxy: true` (a client-supplied header would be believed, so
// anyone could choose their own rate-limit bucket) and not a hop count
// (Fastify 5 disables it for the same reason).
//
// The default below assumes Railway's edge reaches the container from a
// private/CGNAT address. That is an assumption: confirm it by logging
// request.socket.remoteAddress for a real request, then pin TRUST_PROXY_CIDRS
// to exactly that range.
const TRUST_PROXY = process.env.TRUST_PROXY_CIDRS ?? "loopback,linklocal,uniquelocal,100.64.0.0/10";

const app = Fastify({ logger: true, trustProxy: TRUST_PROXY });

await app.register(helmet);

await app.register(rateLimit, {
  global: true,
  max: 60,
  timeWindow: "1 minute",
});

// Never echo internals (Postgrest messages, table/column names) to callers.
// 4xx keep their message (validation, 429); 5xx are logged and generic.
app.setErrorHandler((err: any, request, reply) => {
  const status = typeof err?.statusCode === "number" ? err.statusCode : 500;
  if (status >= 500) {
    request.log.error({ err }, "Unhandled error");
    return reply.status(status).send({ error: "Internal server error" });
  }
  return reply.status(status).send({ error: err?.message ?? "Request error" });
});

app.addContentTypeParser(
  "application/json",
  { parseAs: "string" },
  (req, body, done) => {
    const str = typeof body === "string" ? body : body.toString("utf-8");
    (req as any).rawBody = str;
    try {
      const json = str.length ? JSON.parse(str) : {};
      done(null, json);
    } catch (err) {
      // Malformed input is a client error, not a server fault. Fastify would
      // otherwise default to 500 and echo the parser's internals to the caller.
      // Razorpay also retries on 5xx, so a bad webhook delivery must not 500.
      req.log.warn({ err }, "Rejected malformed JSON body");
      const badRequest = new Error("Malformed JSON body") as Error & { statusCode: number };
      badRequest.statusCode = 400;
      done(badRequest, undefined);
    }
  }
);

await app.register(cors, {
  origin: corsOrigins,
  methods: ["GET", "POST"],
});

// Platform health checks must not consume (or be starved by) the shared bucket.
app.get("/health", { config: { rateLimit: false } }, async () => ({ status: "ok" }));

await app.register(checkoutRoutes);
await app.register(webhookRoutes);
await app.register(adminRoutes);
await app.register(supportRoutes);

app.post(
  "/internal/sweep-expired",
  // Throttled (not unlimited): an unthrottled secret check can be brute-forced.
  { config: { rateLimit: { max: 10, timeWindow: "1 minute" } } },
  async (request, reply) => {
    if (!env.INTERNAL_SWEEP_SECRET || !safeEqual(request.headers["x-internal-secret"], env.INTERNAL_SWEEP_SECRET)) {
      return reply.status(401).send({ error: "Unauthorized" });
    }
    const result = await sweepExpiredReservations();
    return reply.send(result);
  }
);

app
  .listen({ port: env.PORT, host: "0.0.0.0" })
  .then(() => app.log.info(`Server listening on port ${env.PORT}`))
  .catch((err) => {
    app.log.error(err);
    process.exit(1);
  });