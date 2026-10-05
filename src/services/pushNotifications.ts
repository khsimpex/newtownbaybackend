import { cert, getApps, initializeApp } from "firebase-admin/app";
import { getMessaging, type MulticastMessage } from "firebase-admin/messaging";
import { env } from "../config/env.js";

const tokenKey = "newtownbay_push_tokens";

function messaging() {
  if (!env.FIREBASE_SERVICE_ACCOUNT_JSON) return null;
  const serviceAccount = JSON.parse(env.FIREBASE_SERVICE_ACCOUNT_JSON);
  const app = getApps()[0] ?? initializeApp({ credential: cert(serviceAccount) });
  return getMessaging(app);
}

export async function sendAdminPush(
  supabase: any,
  recipientUserId: string,
  notification: { title: string; body: string; entityId: string }
) {
  try {
    const firebase = messaging();
    if (!firebase) return;

    const { data, error } = await supabase.auth.admin.getUserById(recipientUserId);
    if (error || !data.user) return;
    const tokens = data.user.user_metadata?.[tokenKey];
    if (!Array.isArray(tokens) || tokens.length === 0) return;

    const message: MulticastMessage = {
      tokens: tokens.filter((token: unknown): token is string => typeof token === "string"),
      notification: { title: notification.title, body: notification.body },
      data: { type: "chat", entity_id: notification.entityId },
      android: {
        priority: "high",
        notification: { channelId: "ops_messages", sound: "default" },
      },
    };
    if (message.tokens.length === 0) return;

    const result = await firebase.sendEachForMulticast(message);
    const invalidTokens = new Set<string>();
    result.responses.forEach((response, index) => {
      const code = response.error?.code;
      if (
        code === "messaging/registration-token-not-registered" ||
        code === "messaging/invalid-registration-token"
      ) {
        invalidTokens.add(message.tokens[index]);
      }
    });
    if (invalidTokens.size > 0) {
      await supabase.auth.admin.updateUserById(recipientUserId, {
        user_metadata: {
          ...data.user.user_metadata,
          [tokenKey]: message.tokens.filter((token) => !invalidTokens.has(token)),
        },
      });
    }
  } catch (error) {
    console.error("[Push] Could not send admin notification:", error);
  }
}

export async function registerAdminPushToken(
  supabase: any,
  userId: string,
  token: string
) {
  const { data, error } = await supabase.auth.admin.getUserById(userId);
  if (error || !data.user) throw error ?? new Error("User not found");
  const previous = data.user.user_metadata?.[tokenKey];
  const tokens = Array.isArray(previous)
    ? previous.filter((value: unknown): value is string => typeof value === "string")
    : [];
  tokens.push(token);
  const { error: updateError } = await supabase.auth.admin.updateUserById(userId, {
    user_metadata: { ...data.user.user_metadata, [tokenKey]: [...new Set(tokens)] },
  });
  if (updateError) throw updateError;
}

export async function revokeAdminPushToken(
  supabase: any,
  userId: string,
  token: string
) {
  const { data, error } = await supabase.auth.admin.getUserById(userId);
  if (error || !data.user) throw error ?? new Error("User not found");
  const previous = data.user.user_metadata?.[tokenKey];
  const tokens = Array.isArray(previous)
    ? previous.filter((value: unknown): value is string => value !== token)
    : [];
  const { error: updateError } = await supabase.auth.admin.updateUserById(userId, {
    user_metadata: { ...data.user.user_metadata, [tokenKey]: tokens },
  });
  if (updateError) throw updateError;
}
