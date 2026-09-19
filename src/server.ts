import Fastify from "fastify";
import cors from "@fastify/cors";
import rateLimit from "@fastify/rate-limit";
import helmet from "@fastify/helmet";
import { env, corsOrigins } from "./config/env.js";
import { checkoutRoutes } from "./routes/checkout.js";
import { webhookRoutes } from "./routes/webhooks.js";
import { sweepExpiredReservations } from "./services/expirySweep.js";

const app = Fastify({ logger: true });

// Security headers. Default config is fine for a JSON API — no CSP tuning
// needed since this service never serves HTML.
await app.register(helmet);

// Global default rate limit. Individual routes below override this with
// tighter or looser config as appropriate — a single blanket number is
// wrong here: /checkout/reserve should be tight (one person has no
// legitimate reason to hit it 60x/min), while /webhooks/payment must NOT
// be throttled by IP, since Razorpay can legitimately burst-deliver many
// webhooks in the same minute during a successful drop.
await app.register(rateLimit, {
  global: true,
  max: 60,
  timeWindow: "1 minute",
});

// Capture the raw request body alongside the parsed JSON. The webhook and
// sweep routes need the exact raw bytes / exact header comparison — see
// individual route files for how this is used.
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

// ---------------------------------------------------------------------------
// Internal expiry sweep — called by an external scheduler (Railway cron,
// cron-job.org, etc.), never by the storefront or a customer. Protected by
// a shared secret header, and exempt from the global IP rate limit since
// the scheduler is a trusted, known caller hitting it on its own schedule.
// ---------------------------------------------------------------------------
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

// Explicitly exempt the payment webhook from the global rate limit —
// Razorpay is the only caller (verified by HMAC signature), and throttling
// it by IP risks dropping legitimate webhook deliveries during a busy drop.
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