import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import { createServiceClient } from "../db/supabaseClient.js";
import { sendAdminPush } from "../services/pushNotifications.js";

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
  if (/^(hi|hello|hey|help|start|hola|greetings|good\s*(morning|afternoon|evening))\b/i.test(text)) {
    return (
      "Hello! Welcome to Newtownbay Atelier Concierge. 🖤\n\n" +
      "I am your automated concierge and can help you with:\n" +
      "• 📦 Live order tracking and delivery status\n" +
      "• 🔄 7-day doorstep size swaps, returns & refunds\n" +
      "• 📏 Sizing recommendations for our boxy oversized silhouettes\n" +
      "• 🧵 Heavyweight fabric specs (pure combed cotton)\n" +
      "• 🚚 Express pan-India shipping & dispatch timelines\n\n" +
      "What can I help you with today?"
    );
  }

  // 2. Refund & Return Status & Exchanges
  if (/\b(refund|return|exchange|swap|replace|money\s*back|store\s*credit)\b/i.test(text)) {
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

        return (
          "Return / Refund Details for Order " + (orderWithReturn.razorpay_order_id || orderWithReturn.reservation_id) + ":\n" +
          "• Return ID: " + returnId + "\n" +
          "• Status: " + status + "\n" +
          "• Amount: ₹" + refundAmt + txnId + "\n" +
          "• Note: " + statusText + "\n\n" +
          "Let me know if you need any additional info, or tap 'Chat to Customer Care' if you would like manual assistance."
        );
      }
    } catch (e) {
      console.error("[Bot] Return status check error:", e);
    }
    return (
      "Eligible orders can request a 7-day doorstep size exchange or return directly from your account (/dashboard/orders).\n\n" +
      "• Size Swaps: Our courier partner brings your calibrated replacement size and retrieves the initial piece in one doorstep interaction.\n" +
      "• Return to Credit: Garments can also be converted to non-expiring store credit.\n\n" +
      "Visit /dashboard/orders to initiate, or let me know if you have other questions!"
    );
  }

  // 3. Order Tracking & Details
  if (/\b(order|track|tracking|status|dispatch|delivery|where is my order|shipment|parcel|awb)\b/i.test(text) || /\b(ntb-[a-z0-9-]+|order_[a-z0-9]+)\b/i.test(text)) {
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

        return (
          "Here is your latest order status:\n" +
          "• Order ID: " + (o.razorpay_order_id || o.reservation_id) + "\n" +
          "• Status: " + fulfillment + courier + trackingNum + itemList + "\n\n" +
          "You can view live tracking and download invoices from your Orders page (/dashboard/orders)."
        );
      }
    } catch (e) {
      console.error("[Bot] Order lookup error:", e);
    }
    return "I couldn't find an order on file matching that request. Please provide your Order ID (e.g. NTB-... or order_...) or check your Orders dashboard (/dashboard/orders).";
  }

  // 4. Sizing & Fit Guide
  if (/\b(size|fit|sizing|measurement|chart|oversized|boxy|chest)\b/i.test(text)) {
    return (
      "Our garments feature an architectural boxy oversized fit engineered from heavyweight pure combed cotton.\n\n" +
      "• True-to-Size: Delivers our intended drop-shoulder relaxed silhouette.\n" +
      "• Fitted Look: If you prefer a tailored chest drape, we recommend sizing down one size.\n" +
      "• Measurements: Exact flat-lay centimeters for chest, length, and shoulder are listed on every product page.\n\n" +
      "Every drop is also covered by our 7-Day Doorstep Size Swap guarantee!"
    );
  }

  // 5. Shipping Policy & Times
  if (/\b(ship|shipping|courier|dispatch|free shipping|fee|how long|time|delivery)\b/i.test(text)) {
    return (
      "Shipping & Dispatch SLA:\n" +
      "• Free Shipping: Orders ₹999 and above receive Free Express Dispatch across India.\n" +
      "• Standard Dispatch Fee: Orders below ₹999 incur a flat ₹150 express dispatch fee.\n" +
      "• Same-Day Dispatch: In-stock orders placed before 3:00 PM IST (Mon–Sat) are packed and dispatched the same day.\n" +
      "• Delivery Window: Metro hubs take 24–48 hours; other locations take 3–5 business days via Blue Dart / Delhivery."
    );
  }

  // 6. Fabric, GSM, Quality & Care
  if (/\b(product|fabric|cotton|gsm|stock|available|price|sku|material|quality|wash|care)\b/i.test(text)) {
    if (/\b(wash|care|dry|clean|iron)\b/i.test(text)) {
      return (
        "Garment Care for Heavyweight Cotton:\n" +
        "• Wash: Cold machine wash (30°C max) inside out on gentle cycle.\n" +
        "• Dry: Flat dry in shade. Avoid tumble drying to preserve fabric loft.\n" +
        "• Iron: Warm iron inside out; never iron directly on screen prints or embroidery."
      );
    }
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
        ? "Featured pieces: " + names.join(", ") + ". Send any piece name or SKU for live sizing and stock availability."
        : "Our pieces are engineered from pure combed compact cotton with reinforced ribbed zero-sag collars.";
    } catch (e) {
      console.error("[Bot] Product lookup error:", e);
    }
    return "All Newtownbay pieces are crafted from heavyweight 100% combed compact cotton with double-needle construction and zero-sag collars.";
  }

  // 7. Coupons & Promotions
  if (/\b(coupon|promo|discount|code|voucher|offer)\b/i.test(text)) {
    return (
      "Promotions & Discounts:\n" +
      "• All orders ₹999 and above automatically qualify for Free Express Pan-India Shipping.\n" +
      "• Seasonal drop discount codes can be applied directly at checkout in the promo code field.\n" +
      "• If an order does not dispatch within our 48-hour SLA, you receive a ₹200 store credit voucher."
    );
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
  const notifications = admins.map((admin: { id: string }) => ({
    recipient_user_id: admin.id,
    type: "chat",
    title: "New customer message",
    body: customerName + ": requested customer care in support chat",
    entity_id: conversationId,
    dedupe_key: "chat:" + messageId + ":" + admin.id,
  }));
  const { data, error } = await supabase.from("notifications").insert(
    notifications
  ).select("recipient_user_id,title,body,entity_id");
  if (error) throw error;
  await Promise.all((data ?? []).map((item: any) => sendAdminPush(
    supabase,
    item.recipient_user_id,
    { title: item.title, body: item.body, entityId: item.entity_id }
  )));
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
    const asksForPerson = /\b(agent|human|person|representative|concierge|admin|customer\s*care|care|support\s*team|talk\s*to\s*(someone|person|human|agent))\b/i.test(parsed.data.message);

    // CASE 1: Conversation is ALREADY handed off to human/admin
    if (isAlreadyOpen) {
      await supabase.schema("orders").from("support_conversations").update({
        admin_unread_count: (conversation.admin_unread_count ?? 0) + 1,
        updated_at: new Date().toISOString(),
      }).eq("id", conversation.id);

      await notifyAdmins(supabase, conversation.id, customerName, inserted.data.id);
      return reply.send({ conversationId: conversation.id, status: "open", data: [inserted.data] });
    }

    // CASE 2: Customer specifically requests human Customer Care
    if (asksForPerson) {
      await supabase.schema("orders").from("support_conversations").update({
        status: "open",
        admin_unread_count: (conversation.admin_unread_count ?? 0) + 1,
        updated_at: new Date().toISOString(),
      }).eq("id", conversation.id);

      await notifyAdmins(supabase, conversation.id, customerName, inserted.data.id);

      const handoffText = "I have connected you with our human customer care team. A concierge specialist will reply to your message shortly.";

      const handoff = await supabase.schema("orders").from("support_messages").insert({
        conversation_id: conversation.id,
        sender_role: "bot",
        body: handoffText,
      }).select("id,sender_role,body,created_at").single();
      if (handoff.error) throw handoff.error;

      return reply.send({ conversationId: conversation.id, status: "open", data: [inserted.data, handoff.data] });
    }

    // CASE 3: Standard Bot Mode - provide answer or guidance without prematurely escalating to human
    const answer = await faqAnswer(supabase, parsed.data.message, user);

    const botReplyText = answer || (
      "I'm the Newtownbay AI Concierge 🤖. I specialize in:\n" +
      "• 📦 Live order tracking and delivery status\n" +
      "• 🔄 Doorstep size swaps (7-day window) & return policy\n" +
      "• 📏 Sizing recommendations for our oversized boxy fit\n" +
      "• 🧵 Heavyweight fabric specs (pure combed cotton)\n" +
      "• 🚚 Express pan-India shipping & courier details\n\n" +
      "Please let me know if you would like information on any of these topics, or select 'Chat to Customer Care' if you need personalized assistance from our team."
    );

    await supabase.schema("orders").from("support_conversations").update({
      updated_at: new Date().toISOString(),
    }).eq("id", conversation.id);

    const bot = await supabase.schema("orders").from("support_messages").insert({
      conversation_id: conversation.id,
      sender_role: "bot",
      body: botReplyText,
    }).select("id,sender_role,body,created_at").single();
    if (bot.error) throw bot.error;

    return reply.send({ conversationId: conversation.id, status: "bot", data: [inserted.data, bot.data] });
  });
}
