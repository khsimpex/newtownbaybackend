import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import { createServiceClient } from "../db/supabaseClient.js";

const messageSchema = z.object({
  conversationId: z.string().uuid().optional(),
  message: z.string().trim().min(1).max(4000),
});

async function signedInUser(request: FastifyRequest, reply: FastifyReply) {
  const token = request.headers.authorization?.match(/^Bearer\s+(.+)$/i)?.[1];
  if (!token) {
    await reply.status(401).send({ error: "Authentication required" });
    return null;
  }
  const supabase: any = createServiceClient();
  const { data, error } = await supabase.auth.getUser(token);
  if (error || !data.user) {
    await reply.status(401).send({ error: "Invalid session" });
    return null;
  }
  return data.user;
}

async function faqAnswer(supabase: any, message: string): Promise<string | null> {
  const text = message.toLowerCase();
  if (/\b(size|fit|sizing)\b/.test(text))
    return "For our boxy oversized fit, the size guide recommends going one size up from your usual chest size. Product pages include garment measurements. Ask for a human agent for a personal recommendation.";
  if (/\b(return|exchange|swap|refund)\b/.test(text))
    return "Eligible orders can request a doorstep size exchange within 7 days of delivery. The current policy is exchange-only; cash refunds are not available. Ask for a human agent about store credit.";
  if (/\b(ship|delivery|dispatch|track|tracking)\b/.test(text))
    return "In-stock orders placed before 3 PM IST, Monday to Saturday, are handed to the courier in that operating cycle. Later orders and Sunday orders ship the next business morning. Ask for an agent if tracking has not updated for 24 hours.";
  if (/\b(product|fabric|cotton|gsm|stock|available|price|sku)\b/.test(text)) {
    const { data: products } = await supabase.schema("inventory").from("products")
      .select("id,sku_prefix,name,color,category,fabric,gsm,status")
      .in("status", ["ACTIVE", "LOW_STOCK"]).limit(100);
    const match = (products ?? []).find((product: any) =>
      text.includes(String(product.name).toLowerCase()) || text.includes(String(product.sku_prefix).toLowerCase())
    );
    if (match) {
      const { data: variants } = await supabase.schema("inventory").from("stock_levels")
        .select("size,price,available_qty").eq("product_id", match.id).order("size");
      const stock = (variants ?? []).map((variant: any) =>
        `${variant.size}: ₹${variant.price}${variant.available_qty > 0 ? ` (${variant.available_qty} available)` : " (out of stock)"}`
      ).join(", ");
      const details = [match.color, match.fabric, match.gsm].filter(Boolean).join(" · ");
      return `${match.name}${details ? ` — ${details}` : ""}.${stock ? ` Sizes and prices: ${stock}.` : " I cannot confirm current sizes or prices."} Ask for a human agent for more help.`;
    }
    const names = (products ?? []).slice(0, 8).map((product: any) => product.name).filter(Boolean);
    return names.length
      ? `Current products: ${names.join(", ")}. Share a product name or SKU for details, or ask for a human agent.`
      : "I cannot confirm catalog details right now. Ask for a human agent and our team will help.";
  }
  return null;
}

async function notifyAdmins(
  supabase: any,
  conversationId: string,
  customerName: string,
  messageId: string
) {
  const { data: admins } = await supabase.from("profiles").select("id").eq("role", "admin");
  if (!admins?.length) return;
  await supabase.from("notifications").insert(
    admins.map((admin: { id: string }) => ({
      recipient_user_id: admin.id,
      type: "chat",
      title: "New customer message",
      body: `${customerName}: new message in support chat`,
      entity_id: conversationId,
      dedupe_key: `chat:${messageId}:${admin.id}`,
    }))
  );
}

