import { createHash, timingSafeEqual } from "node:crypto";

/**
 * Constant-time string compare. Hashing first equalises length, so neither
 * content nor length of the expected secret leaks through timing.
 */
export function safeEqual(provided: unknown, expected: string): boolean {
  if (typeof provided !== "string") return false;
  const a = createHash("sha256").update(provided).digest();
  const b = createHash("sha256").update(expected).digest();
  return timingSafeEqual(a, b);
}

/**
 * Escape a user string for use inside a PostgREST like/ilike pattern.
 * Backslash-escapes \ % _ and drops "*", which PostgREST treats as an alias
 * for "%" in like/ilike values.
 */
export function escapeLike(input: string): string {
  return input.replace(/\*/g, "").replace(/[\\%_]/g, (c) => `\\${c}`);
}

export const UUID_RE = /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i;