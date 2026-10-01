# Architecture

Fastify + Supabase + Razorpay backend for the Newtownbay drop checkout. Guest
checkout, no auth. Holds stock behind a reserved-quantity counter so two buyers
can't claim the last unit.

## Tree

```
newtownbay-backend-ts/
├── src/
│   ├── server.ts                    Fastify bootstrap: plugins, JSON parser, rate limits, routes
│   ├── config/
│   │   └── env.ts                   Zod-validated env; exits at boot if anything is missing
│   ├── routes/
│   │   ├── checkout.ts              POST /checkout/{reserve,verify,release}
│   │   └── webhooks.ts              POST /webhooks/payment  (HMAC-verified)
│   ├── services/
│   │   ├── checkoutService.ts       All reservation + payment logic (the saga)
│   │   └── expirySweep.ts           Releases stock for reservations past expires_at
│   ├── db/
│   │   └── supabaseClient.ts        Service-role client (bypasses RLS — server only)
│   └── types/
│       ├── checkout.ts              Zod request schemas + bounds
│       └── database.types.ts        Supabase type stub — regenerate from live schema
├── package.json                     dev / build / start / typecheck
└── ARCHITECTURE.md                  this file
```

## Endpoints

| Method | Path | Auth | Rate limit |
|---|---|---|---|
| GET | `/health` | none | global 60/min |
| GET | `/admin/overview` | Supabase bearer session + admin role | global 60/min |
| GET | `/admin/orders` | Supabase bearer session + admin role | global 60/min |
| GET | `/admin/inventory` | Supabase bearer session + admin role | global 60/min |
| GET | `/admin/products` | Supabase bearer session + admin role | global 60/min |
| POST | `/checkout/reserve` | none | 10/min |
| POST | `/checkout/verify` | Razorpay signature | global |
| POST | `/checkout/release` | `reservationSecret` | global |
| POST | `/webhooks/payment` | Razorpay HMAC | unlimited |
| POST | `/internal/sweep-expired` | `x-internal-secret` | unlimited |

## The flow

### 1. Reserve — `createReservation`

```
client sends { items: [{sku, qty}] }        ← never a price
  ↓ per SKU
  getAuthoritativeItem()   price from inventory.stock_levels   unknown SKU → 400
  reserve_stock RPC        available_qty → reserved_qty        depleted → 409
  ↓
  subtotal from server prices; shipping free over ₹999, else ₹150
  Razorpay order created (amount in paise)
  orders.checkout_reservations row inserted, status='pending', expires_at = +15min
  ↓ any failure in this half
  rollbackAll() releases every SKU already locked
```

Returns `{ reservationId, reservationSecret, razorpayOrderId, amount, currency }`.
The secret is the only thing that can release the reservation — it exists so
reservation IDs can't be guessed and enumerated by a griefer mid-drop.

### 2. Pay, then confirm

Two independent paths, same destination. Both call `processPaymentEvent`.

- **`/checkout/verify`** — client calls it right after Razorpay Checkout closes.
  Verifies HMAC(`order_id|payment_id`), then fetches the payment from Razorpay
  to confirm status is `captured`. Exists only for fast UI feedback.
- **`/webhooks/payment`** — Razorpay calls it. HMAC over the **raw bytes**
  (the custom JSON parser in `server.ts` attaches `rawBody` for this). This is
  the durable source of truth.

### 3. The atomic claim

`processPaymentEvent` is the whole idempotency story:

```sql
UPDATE checkout_reservations SET status='processing'
WHERE razorpay_order_id = ? AND status='pending'
RETURNING *
```

Only the caller that flips the row gets to act. Webhook retries, and the
webhook racing a client `/verify`, both become safe no-ops. Whichever arrives
first wins.

### 4. Commit or release

| Event | Stock RPC | Final status |
|---|---|---|
| `order.paid` | `commit_stock` (reserved → physical) | `committed` |
| `payment.failed` | `release_stock` (reserved → available) | `released` |
| anything else | none | back to `pending` |

### 5. Cancel — `releaseReservation`

Same atomic claim, but keyed on `reservation_id` **and** `reservation_secret`
**and** `status='pending'`. Then `release_stock` per item, status → `released`.

### 6. Expiry — `sweepExpiredReservations`

Claims rows where `status='pending' AND expires_at <= now()` → `processing`,
releases stock, marks `expired`. Called by `POST /internal/sweep-expired`, so
it needs an external scheduler (Railway cron or similar) — the app doesn't
self-schedule.

## Status machine

```
                 reserve        claim          order.paid
   (none) ──────────────► pending ──────► processing ──────► committed
                             ▲                │
                             │ unhandled      ├──── payment.failed ──► released
                             └────────────────┤
                                              ├──── /checkout/release ─► released
                                              └──── sweep ─────────────► expired
```

`processing` is a lock, not a resting state. Nothing should sit there.

## Database

Shared with the Next.js app — same Supabase project, same RLS policies. This
backend makes no schema changes.

The RPC bodies live in the Supabase project, **not in this repo** — only the
call sites are here. Column names below come from `database.types.ts`;
which counter each RPC moves is inferred from the call sites, so read the SQL
before relying on it.

- **`inventory.stock_levels`** — `available_qty`, `reserved_qty`, `physical_qty` per SKU.
- **`inventory.reserve_stock(p_sku, p_qty)` → boolean** — available → reserved. `false` means depleted.
- **`inventory.release_stock(p_sku, p_qty)`** — reserved → available.
- **`inventory.commit_stock(p_sku, p_qty)`** — reserved → physical.
- **`orders.checkout_reservations`** — one row per attempt. `items` holds the
  server-priced snapshot, never client input.

Regenerate `src/types/database.types.ts` after schema changes:

```bash
npx supabase gen types typescript --project-id <ref> > src/types/database.types.ts
```

The committed file is a loose stub; until it's regenerated, Supabase calls
compile without type safety.

## Config

All required unless noted. Validated at boot — missing vars exit the process.

Admin access uses the same `is_admin(uid)` RPC and `profiles.role` fallback as
the Next.js admin app. The mobile app sends its Supabase access token as a
Bearer token.

```
SUPABASE_URL                    SUPABASE_SERVICE_ROLE_KEY
RAZORPAY_KEY_ID                 RAZORPAY_KEY_SECRET        RAZORPAY_WEBHOOK_SECRET
INTERNAL_SWEEP_SECRET           min 16 chars; openssl rand -hex 32
ALLOWED_ORIGINS                 default http://localhost:3000
PORT                            default 8000
```

## Run

```bash
npm run dev         # tsx watch
npm run typecheck   # tsc --noEmit
npm run build && npm start
```

## Known gaps

- **Stuck `processing` rows.** Both the sweep and `releaseReservation` claim to
  `processing` before touching stock. If the process dies between claim and
  final write, the row is stranded and no sweep will ever revisit it (it only
  selects `pending`). Needs a reaper with a claim timeout.
- **Swallowed RPC errors.** `commitSku` / `releaseSku` log and return void. A
  failed `commit_stock` still marks the reservation `committed` — charged, but
  inventory never decremented. No reconciliation job.
- **No idempotency key on `/checkout/reserve`.** A double-submit locks stock twice.
- **No tests.** No test dir, no `test` script. The concurrency above is exactly
  what a concurrent-claim test would pin down.
- **`razorpayPaymentId`** is threaded into `processPaymentEvent` but never
  persisted — no payment-ID trail for reconciliation.
- **`reservation_secret`** stored plaintext.
