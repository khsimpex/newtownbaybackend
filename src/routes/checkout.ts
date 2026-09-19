import type { FastifyInstance } from "fastify";
import {
  reserveRequestSchema,
  verifyRequestSchema,
  releaseRequestSchema,
} from "../types/checkout.js";
import {
  createReservation,
  verifyPayment,
  releaseReservation,
} from "../services/checkoutService.js";

export async function checkoutRoutes(app: FastifyInstance) {
  app.post("/checkout/reserve", async (request, reply) => {
    const parsed = reserveRequestSchema.safeParse(request.body);

    if (!parsed.success) {
      return reply.status(400).send({ error: "Invalid request body", details: parsed.error.flatten() });
    }

    const { items, phone, customerName, customerEmail, shippingAddress } = parsed.data;
    const result = await createReservation(items, phone, customerName, customerEmail, shippingAddress);

    if (!result.ok) {
      return reply.status(result.status).send({ error: result.error, depletedSku: result.depletedSku });
    }

    return reply.send({
      success: true,
      reservationId: result.reservationId,
      reservationSecret: result.reservationSecret,
      razorpayOrderId: result.razorpayOrderId,
      amount: result.amount,
      currency: result.currency,
    });
  });

  // Fast-feedback verification right after Razorpay's client-side checkout
  // succeeds. NOT the durable source of truth â€” see checkoutService.ts for
  // why the webhook remains authoritative and this is just UX.
  app.post("/checkout/verify", async (request, reply) => {
    const parsed = verifyRequestSchema.safeParse(request.body);

    if (!parsed.success) {
      return reply.status(400).send({ error: "Invalid request body", details: parsed.error.flatten() });
    }

    const { razorpayOrderId, razorpayPaymentId, razorpaySignature } = parsed.data;
    const result = await verifyPayment(razorpayOrderId, razorpayPaymentId, razorpaySignature);

    if (!result.ok) {
      return reply.status(result.status).send({ error: result.error });
    }

    return reply.send({ success: true, status: result.status });
  });

  // Customer-initiated cancel. Requires the reservation_secret issued at
  // creation time â€” not just the reservation_id â€” so this can't be called
  // by anyone who merely guesses or enumerates reservation IDs.
  app.post("/checkout/release", async (request, reply) => {
    const parsed = releaseRequestSchema.safeParse(request.body);

    if (!parsed.success) {
      return reply.status(400).send({ error: "Invalid request body", details: parsed.error.flatten() });
    }

    const { reservationId, reservationSecret } = parsed.data;
    const result = await releaseReservation(reservationId, reservationSecret);

    if (!result.ok) {
      return reply.status(result.status).send({ error: result.error });
    }

    return reply.send({ success: true, status: result.status });
  });
}

