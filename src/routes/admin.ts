import type { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import { z } from "zod";
import { env } from "../config/env.js";
import { createServiceClient } from "../db/supabaseClient.js";

const orderQuerySchema = z.object({
  page: z.coerce.number().int().positive().default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(25),
  status: z.enum(["pending", "processing", "committed", "released", "expired"]).optional(),
});

async function requireAdmin(request: FastifyRequest, reply: FastifyReply) {
  const accessToken = request.headers.authorization?.match(/^Bearer\s+(.+)$/i)?.[1];
  if (!accessToken) {
    return reply.status(401).send({ error: "Authentication required" });
  }

  const { data, error } = await createServiceClient().auth.getUser(accessToken);
  if (error || !data.user) {
    return reply.status(401).send({ error: "Invalid session" });
  }
  // app_metadata, not user_metadata: app_metadata is server-controlled and
  // cannot be set by the signed-in user, so it is safe to authorise on.
  if (data.user.app_metadata?.role !== "admin") {
    return reply.status(403).send({ error: "Admin access required" });
  }
}

export async function adminRoutes(app: FastifyInstance) {
  app.addHook("preHandler", requireAdmin);

  app.get("/admin/overview", async (_request, reply) => {
    const supabase = createServiceClient();
    const countStatus = async (status?: string) => {
      let query = supabase
        .schema("orders")
        .from("checkout_reservations")
        .select("id", { count: "exact", head: true });
      if (status) query = query.eq("status", status);
      const { count, error } = await query;
      if (error) throw error;
      return count ?? 0;
    };

    const [total, pending, committed, released, expired, stockResult] = await Promise.all([
      countStatus(),
      countStatus("pending"),
      countStatus("committed"),
      countStatus("released"),
      countStatus("expired"),
      supabase.schema("inventory").from("stock_levels").select("available_qty"),
    ]);
    if (stockResult.error) throw stockResult.error;

    return reply.send({
      orders: { total, pending, committed, released, expired },
      lowStock: (stockResult.data ?? []).filter((item) => item.available_qty <= 5).length,
    });
  });

  app.get("/admin/orders", async (request, reply) => {
    const parsed = orderQuerySchema.safeParse(request.query);
    if (!parsed.success) {
      return reply.status(400).send({ error: "Invalid query", details: parsed.error.flatten() });
    }

    const { page, pageSize, status } = parsed.data;
    let query = createServiceClient()
      .schema("orders")
      .from("checkout_reservations")
      .select(
        "id,reservation_id,razorpay_order_id,customer_name,customer_email,customer_phone,shipping_address,items,status,expires_at,created_at",
        { count: "exact" }
      )
      .order("created_at", { ascending: false });
    if (status) query = query.eq("status", status);

    const { data, count, error } = await query.range((page - 1) * pageSize, page * pageSize - 1);
    if (error) throw error;
    return reply.send({ data: data ?? [], total: count ?? 0, page, pageSize });
  });

  app.get("/admin/inventory", async (_request, reply) => {
    const { data, error } = await createServiceClient()
      .schema("inventory")
      .from("stock_levels")
      // available_qty + reserved_qty is the on-hand truth. physical_qty is not
      // written by any inventory RPC, so returning it would show operators a
      // stale number that looks authoritative.
      .select("sku,product_id,size,color,available_qty,reserved_qty,updated_at")
      .order("sku", { ascending: true });
    if (error) throw error;
    return reply.send({ data: data ?? [] });
  });
}