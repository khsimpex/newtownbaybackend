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

async function faqAnswer(supabase: any, message: string, user: any): Promise<string | null> {
  const text = message.toLowerCase().trim();

  // 1. Greetings & Welcome
  if (/^(hi|hello|hey|help|start|good\s*(morning|afternoon|evening))\b/i.test(text)) {
    return "Hello! Welcome to Newtownbay Atelier Concierge. 🖤\n\nI can assist you with:\n• 📦 Order tracking and status\n• 💸 Return and refund requests\n• 📏 Sizing and fit guidance\n• 🧵 Fabric composition and live stock\n\nYou can also say \"talk to human\" anytime to speak directly with our team.";
  }

  // 2. Refund & Return Status
  if (/\b(refund|return|exchange|swap)\b/i.test(text)) {
    try {
      const emailFilter = user.email ? "customer_email.eq." + user.email : "id.is.null";
      const phoneFilter = user.phone ? ",customer_phone.eq." + user.phone : "";
      const { data: orders } = await supabase
        .schema("orders")
        .from("checkout_reservations")
        .select("id, reservation_id, razorpay_order_id, status, checkout_metadata, created_at")
        .or(emailFilter + phoneFilter)
        .order("created_at", { ascending: false })
        .limit(5);

      const orderWithReturn = (orders || []).find((o: any) => {
        const meta = o.checkout_metadata || {};
        return meta.returnRequest || meta.return_request;
      });

      if (orderWithReturn) {
        const meta = orderWithReturn.checkout_metadata || {};
        const ret = meta.returnRequest || meta.return_request;
        const returnId = ret.id || "N/A";
        const status = ret.status || "UNDER REVIEW";
        const refundAmt = ret.refundAmount || ret.returnTotal || 0;
        const statusText = ret.statusText || "Return request received and being processed.";
        const txnId = ret.refundTransactionId ? "\n• Transaction: " + ret.refundTransactionId : "";

        return "Return / Refund Details for Order " + (orderWithReturn.razorpay_order_id || orderWithReturn.reservation_id) + ":\n• Return ID: " + returnId + "\n• Status: " + status + "\n• Amount: ₹" + refundAmt + txnId + "\n• Note: " + statusText + "\n\nLet me know if you would like to speak to an agent for further assistance.";
      }
    } catch (e) {
      console.error("[Bot] Return status check error:", e);
    }
    return "Eligible orders can request a doorstep size exchange or return within 7 days of delivery directly from your account (/dashboard/orders). If you already filed a request or need manual review, ask for a human agent.";
  }

  // 3. Order Tracking & Details
  if (/\b(order|track|tracking|status|dispatch|delivery|where is my order|shipment)\b/i.test(text) || /\b(ntb-[a-z0-9-]+|order_[a-z0-9]+)\b/i.test(text)) {
    try {
      const idMatch = text.match(/\b(order_[a-z0-9]+|ntb-[a-z0-9-]+|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\b/i);
      let query = supabase
        .schema("orders")
        .from("checkout_reservations")
        .select("id, reservation_id, razorpay_order_id, status, items, checkout_metadata, created_at");

      if (idMatch) {
        const targetId = idMatch[1];
        query = query.or("razorpay_order_id.ilike.%" + targetId + "%,reservation_id.ilike.%" + targetId + "%,id.eq." + targetId);
      } else {
        const emailFilter = user.email ? "customer_email.eq." + user.email : "id.is.null";
        const phoneFilter = user.phone ? ",customer_phone.eq." + user.phone : "";
        query = query.or(emailFilter + phoneFilter);
      }

      const { data: orders } = await query.order("created_at", { ascending: false }).limit(1);

      if (orders && orders.length > 0) {
        const o = orders[0];
        const meta = o.checkout_metadata || {};
        const fulfillment = meta.fulfillmentStatus || (o.status === "committed" ? "Processing / Dispatched" : String(o.status).toUpperCase());
        const trackingNum = meta.trackingNumber ? "\n• Tracking #: " + meta.trackingNumber : "";
        const courier = meta.courier ? " (" + meta.courier + ")" : "";
        
        let itemList = "";
        const rawItems = Array.isArray(o.items?.items) ? o.items.items : (Array.isArray(o.items) ? o.items : []);
        if (rawItems.length > 0) {
          itemList = "\n• Items: " + rawItems.map((i: any) => (i.name || i.sku) + " (" + (i.size || "STD") + " x" + (i.qty || 1) + ")").slice(0, 3).join(", ");
        }

        return "Here is your most recent order:\n• Order ID: " + (o.razorpay_order_id || o.reservation_id) + "\n• Status: " + fulfillment + courier + trackingNum + itemList + "\n\nYou can track full updates anytime on your Orders page. Ask for a human agent if you need changes!";
      }
    } catch (e) {
      console.error("[Bot] Order lookup error:", e);
    }
    return "I couldn't find an order matching that request. Please provide your Order ID (e.g. NTB-... or order_...) or ask for a human agent to check our fulfillment database.";
  }

  // 4. Sizing & Fit
  if (/\b(size|fit|sizing|measurement|chart)\b/i.test(text)) {
    return "Our garments feature a heavyweight, architectural boxy oversized fit (320–450 GSM pure combed cotton). We recommend choosing your true size for a relaxed drop-shoulder silhouette, or sizing down one size for a more fitted look. Full garment measurements are on every product page.";
  }

  // 5. Shipping Policy & Times
  if (/\b(ship|shipping|courier|dispatch|free shipping|fee)\b/i.test(text)) {
    return "Orders ₹999 and above enjoy Free Express Dispatch across India. Orders below ₹999 incur a ₹150 express dispatch fee. In-stock orders placed before 3 PM IST (Monday–Saturday) dispatch the same day.";
  }

  // 6. Product Specs & Live Stock
  if (/\b(product|fabric|cotton|gsm|stock|available|price|sku)\b/i.test(text)) {
    try {
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
          variant.size + ": ₹" + variant.price + (variant.available_qty > 0 ? " (" + variant.available_qty + " left)" : " (out of stock)")
        ).join(", ");
        const details = [match.color, match.fabric, match.gsm].filter(Boolean).join(" · ");
        return match.name + (details ? " — " + details : "") + ". " + (stock ? "Available sizes: " + stock + "." : "");
      }
      const names = (products ?? []).slice(0, 6).map((p: any) => p.name).filter(Boolean);
      return names.length
        ? "Featured pieces: " + names.join(", ") + ". Send a piece name or SKU for live sizing and stock."
        : "I cannot confirm catalog details right now. Ask for a human agent and our concierge team will help.";
    } catch (e) {
      console.error("[Bot] Product lookup error:", e);
    }
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
      body: customerName + ": new message in support chat",
      entity_id: conversationId,
      dedupe_key: "chat:" + messageId + ":" + admin.id,
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

    // Insert customer message
    const inserted = await supabase.schema("orders").from("support_messages").insert({
      conversation_id: conversation.id, sender_user_id: user.id, sender_role: "customer", body: parsed.data.message,
    }).select("id,sender_role,body,created_at").single();
    if (inserted.error) throw inserted.error;

    const isAlreadyOpen = conversation.status === "open";
    const asksForPerson = /\b(agent|human|person|representative|concierge|admin)\b/i.test(parsed.data.message);

    // CASE 1: Conversation is ALREADY handed off to human/admin
    if (isAlreadyOpen) {
      await supabase.schema("orders").from("support_conversations").update({
        admin_unread_count: (conversation.admin_unread_count ?? 0) + 1,
        updated_at: new Date().toISOString(),
      }).eq("id", conversation.id);

      await notifyAdmins(supabase, conversation.id, customerName, inserted.data.id);
      // DO NOT repeat the handoff message! The admin already knows.
      return reply.send({ conversationId: conversation.id, data: [inserted.data] });
    }

    // CASE 2: Conversation is in BOT mode
    const answer = !asksForPerson ? await faqAnswer(supabase, parsed.data.message, user) : null;

    if (answer) {
      // Bot has an answer! Update conversation timestamp and save bot response
      await supabase.schema("orders").from("support_conversations").update({
        updated_at: new Date().toISOString(),
      }).eq("id", conversation.id);

      const bot = await supabase.schema("orders").from("support_messages").insert({
        conversation_id: conversation.id, sender_role: "bot", body: answer,
      }).select("id,sender_role,body,created_at").single();
      if (bot.error) throw bot.error;

      return reply.send({ conversationId: conversation.id, data: [inserted.data, bot.data] });
    } else {
      // Handoff to human for the FIRST time
      await supabase.schema("orders").from("support_conversations").update({
        status: "open",
        admin_unread_count: (conversation.admin_unread_count ?? 0) + 1,
        updated_at: new Date().toISOString(),
      }).eq("id", conversation.id);

      await notifyAdmins(supabase, conversation.id, customerName, inserted.data.id);

      const handoffText = asksForPerson
        ? "I have connected you with our human concierge team. An admin will reply here shortly."
        : "I have forwarded your question to our concierge team. An admin will reply here shortly.";

      const handoff = await supabase.schema("orders").from("support_messages").insert({
        conversation_id: conversation.id,
        sender_role: "bot",
        body: handoffText,
      }).select("id,sender_role,body,created_at").single();
      if (handoff.error) throw handoff.error;

      return reply.send({ conversationId: conversation.id, data: [inserted.data, handoff.data] });
    }
  });
}
