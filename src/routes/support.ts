import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import { createServiceClient } from "../db/supabaseClient.js";
import { sendAdminPush } from "../services/pushNotifications.js";
import { isAdminOnline } from "../services/adminPresence.js";
import { FOLLOW_UP_LINE, MENU_REPLY, aiAnswer, ruleAnswer } from "../services/conciergeBot.js";
import { SCOPE_REPLY, offTopicReason } from "../services/conciergeScope.js";

const messageSchema = z.object({
  conversationId: z.string().uuid().optional(),
  message: z.string().trim().min(1).max(4000),
});

/** Sent when a customer asks for a person while admins are around. */
const ONLINE_HANDOFF =
  "I have connected you with our human customer care team. A concierge specialist will reply to your message shortly.";

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

/**
 * Alert every admin device that a customer is waiting.
 *
 * `needsHelp` is what the admin reads first, so it decides the title: a message
 * the bot could not answer says so, while one it did answer is a follow-up.
 * The body carries the customer's own words — an alert reading only "requested
 * customer care" told the admin nothing they could act on without opening the app.
 */
async function notifyAdmins(
  supabase: any,
  conversationId: string,
  customerName: string,
  messageId: string,
  preview: string,
  needsHelp: boolean
) {
  const { data: admins } = await supabase.from("profiles").select("id").eq("role", "admin");
  if (!admins?.length) return;
  const body = (customerName + ": " + preview).slice(0, 160);
  const notifications = admins.map((admin: { id: string }) => ({
    recipient_user_id: admin.id,
    type: "chat",
    title: needsHelp ? "Customer needs help" : "New customer message",
    body,
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

/** Customer text as it should appear in an alert: one line, bounded length. */
function preview(message: string): string {
  return message.replace(/\s+/g, " ").trim().slice(0, 120);
}

/** Raise the conversation in the admin queue and push it to every admin device. */
async function queueForAdmin(
  supabase: any,
  conversation: any,
  customerName: string,
  messageText: string,
  messageId: string,
  needsHelp: boolean
) {
  await supabase.schema("orders").from("support_conversations").update({
    admin_unread_count: (conversation.admin_unread_count ?? 0) + 1,
    updated_at: new Date().toISOString(),
  }).eq("id", conversation.id);

  await notifyAdmins(supabase, conversation.id, customerName, messageId, preview(messageText), needsHelp);
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
    const [{ data, error }, adminsOnline] = await Promise.all([
      supabase
        .schema("orders")
        .from("support_conversations")
        .select("id,status,customer_unread_count,created_at,updated_at")
        .eq("customer_user_id", user.id)
        .order("updated_at", { ascending: false }),
      // Sent so the chat header can say "no specialist online" instead of
      // claiming an agent joined a conversation nobody has picked up.
      isAdminOnline(supabase),
    ]);
    if (error) throw error;
    return reply.send({ data: data ?? [], adminsOnline });
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

  /**
   * One customer turn in the support chat.
   *
   * Answering rules, in order:
   *   1. Conversation already handed off AND an admin is around  -> stay silent,
   *      just notify. A human is handling it; the bot must not talk over them.
   *   2. Out-of-scope question                                    -> canned refusal,
   *      no rules, no model, no admin queue.
   *   3. Otherwise the bot answers: deterministic rules first, then the model
   *      when no rule matched.
   *   4. No admin around -> the answer is still given, plus a follow-up promise,
   *      and the conversation is pushed into the admin queue. Previously a
   *      conversation that had once been handed off stayed silent forever, so a
   *      customer messaging an offline admin got no reply at all.
   */
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

    const messageId = inserted.data.id;
    const adminsOnline = await isAdminOnline(supabase);
    const asksForPerson = /\b(agent|human|person|representative|concierge|admin|customer\s*care|care|support\s*team|talk\s*to\s*(someone|person|human|agent))\b/i.test(parsed.data.message);

    // CASE 1: Already handed off to a human who is currently around.
    if (conversation.status === "open" && adminsOnline) {
      await queueForAdmin(supabase, conversation, customerName, parsed.data.message, messageId, true);
      return reply.send({ conversationId: conversation.id, status: "open", adminsOnline, data: [inserted.data] });
    }

    // CASE 2: Out-of-scope question. Refused here, deterministically, so it costs
    // nothing and cannot be argued with. Not queued for an admin: an off-topic
    // message is not work for a human, and queuing it would drown the real ones.
    // Still checked after asksForPerson, because a person request outranks scope.
    if (!asksForPerson) {
      const offTopic = offTopicReason(parsed.data.message);
      if (offTopic) {
        request.log.info({ reason: offTopic }, "concierge refused an out-of-scope message");
        const refusal = await supabase.schema("orders").from("support_messages").insert({
          conversation_id: conversation.id, sender_role: "bot", body: SCOPE_REPLY,
        }).select("id,sender_role,body,created_at").single();
        if (refusal.error) throw refusal.error;
        await supabase.schema("orders").from("support_conversations")
          .update({ updated_at: new Date().toISOString() }).eq("id", conversation.id);
        return reply.send({
          conversationId: conversation.id,
          status: conversation.status,
          adminsOnline,
          data: [inserted.data, refusal.data],
        });
      }
    }

    // CASE 3: Bot answers. Rules first; the model only sees what no rule covers.
    let answer = await ruleAnswer(supabase, parsed.data.message, user);
    if (!answer) answer = await aiAnswer(supabase, user, parsed.data.message);

    const refused = answer === SCOPE_REPLY;
    const needsHuman = !answer;
    let status: string = conversation.status;
    let body = answer ?? MENU_REPLY;

    if (asksForPerson && adminsOnline) {
      status = "open";
      body = body + "\n\n" + ONLINE_HANDOFF;
    } else if (!adminsOnline) {
      // Never leave a customer at a dead end: answer, promise follow-up, queue it.
      // An out-of-scope refusal is not a dead end and needs no human — unless the
      // customer asked for one, which outranks the refusal.
      if (!refused || asksForPerson) {
        if (needsHuman || asksForPerson) status = "open";
        body = body + "\n\n" + FOLLOW_UP_LINE;
      }
    } else if (needsHuman) {
      // Admin is around but the bot has nothing: this one needs a person.
      status = "open";
    }

    const shouldNotifyAdmins = !refused && (!adminsOnline || status === "open");
    if (shouldNotifyAdmins) {
      await queueForAdmin(supabase, conversation, customerName, parsed.data.message, messageId, needsHuman || asksForPerson);
    } else {
      await supabase.schema("orders").from("support_conversations")
        .update({ updated_at: new Date().toISOString() }).eq("id", conversation.id);
    }

    const bot = await supabase.schema("orders").from("support_messages").insert({
      conversation_id: conversation.id,
      sender_role: "bot",
      body,
    }).select("id,sender_role,body,created_at").single();
    if (bot.error) throw bot.error;

    return reply.send({ conversationId: conversation.id, status, adminsOnline, data: [inserted.data, bot.data] });
  });
}
