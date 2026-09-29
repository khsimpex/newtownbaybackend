import Fastify from "fastify";
import cors from "@fastify/cors";
import rateLimit from "@fastify/rate-limit";
import helmet from "@fastify/helmet";
import { env, corsOrigins } from "./config/env.js";
import { checkoutRoutes } from "./routes/checkout.js";
import { webhookRoutes } from "./routes/webhooks.js";
import { adminRoutes } from "./routes/admin.js";
import { sweepExpiredReservations } from "./services/expirySweep.js";

const app = Fastify({ logger: true });

await app.register(helmet);

await app.register(rateLimit, {
  global: true,
  max: 60,
  timeWindow: "1 minute",
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

app.get("/health", async () => ({ status: "ok" }));

await app.register(checkoutRoutes);
await app.register(webhookRoutes);
await app.register(adminRoutes);

app.post(
  "/internal/sweep-expired",
  { config: { rateLimit: false } },
  async (request, reply) => {
    const providedSecret = request.headers["x-internal-secret"];
    if (!env.INTERNAL_SWEEP_SECRET || providedSecret !== env.INTERNAL_SWEEP_SECRET) {
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