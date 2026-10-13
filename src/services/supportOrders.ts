/**
 * Order lookups shared by the support route and the concierge bot.
 *
 * Every function here answers a question about ONE signed-in caller's own
 * orders. Ownership is decided by `checkout_metadata.userId`, which finalize
 * stamps from the session, so it is server-written and cannot be forged.
 * There is deliberately no email or phone fallback: anyone can register either.
 */

export const ORDER_SELECT = "id, reservation_id, razorpay_order_id, status, items, checkout_metadata, created_at";

/** True only when the order's recorded buyer is the signed-in caller. */
export function isOrderOwner(order: any, user: any): boolean {
  if (!order || !user) return false;

  const orderUserId = order?.checkout_metadata?.userId;
  return Boolean(orderUserId) && String(orderUserId) === String(user.id);
}

/**
 * Orders that belong to the signed-in caller, newest first.
 *
 * One jsonb filter on the buyer id written at finalize. Deliberately NOT built
 * as a PostgREST `or=` string: `or=` treats "," and ")" as syntax, so
 * interpolating an email like `a,b@x.com` silently widened the filter to other
 * customers' rows.
 */
export async function ownOrders(supabase: any, user: any, limit: number): Promise<any[]> {
  const { data, error } = await supabase
    .schema("orders")
    .from("checkout_reservations")
    .select(ORDER_SELECT)
    .eq("checkout_metadata->>userId", String(user.id))
    .order("created_at", { ascending: false })
    .limit(limit);

  if (error) {
    console.error("[Support] ownOrders failed:", error.message);
    return [];
  }
  return data ?? [];
}

/**
 * Look an order up by the identifier the caller quoted, then confirm ownership.
 * Exact match only — a substring match let one caller walk into another
 * customer's order by quoting a fragment of its id.
 */
export async function orderByQuotedId(supabase: any, targetId: string, user: any): Promise<any | null> {
  // The caller's own regex happens to permit only [A-Za-z0-9-] today, but this
  // helper must not depend on that. PostgREST `or=` treats "," "(" ")" "." and
  // ":" as syntax, so rebuild the guarantee here instead of inheriting it.
  if (!/^[A-Za-z0-9_-]{4,64}$/.test(targetId)) return null;

  const isUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(targetId);
  const filter = [
    `reservation_id.eq.${targetId}`,
    `razorpay_order_id.eq.${targetId}`,
    ...(isUuid ? [`id.eq.${targetId}`] : []),
  ].join(",");

  const { data } = await supabase
    .schema("orders")
    .from("checkout_reservations")
    .select(ORDER_SELECT)
    .or(filter)
    .order("created_at", { ascending: false })
    .limit(1);

  const found = (data ?? [])[0] ?? null;
  return isOrderOwner(found, user) ? found : null;
}

/** Display id for an order, used in bot copy. */
export function orderLabel(order: any): string {
  return String(order?.razorpay_order_id || order?.reservation_id || "N/A");
}

/** Line items in an order, tolerating both storage shapes seen in production. */
export function orderLines(order: any): any[] {
  const items = order?.items;
  if (Array.isArray(items?.items)) return items.items;
  return Array.isArray(items) ? items : [];
}

/** One line item, as the customer knows it. Fields beyond these are not read. */
export function itemLine(line: any): string {
  const name = line?.name || line?.productName || line?.sku || "Item";
  const size = line?.size ? " · size " + line.size : "";
  return name + size + " ×" + (line?.qty || 1);
}

/**
 * Status block for a single order.
 *
 * Details only — deliberately no page paths. Handing back "/dashboard/orders"
 * when the customer asked about their order reads as a brush-off, and the page
 * link is already in their own navigation.
 *
 * Lives here, with the lookups, because it reads order rows and imports no
 * config: that keeps it runnable from a plain script.
 */
export function describeOrder(order: any): string {
  const meta = order.checkout_metadata || {};
  const fulfillment = meta.fulfillmentStatus || (order.status === "committed" ? "Processing / Dispatched" : String(order.status ?? "").toUpperCase());
  const lines = orderLines(order);

  const facts = [
    "• Order ID: " + orderLabel(order),
    "• Status: " + fulfillment + (meta.courier ? " (" + meta.courier + ")" : ""),
  ];
  if (meta.trackingNumber) facts.push("• Tracking #: " + meta.trackingNumber);
  facts.push(
    lines.length
      ? "• Items:\n" + lines.slice(0, 5).map((line: any) => "   – " + itemLine(line)).join("\n")
      : "• Items: this order has no item lines stored, so I can only confirm its status."
  );

  const ret = meta.returnRequest || meta.return_request;
  if (ret) facts.push("• Return " + (ret.id ? ret.id + ": " : "") + (ret.status || "under review"));

  return "Your order:\n" + facts.join("\n");
}

/** One-line summary used when listing a customer's orders. */
export function orderSummaryLine(order: any): string {
  const meta = order.checkout_metadata || {};
  const status = meta.fulfillmentStatus || order.status || "unknown";
  const items = orderLines(order).slice(0, 2).map((line: any) => line?.name || line?.sku || "Item").join(", ");
  return "• " + orderLabel(order) + " — " + status + (items ? " — " + items : "");
}
