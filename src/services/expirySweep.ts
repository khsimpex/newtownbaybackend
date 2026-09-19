import { createServiceClient } from "../db/supabaseClient.js";

type ReservationItem = { sku: string; qty: number };

export async function sweepExpiredReservations(): Promise<{
  swept: number;
  releasedItems: number;
}> {
  const supabase = createServiceClient();
  const now = new Date().toISOString();

  const { data: claimed, error: claimError } = await supabase
    .schema("orders")
    .from("checkout_reservations")
    .update({ status: "processing" })
    .eq("status", "pending")
    .lte("expires_at", now)
    .select("id, items");

  if (claimError) {
    throw new Error(`Could not claim expired reservations: ${claimError.message}`);
  }

  let releasedItems = 0;
  for (const reservation of claimed ?? []) {
    const items = reservation.items as ReservationItem[];
    for (const item of items) {
      const { error } = await supabase.schema("inventory").rpc("release_stock", {
        p_sku: item.sku,
        p_qty: item.qty,
      });
      if (error) {
        throw new Error(`Could not release stock for ${item.sku}: ${error.message}`);
      }
      releasedItems += 1;
    }

    const { error: updateError } = await supabase
      .schema("orders")
      .from("checkout_reservations")
      .update({ status: "expired" })
      .eq("id", reservation.id)
      .eq("status", "processing");

    if (updateError) {
      throw new Error(`Could not mark reservation expired: ${updateError.message}`);
    }
  }

  return { swept: claimed?.length ?? 0, releasedItems };
}