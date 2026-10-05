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

  const supabase = createServiceClient();
  const { data, error } = await supabase.auth.getUser(accessToken);
  if (error || !data.user) {
    return reply.status(401).send({ error: "Invalid session" });
  }

  let isAdmin = false;
  try {
    const result = await supabase.rpc("is_admin", { uid: data.user.id });
    if (!result.error && typeof result.data === "boolean") {
      isAdmin = result.data;
    } else {
      const { data: profile, error: profileError } = await supabase
        .from("profiles")
        .select("role")
        .eq("id", data.user.id)
        .maybeSingle();
      isAdmin = !profileError && profile?.role === "admin";
    }
  } catch {
    return reply.status(403).send({ error: "Admin access required" });
  }

  if (!isAdmin) {
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

  app.get("/admin/products", async (_request, reply) => {
    // Order line items carry their own `sku`, and that value matches
    // products.sku_prefix, not stock_levels.sku (a different numbering, e.g.
    // stock_levels "NB-1008-MEHROON-XXL" vs products "NTB-BO-420-OBS-0595").
    // stock_levels.product_id is null on every row, so the prefix is the only
    // join that resolves. Images live only here.
    const { data, error } = await createServiceClient()
      .schema("inventory")
      .from("products")
      .select("sku_prefix,name,color,category,image,images,status")
      .order("name", { ascending: true });
    if (error) throw error;
    return reply.send({ data: data ?? [] });
  });

  app.get("/admin/customers", async (request, reply) => {
    const querySchema = z.object({
      q: z.string().trim().max(100).optional(),
      page: z.coerce.number().int().positive().default(1),
      pageSize: z.coerce.number().int().min(1).max(100).default(50),
    });
    const parsed = querySchema.safeParse(request.query);
    if (!parsed.success) return reply.status(400).send({ error: "Invalid query" });
    const { q, page, pageSize } = parsed.data;
    const supabase: any = createServiceClient();
    let query = supabase.schema("orders").from("admin_customer_index")
      .select("customer_key,customer_name,customer_email,customer_phone,order_count,latest_order_id,latest_status,latest_order_at", { count: "exact" })
      .order("latest_order_at", { ascending: false });
    if (q) {
      const safe = q.replace(/[%_]/g, "");
      query = q.includes("@")
        ? query.ilike("customer_email", `%${safe}%`)
        : /^\+?[\d\s-]+$/.test(q)
          ? query.ilike("customer_phone", `%${safe.replace(/\D/g, "").slice(-10)}%`)
          : query.ilike("customer_name", `%${safe}%`);
    }
    const { data, count, error } = await query.range((page - 1) * pageSize, page * pageSize - 1);
    if (error) throw error;
    return reply.send({ data: data ?? [], total: count ?? 0, page, pageSize });
  });

  app.get<{ Params: { key: string } }>("/admin/customers/:key/orders", async (request, reply) => {
    const key = decodeURIComponent(request.params.key).trim();
    const supabase: any = createServiceClient();
    let query = supabase.schema("orders").from("checkout_reservations")
      .select("id,reservation_id,customer_name,customer_email,customer_phone,items,status,expires_at,created_at")
      .order("created_at", { ascending: false }).limit(100);
    if (key.includes("@")) query = query.ilike("customer_email", key);
    else if (/^\d{8,15}$/.test(key)) query = query.ilike("customer_phone", `%${key.slice(-10)}`);
    else query = query.eq("id", key);
    const { data, error } = await query;
    if (error) throw error;
    return reply.send({ data: data ?? [] });
  });

  app.get("/admin/notifications", async (request, reply) => {
    const token = request.headers.authorization?.match(/^Bearer\s+(.+)$/i)?.[1];
    const supabase: any = createServiceClient();
    const { data: auth } = token ? await supabase.auth.getUser(token) : { data: null };
    if (!auth?.user) return reply.status(401).send({ error: "Invalid session" });
    const { data, error } = await supabase.from("notifications").select("id,type,title,body,entity_id,read_at,created_at")
      .eq("recipient_user_id", auth.user.id).order("created_at", { ascending: false }).limit(50);
    if (error) throw error;
    return reply.send({ data: data ?? [] });
  });

  app.post<{ Params: { id: string } }>("/admin/notifications/:id/read", async (request, reply) => {
    const token = request.headers.authorization?.match(/^Bearer\s+(.+)$/i)?.[1];
    const supabase: any = createServiceClient();
    const { data: auth } = token ? await supabase.auth.getUser(token) : { data: null };
    if (!auth?.user) return reply.status(401).send({ error: "Invalid session" });
    const { error } = await supabase.from("notifications").update({ read_at: new Date().toISOString() })
      .eq("id", request.params.id).eq("recipient_user_id", auth.user.id);
    if (error) throw error;
    return reply.send({ success: true });
  });

  app.get("/admin/conversations", async (_request, reply) => {
    const supabase: any = createServiceClient();
    const { data, error } = await supabase.schema("orders").from("support_conversations")
      .select("id,customer_user_id,customer_name,customer_email,status,admin_unread_count,customer_unread_count,created_at,updated_at")
      .neq("status", "closed").order("updated_at", { ascending: false }).limit(100);
    if (error) throw error;
    return reply.send({ data: data ?? [] });
  });

  app.get<{ Params: { id: string } }>("/admin/conversations/:id/messages", async (request, reply) => {
    const supabase: any = createServiceClient();
    const { data: conversation } = await supabase.schema("orders").from("support_conversations")
      .select("id").eq("id", request.params.id).maybeSingle();
    if (!conversation) return reply.status(404).send({ error: "Conversation not found" });
    const { data, error } = await supabase.schema("orders").from("support_messages")
      .select("id,sender_role,body,created_at").eq("conversation_id", conversation.id)
      .order("created_at", { ascending: true }).limit(200);
    if (error) throw error;
    await supabase.schema("orders").from("support_conversations")
      .update({ admin_unread_count: 0 }).eq("id", conversation.id);
    return reply.send({ data: data ?? [] });
  });

  app.post<{ Params: { id: string } }>("/admin/conversations/:id/reply", async (request, reply) => {
    const parsed = z.object({ message: z.string().trim().min(1).max(4000) }).safeParse(request.body);
    if (!parsed.success) return reply.status(400).send({ error: "Invalid message" });
    const token = request.headers.authorization?.match(/^Bearer\s+(.+)$/i)?.[1];
    const supabase: any = createServiceClient();
    const { data: auth } = token ? await supabase.auth.getUser(token) : { data: null };
    if (!auth?.user) return reply.status(401).send({ error: "Invalid session" });
    const { data: conversation } = await supabase.schema("orders").from("support_conversations")
      .select("id,customer_user_id,customer_unread_count").eq("id", request.params.id).maybeSingle();
    if (!conversation) return reply.status(404).send({ error: "Conversation not found" });
    const inserted = await supabase.schema("orders").from("support_messages").insert({
      conversation_id: conversation.id, sender_user_id: auth.user.id, sender_role: "admin", body: parsed.data.message,
    }).select("id,sender_role,body,created_at").single();
    if (inserted.error) throw inserted.error;
    await supabase.schema("orders").from("support_conversations").update({
      status: "open", customer_unread_count: (conversation.customer_unread_count ?? 0) + 1, updated_at: new Date().toISOString(),
    }).eq("id", conversation.id);
    await supabase.from("notifications").insert({
      recipient_user_id: conversation.customer_user_id, type: "chat", title: "New reply from Newtownbay",
      body: parsed.data.message.slice(0, 180), entity_id: conversation.id,
      dedupe_key: `reply:${inserted.data.id}:${conversation.customer_user_id}`,
    });
    return reply.send({ data: inserted.data });
  });
}
