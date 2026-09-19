/**
 * Core checkout + inventory logic.
 *
 * Saga pattern:
 *   1. Lock stock (available_qty -> reserved_qty) via inventory.reserve_stock RPC.
 *   2. Create the Razorpay order + a `checkout_reservations` row.
 *   3. On webhook OR client-side verify: atomically claim the reservation
 *      (pending -> processing) so concurrent callers (webhook retries, or
 *      the webhook racing the client's /verify call) can't double-process
 *      it, then commit or release stock based on the payment outcome.
 *
 * SECURITY NOTES (see audit):
 *   - Price is ALWAYS looked up server-side from inventory.stock_levels.
 *     The client sends only { sku, qty } â€” never trust a client-supplied
 *     price, even for "custom" or unrecognized SKUs. Unknown SKUs are
 *     rejected outright rather than falling back to any price.
 *   - Every reservation gets a random `reservation_secret`. Cancelling or
 *     releasing a reservation requires that secret, not just the
 *     reservation_id â€” this closes the anonymous-release/IDOR path where
 *     someone could grief other customers' checkouts during a drop by
 *     guessing or incrementing reservation IDs.
 *   - verifyPayment() requires a signature (no bypass), verifies it with
 *     constant-time comparison, AND independently confirms the payment's
 *     status directly against Razorpay's API before committing stock. The
 *     signature alone is never treated as sufficient â€” this endpoint is a
 *     fast-UI-feedback path, not a replacement for the webhook.
 *   - If step 2 of createReservation fails (Razorpay API error, DB insert
 *     error), every SKU locked in step 1 is released immediately â€” never
 *     leave stock stuck in reserved_qty with no reservation record.
 */
import crypto from "node:crypto";
import Razorpay from "razorpay";
import { createServiceClient } from "../db/supabaseClient.js";
import { env } from "../config/env.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** What the client is allowed to send â€” no price, no name. */
export interface RequestedItem {
  sku: string;
  qty: number;
}

/** What we actually charge and store, after server-side price lookup. */
interface PricedItem {
  sku: string;
  qty: number;
  price: number;
  name: string;
}

export type ReserveResult =
  | {
      ok: true;
      reservationId: string;
      reservationSecret: string;
      razorpayOrderId: string;
      amount: number;
      currency: "INR";
    }
  | { ok: false; status: number; error: string; depletedSku?: string };

export type VerifyResult =
  | { ok: true; status: string }
  | { ok: false; status: number; error: string };

export type ReleaseResult =
  | { ok: true; status: "released" }
  | { ok: false; status: number; error: string };

export type WebhookResult = { status: string };

type ReservedSku = { sku: string; qty: number };

// ---------------------------------------------------------------------------
// Low-level RPC wrappers (service-role only)
// ---------------------------------------------------------------------------

async function reserveSku(
  supabase: ReturnType<typeof createServiceClient>,
  sku: string,
  qty: number
): Promise<boolean> {
  const { data, error } = await supabase.schema("inventory").rpc("reserve_stock", {
    p_sku: sku,
    p_qty: qty,
  });
  if (error) {
    console.error(`reserve_stock failed for ${sku}:`, error.message);
    return false;
  }
  return Boolean(data);
}

async function releaseSku(
  supabase: ReturnType<typeof createServiceClient>,
  sku: string,
  qty: number
): Promise<void> {
  const { error } = await supabase.schema("inventory").rpc("release_stock", {
    p_sku: sku,
    p_qty: qty,
  });
  if (error) {
    console.error(`CRITICAL: release_stock failed for ${sku}:`, error.message);
  }
}

async function commitSku(
  supabase: ReturnType<typeof createServiceClient>,
  sku: string,
  qty: number
): Promise<void> {
  const { error } = await supabase.schema("inventory").rpc("commit_stock", {
    p_sku: sku,
    p_qty: qty,
  });
  if (error) {
    console.error(`CRITICAL: commit_stock failed for ${sku}:`, error.message);
  }
}

async function rollbackAll(
  supabase: ReturnType<typeof createServiceClient>,
  reserved: ReservedSku[]
): Promise<void> {
  for (const item of reserved) {
    await releaseSku(supabase, item.sku, item.qty);
  }
}

