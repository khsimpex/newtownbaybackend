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