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
│   │   ├── admin.ts                 Admin dashboard, order/stock reads, support replies
│   │   ├── support.ts               Customer support chat (POST /support/messages)
│   │   └── webhooks.ts              POST /webhooks/payment  (HMAC-verified)
│   ├── services/
│   │   ├── checkoutService.ts       All reservation + payment logic (the saga)
│   │   ├── expirySweep.ts           Releases stock for reservations past expires_at
│   │   ├── conciergeBot.ts          Support bot: rule answers, then Claude fallback
│   │   ├── adminPresence.ts         Infers whether an admin is currently around
│   │   ├── supportOrders.ts         Owner-scoped order lookups shared with the bot
│   │   └── pushNotifications.ts     FCM pushes to admin/customer devices
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
| POST | `/support/messages` | Supabase bearer session | global 60/min |
| POST | `/internal/sweep-expired` | `x-internal-secret` | unlimited |

## Support bot

`POST /support/messages` answers on two engines, cheapest first:

1. **Rules** — deterministic branches in `services/conciergeBot.ts` over the
   `POLICY` block. Free, instant, and the only branch that reads the caller's
   live orders.
2. **Claude** — called only when no rule matched, with the caller's own recent
   orders and the catalogue as context. The prompt forbids inventing order IDs,
   amounts, tracking numbers or refund dates, and forbids claiming to have
   performed an action. Any model error or timeout returns `null`, so the
   customer still gets the topic menu.

Whether an admin is around is inferred, not tracked: `services/adminPresence.ts`
reads the timestamp of the most recent admin support message and treats anything
older than `ADMIN_OFFLINE_AFTER_MINUTES` as offline. While offline the bot
answers instead of staying silent, appends a follow-up promise, and pushes the
conversation into the admin queue. Before this, one admin reply flipped the
conversation to `open` permanently, after which the bot went silent forever and
an offline admin meant no reply at all.

Account context sent to the model is deliberately narrow — order IDs, statuses,
line items and public catalogue names. Email, phone and shipping address are
never included.

### Copy rules

Answers carry data, never destinations. The bot does not reply with a URL, a page
path or a link — the customer is already inside their own account, so
"/dashboard/orders" reads as a brush-off. Order answers list the status, courier,
tracking number and the item lines (name, size, quantity) drawn from that
customer's rows; when a detail is absent from the record, the bot says so instead
of pointing at a page. The same rule is stated in the model prompt, because a
model will otherwise reach for a path when it lacks a fact.

### Scope

The bot answers about this shop only. Two layers in
`services/conciergeScope.ts`:

1. `offTopicReason(message)` — deterministic, and it runs **before** the rules
   and before any model call, so an obvious off-topic ask costs nothing. It
   refuses when a known off-topic pattern (coding, homework, general knowledge,
   news, medical or legal advice, other shops, unrelated tasks, prompt
   extraction) matches and the message contains none of the shop's own
   vocabulary. Anything mentioned with shop words stays in scope — a wrongly
   refused order complaint is worse than a wasted model call.
2. A prompt rule: the model replies with the exact sentinel `OUT_OF_SCOPE` for
   anything pattern matching misses, and the route substitutes the canned
   `SCOPE_REPLY`. The customer-facing refusal text is therefore ours, not the
   model's.

An off-topic message is not queued for an admin — it is not work for a human,
and queuing it would drown the real ones. A request for a person still outranks
the scope check.


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
CONCIERGE_AI_ENABLED            default false; the model path is off unless "true"
ANTHROPIC_API_KEY               only needed once the flag above is true
CONCIERGE_MODEL                 default claude-sonnet-5-5
CONCIERGE_AI_HOURLY_LIMIT_PER_CUSTOMER   default 10
CONCIERGE_AI_DAILY_LIMIT        default 300
ADMIN_OFFLINE_AFTER_MINUTES     default 15
```

The model path is inert by default: it needs `CONCIERGE_AI_ENABLED=true` **and** a
key. A key on its own cannot start spending, so this code can be deployed before
any budget is agreed. Both caps are checked before every call, tokens are logged
per call, and a failed cap check skips the model rather than spending blind.

Adding or changing any of these on Railway requires a redeploy before the
running service sees the new value.

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
- **Admin presence is a guess.** It is derived from the last admin support
  message, so an admin who is reading the queue but not replying reads as
  offline, and an admin who replies once and then leaves reads as online for
  another `ADMIN_OFFLINE_AFTER_MINUTES`. A real heartbeat from the admin app
  would replace it; the admin app is not a repo, so this is a backend-only
  approximation.
- **No rate limit on model answers.** Every unmatched customer message triggers
  one Claude call. The per-customer hourly cap and the per-instance daily cap
  bound it, but the daily cap is in memory: it resets on redeploy and each
  instance keeps its own count, so N instances can spend N times the limit.
  Exact global accounting needs a counter table.
- **Bot answers are not versioned.** Editing `POLICY` changes what the bot tells
  customers, and the model paraphrases it, so two customers asking the same
  question can get differently-worded answers.
- **Scope layer 1 is a heuristic.** A question phrased with any shop word
  ("what fabric is a president's suit made of") passes the deterministic check
  and reaches the model, where only the prompt stops it. The prompt is the weaker
  of the two layers, and it is also the only thing stopping an off-topic answer
  when the rules miss.
