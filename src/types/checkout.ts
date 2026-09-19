import { z } from "zod";

// What the client is allowed to send when creating a reservation.
// No price — those are always resolved server-side. Bounds below
// prevent a single request from ballooning into thousands of RPC calls
// (API4:2023 — Unrestricted Resource Consumption).
export const requestedItemSchema = z.object({
  sku: z.string().min(1).max(64),
  qty: z.number().int().positive().max(10), // reasonable per-line cap for a streetwear drop
});

export const reserveRequestSchema = z.object({
  items: z.array(requestedItemSchema).min(1).max(20), // max 20 distinct line items per cart
  phone: z.string().max(20).optional(),
  customerName: z.string().max(128).optional(),
  customerEmail: z.string().email().max(256).optional(),
  shippingAddress: z.object({
    address: z.string().max(512),
    city: z.string().max(128),
    pincode: z.string().max(10),
  }).optional(),
});

export const verifyRequestSchema = z.object({
  razorpayOrderId: z.string().min(1).max(128),
  razorpayPaymentId: z.string().min(1).max(128),
  razorpaySignature: z.string().min(1).max(256),
});

export const releaseRequestSchema = z.object({
  reservationId: z.string().min(1).max(128),
  reservationSecret: z.string().min(1).max(256),
});

export type RequestedItem = z.infer<typeof requestedItemSchema>;
export type ReserveRequest = z.infer<typeof reserveRequestSchema>;
export type VerifyRequest = z.infer<typeof verifyRequestSchema>;
export type ReleaseRequest = z.infer<typeof releaseRequestSchema>;
