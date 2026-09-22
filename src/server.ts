import Fastify from "fastify";
import cors from "@fastify/cors";
import rateLimit from "@fastify/rate-limit";
import helmet from "@fastify/helmet";
import { env, corsOrigins } from "./config/env.js";
import { checkoutRoutes } from "./routes/checkout.js";
import { webhookRoutes } from "./routes/webhooks.js";
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
      done(err as Error, undefined);
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

app.addHook("onRoute", (routeOptions) => {
  if (routeOptions.url === "/webhooks/payment") {
    routeOptions.config = { ...routeOptions.config, rateLimit: false };
  }
  if (routeOptions.url === "/checkout/reserve") {
    routeOptions.config = {
      ...routeOptions.config,
      rateLimit: { max: 10, timeWindow: "1 minute" },
    };
  }
});

app
  .listen({ port: env.PORT, host: "0.0.0.0" })
  .then(() => app.log.info(`Server listening on port ${env.PORT}`))
  .catch((err) => {
    app.log.error(err);
    process.exit(1);
  });