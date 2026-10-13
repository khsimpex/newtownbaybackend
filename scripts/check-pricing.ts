/**
 * Self-check for the checkout amount arithmetic.
 *
 * This is the money path behind the price-change guard: if the quote and the
 * re-check disagree for any legitimate reason, every order gets flagged as
 * repriced and refunded. Run with `npm run check:pricing`.
 */
import assert from "node:assert/strict";
import { quotedAmountInPaise } from "../src/services/checkoutService.js";

// Free shipping at and above 999; a flat 150 below it.
assert.equal(quotedAmountInPaise([{ price: 999, qty: 1 }]), 99900, "999 ships free");
assert.equal(quotedAmountInPaise([{ price: 998, qty: 1 }]), 114800, "998 + 150 shipping");
assert.equal(quotedAmountInPaise([{ price: 499, qty: 2 }]), 114800, "499x2 is 998 + shipping");

// The boundary is on the subtotal, not per line.
assert.equal(quotedAmountInPaise([{ price: 500, qty: 2 }]), 100000, "500x2 ships free");

// Paise, not rupees — a rupee figure here would under-charge by 100x.
assert.equal(quotedAmountInPaise([{ price: 1299.5, qty: 1 }]), 129950, "paise, not rupees");

// An empty cart is not charged shipping.
assert.equal(quotedAmountInPaise([]), 0, "empty cart is zero");

// The guard's actual comparison: a repriced cart must produce a different
// number, or the mismatch would go undetected.
const quoted = quotedAmountInPaise([{ price: 1299, qty: 1 }]);
const repriced = quotedAmountInPaise([{ price: 1499, qty: 1 }]);
assert.notEqual(quoted, repriced, "a price change must change the amount");
assert.equal(repriced - quoted, 20000, "₹200 rise is 20000 paise");

console.log("pricing checks passed");