function newReservationId(): string {
  return `RES_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
}

function newSecret(): string {
  return crypto.randomBytes(24).toString("hex");
}

/**
 * The ONLY place price is determined. Looks up the real price + a display
 * name from inventory.stock_levels by SKU. Returns null for any SKU that
 * doesn't exist â€” callers must reject the whole reservation in that case,
 * never fall back to a client-supplied or default price.
 */
async function getAuthoritativeItem(
  supabase: ReturnType<typeof createServiceClient>,
  sku: string
): Promise<{ sku: string; price: number; name: string } | null> {
  const { data, error } = await supabase
    .schema("inventory")
    .from("stock_levels")
    .select("sku, price, size, color")
    .eq("sku", sku)
    .single();

  if (error || !data) return null;
  return {
    sku: data.sku,
    price: Number(data.price),
    name: `${data.color} / ${data.size}`,
  };
}

// ---------------------------------------------------------------------------
// Public: create reservation
// ---------------------------------------------------------------------------

export async function createReservation(
  requestedItems: RequestedItem[],
  phone?: string,
  customerName?: string,
  customerEmail?: string,
  shippingAddress?: Record<string, string>
): Promise<ReserveResult> {
  if (!requestedItems || requestedItems.length === 0) {
    return { ok: false, status: 400, error: "Cart contains no items" };
  }

  const supabase = createServiceClient();
  const reserved: ReservedSku[] = [];
  const priced: PricedItem[] = [];

  // Step 1: for each requested sku, resolve the REAL price server-side,
  // then lock stock. Reject unknown SKUs outright â€” never guess a price.
  for (const req of requestedItems) {
    if (!req.sku || !req.qty || req.qty <= 0) {
      await rollbackAll(supabase, reserved);
      return { ok: false, status: 400, error: "Invalid item in cart" };
    }

    const item = await getAuthoritativeItem(supabase, req.sku);
    if (!item) {
      await rollbackAll(supabase, reserved);
      return { ok: false, status: 400, error: `Unknown SKU: ${req.sku}` };
    }

    const success = await reserveSku(supabase, req.sku, req.qty);
    if (!success) {
      await rollbackAll(supabase, reserved);
      return {
        ok: false,
        status: 409,
        error: `Insufficient inventory for ${item.name}.`,
        depletedSku: req.sku,
      };
    }

    reserved.push({ sku: req.sku, qty: req.qty });
    priced.push({ sku: req.sku, qty: req.qty, price: item.price, name: item.name });
  }

  const subtotal = priced.reduce((acc, i) => acc + i.price * i.qty, 0);
  const shipping = subtotal >= 999 || subtotal === 0 ? 0 : 150;
  const amountInPaise = Math.round((subtotal + shipping) * 100);
  const reservationId = newReservationId();
  const secret = newSecret();

  // Step 2: gateway order + DB record. Any failure here rolls back Step 1.
  try {
    const razorpay = new Razorpay({
      key_id: env.RAZORPAY_KEY_ID,
      key_secret: env.RAZORPAY_KEY_SECRET,
    });

    const rzpOrder = await razorpay.orders.create({
      amount: amountInPaise,
      currency: "INR",
      receipt: reservationId,
      notes: { reservation_id: reservationId },
    });

    const { error: dbError } = await supabase
      .schema("orders")
      .from("checkout_reservations")
      .insert({
        reservation_id: reservationId,
        reservation_secret: secret,
        razorpay_order_id: rzpOrder.id,
        customer_phone: phone ?? null,
        customer_name: customerName ?? null,
        customer_email: customerEmail ?? null,
        shipping_address: shippingAddress ?? null,
        items: priced, // server-priced snapshot, not client input
        status: "pending",
        expires_at: new Date(Date.now() + 15 * 60 * 1000).toISOString(),
      });

    if (dbError) throw new Error(`Reservation insert failed: ${dbError.message}`);

    return {
      ok: true,
      reservationId,
      reservationSecret: secret,
      razorpayOrderId: rzpOrder.id,
      amount: amountInPaise,
      currency: "INR",
    };
  } catch (err) {
    await rollbackAll(supabase, reserved);
    console.error("CRITICAL: reservation step 2 failed:", err);
    return { ok: false, status: 500, error: "Reservation failed after stock lock" };
  }
}

// ---------------------------------------------------------------------------
// Public: client-side payment verification (fast UI feedback path)
//
// This is NOT the durable source of truth â€” the webhook is. This exists so
// the checkout page can show "Payment confirmed" immediately after Razorpay
// Checkout succeeds, instead of waiting for webhook delivery. It reuses the
// same atomic claim in processPaymentEvent, so whichever of {this call, the
// webhook} arrives first wins, and the second is a safe no-op.
// ---------------------------------------------------------------------------

export async function verifyPayment(
  razorpayOrderId: string,
  razorpayPaymentId: string,
  razorpaySignature: string | undefined
): Promise<VerifyResult> {
  if (!razorpayOrderId || !razorpayPaymentId) {
    return { ok: false, status: 400, error: "Missing order or payment id" };
  }

  // No signature, no verification â€” full stop. This is the fix for the
  // audit's critical signature-bypass finding.
  if (!razorpaySignature) {
    return { ok: false, status: 400, error: "Missing required payment signature" };
  }

  const expected = crypto
    .createHmac("sha256", env.RAZORPAY_KEY_SECRET)
    .update(`${razorpayOrderId}|${razorpayPaymentId}`)
    .digest("hex");

  const sigBuf = Buffer.from(razorpaySignature);
  const expBuf = Buffer.from(expected);
  if (sigBuf.length !== expBuf.length || !crypto.timingSafeEqual(sigBuf, expBuf)) {
    return { ok: false, status: 401, error: "Invalid payment signature" };
  }

  // Don't stop at "the signature matches" â€” confirm directly with Razorpay
  // that this payment actually shows as captured. A signature alone proves
  // the payload wasn't tampered with in transit; it does not by itself
  // prove money moved, so we ask Razorpay's API for ground truth too.
  try {
    const razorpay = new Razorpay({
      key_id: env.RAZORPAY_KEY_ID,
      key_secret: env.RAZORPAY_KEY_SECRET,
    });
    const payment = await razorpay.payments.fetch(razorpayPaymentId);

    if (payment.status !== "captured") {
      return {
        ok: false,
        status: 402,
        error: `Payment not captured (status: ${payment.status})`,
      };
    }
  } catch (err) {
    console.error("Razorpay payment fetch failed during verify:", err);
    return { ok: false, status: 502, error: "Could not confirm payment with gateway" };
  }

  const result = await processPaymentEvent("order.paid", razorpayOrderId, razorpayPaymentId);
  return { ok: true, status: result.status };
}

// ---------------------------------------------------------------------------
// Public: customer-initiated reservation release/cancel.
//
// Requires the reservation_secret issued at creation time â€” NOT just the
// reservation_id â€” so a reservation can't be released by anyone who merely
// guesses or enumerates IDs (fixes the audit's IDOR finding). This supports
// guest checkout since it doesn't depend on an authenticated session.
// ---------------------------------------------------------------------------

export async function releaseReservation(
  reservationId: string,
  reservationSecret: string
): Promise<ReleaseResult> {
  if (!reservationId || !reservationSecret) {
    return { ok: false, status: 400, error: "reservationId and reservationSecret are required" };
  }

  const supabase = createServiceClient();

  // Same atomic-claim pattern as the webhook: only succeeds if the row is
  // still "pending" AND the secret matches, preventing races and guesses.
  const { data: claimed, error } = await supabase
    .schema("orders")
    .from("checkout_reservations")
    .update({ status: "processing" })
    .eq("reservation_id", reservationId)
    .eq("reservation_secret", reservationSecret)
    .eq("status", "pending")
    .select()
    .single();

  if (error || !claimed) {
    return { ok: false, status: 404, error: "Reservation not found or already processed" };
  }

  const items = claimed.items as { sku: string; qty: number }[];
  for (const item of items) {
    await releaseSku(supabase, item.sku, item.qty);
  }

  await supabase
    .schema("orders")
    .from("checkout_reservations")
    .update({ status: "released" })
    .eq("id", claimed.id);

  return { ok: true, status: "released" };
}

// ---------------------------------------------------------------------------
// Public: process a payment webhook event (durable source of truth)
// ---------------------------------------------------------------------------

export async function processPaymentEvent(
  event: string,
  razorpayOrderId: string | undefined,
  razorpayPaymentId?: string
): Promise<WebhookResult> {
  if (!razorpayOrderId) {
    return { status: "ignored_no_order_id" };
  }

  const supabase = createServiceClient();

  // Atomic claim: prevents two concurrent/retried callers (webhook retries,
  // or this webhook racing a client verifyPayment() call) from both
  // processing the same reservation. Only the caller that flips
  // pending -> processing gets to act on it.
  const { data: claimed, error: claimErr } = await supabase
    .schema("orders")
    .from("checkout_reservations")
    .update({ status: "processing" })
    .eq("razorpay_order_id", razorpayOrderId)
    .eq("status", "pending")
    .select()
    .single();

  if (claimErr || !claimed) {
    return { status: "already_processed_or_not_found" };
  }

  const items = claimed.items as { sku: string; qty: number }[];

  if (event === "order.paid") {
    for (const item of items) {
      await commitSku(supabase, item.sku, item.qty);
    }
    await supabase
      .schema("orders")
      .from("checkout_reservations")
      .update({ status: "committed" })
      .eq("id", claimed.id);
    return { status: "committed_successfully" };
  }

  if (event === "payment.failed") {
    for (const item of items) {
      await releaseSku(supabase, item.sku, item.qty);
    }
    await supabase
      .schema("orders")
      .from("checkout_reservations")
      .update({ status: "released" })
      .eq("id", claimed.id);
    return { status: "released_successfully" };
  }

  // Unrecognized event: put it back to pending so a real event or your
  // expiry sweep can still act on it â€” don't leave it stuck on "processing".
  await supabase
    .schema("orders")
    .from("checkout_reservations")
    .update({ status: "pending" })
    .eq("id", claimed.id);

  return { status: "unhandled_event" };
}
