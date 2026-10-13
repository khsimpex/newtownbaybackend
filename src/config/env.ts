import "dotenv/config";
import { z } from "zod";

// Fail fast at startup if any required env var is missing, rather than
// discovering it mid-request when a checkout is in flight.
const envSchema = z.object({
  SUPABASE_URL: z.string().url(),
  SUPABASE_SERVICE_ROLE_KEY: z.string().min(1),

  RAZORPAY_KEY_ID: z.string().min(1),
  RAZORPAY_KEY_SECRET: z.string().min(1),
  RAZORPAY_WEBHOOK_SECRET: z.string().min(1),

  ALLOWED_ORIGINS: z.string().default("http://localhost:3000"),
  PORT: z.coerce.number().default(8000),

  // Shared secret required in the X-Internal-Secret header to call
  // /internal/sweep-expired. Generate with: openssl rand -hex 32
  INTERNAL_SWEEP_SECRET: z.string().min(16),
  FIREBASE_SERVICE_ACCOUNT_JSON: z.string().min(1).optional(),

  // Concierge bot. The paid model path is OFF unless CONCIERGE_AI_ENABLED is
  // exactly "true" AND a key is present, so deploying this code costs nothing
  // and a stray key alone cannot start spending.
  CONCIERGE_AI_ENABLED: z
    .string()
    .default("false")
    .transform((value) => value.trim().toLowerCase() === "true"),
  ANTHROPIC_API_KEY: z.string().min(1).optional(),
  CONCIERGE_MODEL: z.string().min(1).default("claude-sonnet-5-5"),

  // Spend caps. The per-customer cap is enforced from the database, so it
  // survives redeploys. The daily cap is per running instance and resets on
  // restart — it is a backstop, not an accounting ledger.
  CONCIERGE_AI_HOURLY_LIMIT_PER_CUSTOMER: z.coerce.number().int().nonnegative().default(10),
  CONCIERGE_AI_DAILY_LIMIT: z.coerce.number().int().nonnegative().default(300),

  // An admin counts as offline when no admin has sent a support message for
  // this many minutes. While offline the bot answers instead of staying silent.
  ADMIN_OFFLINE_AFTER_MINUTES: z.coerce.number().int().positive().default(15),
});

const parsed = envSchema.safeParse(process.env);

if (!parsed.success) {
  console.error("❌ Invalid environment configuration:");
  console.error(parsed.error.format());
  process.exit(1);
}

export const env = parsed.data;

export const corsOrigins = env.ALLOWED_ORIGINS.split(",")
  .map((o) => o.trim())
  .filter(Boolean);