export async function supportRoutes(app: FastifyInstance) {
  app.get("/support/notifications", async (request, reply) => {
    const user = await signedInUser(request, reply);
    if (!user) return;
    const { data, error } = await (createServiceClient() as any).from("notifications")
      .select("id,type,title,body,entity_id,read_at,created_at")
      .eq("recipient_user_id", user.id).order("created_at", { ascending: false }).limit(50);
    if (error) throw error;
    return reply.send({ data: data ?? [] });
  });

  app.post<{ Params: { id: string } }>("/support/notifications/:id/read", async (request, reply) => {
    const user = await signedInUser(request, reply);
    if (!user) return;
    const { error } = await (createServiceClient() as any).from("notifications")
      .update({ read_at: new Date().toISOString() }).eq("id", request.params.id)
      .eq("recipient_user_id", user.id);
    if (error) throw error;
    return reply.send({ success: true });
  });

  app.get("/support/conversations", async (request, reply) => {
    const user = await signedInUser(request, reply);
    if (!user) return;
    const supabase: any = createServiceClient();
    const { data, error } = await supabase
      .schema("orders")
      .from("support_conversations")
      .select("id,status,customer_unread_count,created_at,updated_at")
      .eq("customer_user_id", user.id)
      .order("updated_at", { ascending: false });
    if (error) throw error;
    return reply.send({ data: data ?? [] });
  });

  app.get<{ Params: { id: string } }>("/support/conversations/:id/messages", async (request, reply) => {
    const user = await signedInUser(request, reply);
    if (!user) return;
    const supabase: any = createServiceClient();
    const { data: conversation } = await supabase
      .schema("orders").from("support_conversations").select("id,customer_user_id")
      .eq("id", request.params.id).maybeSingle();
    if (!conversation || conversation.customer_user_id !== user.id)
      return reply.status(404).send({ error: "Conversation not found" });
    const { data, error } = await supabase.schema("orders").from("support_messages")
      .select("id,sender_role,body,created_at").eq("conversation_id", conversation.id)
      .order("created_at", { ascending: true }).limit(200);
    if (error) throw error;
    await supabase.schema("orders").from("support_conversations")
      .update({ customer_unread_count: 0 }).eq("id", conversation.id);
    return reply.send({ data: data ?? [] });
  });

  app.post("/support/messages", async (request, reply) => {
    const user = await signedInUser(request, reply);
    if (!user) return;
    const parsed = messageSchema.safeParse(request.body);
    if (!parsed.success) return reply.status(400).send({ error: "Invalid message" });
    const supabase: any = createServiceClient();
    const customerName = String(user.user_metadata?.full_name ?? user.user_metadata?.name ?? user.email ?? "Customer").slice(0, 120);
    let conversation: any;
    if (parsed.data.conversationId) {
      const result = await supabase.schema("orders").from("support_conversations")
        .select("*").eq("id", parsed.data.conversationId).eq("customer_user_id", user.id).maybeSingle();
      conversation = result.data;
    } else {
      const result = await supabase.schema("orders").from("support_conversations")
        .select("*").eq("customer_user_id", user.id).in("status", ["bot", "open"])
        .order("updated_at", { ascending: false }).limit(1).maybeSingle();
      conversation = result.data;
      if (!conversation) {
        const created = await supabase.schema("orders").from("support_conversations")
          .insert({ customer_user_id: user.id, customer_name: customerName, customer_email: user.email })
          .select("*").single();
        if (created.error) throw created.error;
        conversation = created.data;
      }
    }
    if (!conversation) return reply.status(404).send({ error: "Conversation not found" });
    if (conversation.status === "closed") return reply.status(409).send({ error: "Conversation is closed" });

    const inserted = await supabase.schema("orders").from("support_messages").insert({
      conversation_id: conversation.id, sender_user_id: user.id, sender_role: "customer", body: parsed.data.message,
    }).select("id,sender_role,body,created_at").single();
    if (inserted.error) throw inserted.error;

    const asksForPerson = /\b(agent|human|person|representative|concierge)\b/i.test(parsed.data.message);
    const answer = conversation.status === "bot" && !asksForPerson
      ? await faqAnswer(supabase, parsed.data.message)
      : null;
    await supabase.schema("orders").from("support_conversations").update({
      status: answer ? "bot" : "open",
      admin_unread_count: answer ? conversation.admin_unread_count : (conversation.admin_unread_count ?? 0) + 1,
      updated_at: new Date().toISOString(),
    }).eq("id", conversation.id);
    if (!answer) await notifyAdmins(supabase, conversation.id, customerName, inserted.data.id);

    let botMessage: any = null;
    if (answer) {
      const bot = await supabase.schema("orders").from("support_messages").insert({
        conversation_id: conversation.id, sender_role: "bot", body: answer,
      }).select("id,sender_role,body,created_at").single();
      if (bot.error) throw bot.error;
      botMessage = bot.data;
    } else {
      const handoff = await supabase.schema("orders").from("support_messages").insert({
        conversation_id: conversation.id,
        sender_role: "bot",
        body: asksForPerson
          ? "I have asked our team to join this chat. They will reply here."
          : "I cannot confirm that answer yet, so I have sent your message to our concierge team. They will reply here.",
      }).select("id,sender_role,body,created_at").single();
      if (handoff.error) throw handoff.error;
      botMessage = handoff.data;
    }
    return reply.send({ conversationId: conversation.id, data: [inserted.data, ...(botMessage ? [botMessage] : [])] });
  });
}
