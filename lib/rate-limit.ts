/**
 * In-memory sliding-window rate limiter, keyed by client IP.
 *
 * Deliberately dependency-free. The tradeoff worth knowing: Vercel serverless
 * instances don't share memory, so with N warm instances a visitor can get up to
 * N x MAX requests per window, and counters reset on cold start. That's enough to
 * stop casual abuse and runaway retry loops, which is the real risk for a public
 * demo — it is not a defence against a determined attacker.
 *
 * Swapping in Upstash later means reimplementing `check()` alone; nothing outside
 * this file knows how the counting works.
 */

const MAX = Number(process.env.RATE_LIMIT_MAX ?? 15);
const WINDOW_MS = Number(process.env.RATE_LIMIT_WINDOW_MS ?? 60 * 60 * 1000);
const COOLDOWN_MS = Number(process.env.RATE_LIMIT_COOLDOWN_MS ?? 10 * 1000);

const hits = new Map<string, number[]>();

// Bound memory growth: a long-lived instance would otherwise accumulate an entry
// per unique IP forever.
const MAX_TRACKED_IPS = 10_000;

export type RateLimitResult =
  | { ok: true; remaining: number }
  | { ok: false; reason: "cooldown" | "quota"; retryAfterSeconds: number };

function sweep(now: number) {
  for (const [ip, timestamps] of hits) {
    const live = timestamps.filter((t) => now - t < WINDOW_MS);
    if (live.length === 0) hits.delete(ip);
    else hits.set(ip, live);
  }
}

export function checkRateLimit(ip: string): RateLimitResult {
  const now = Date.now();

  if (hits.size > MAX_TRACKED_IPS) sweep(now);

  const timestamps = (hits.get(ip) ?? []).filter((t) => now - t < WINDOW_MS);

  const last = timestamps[timestamps.length - 1];
  if (last !== undefined && now - last < COOLDOWN_MS) {
    return {
      ok: false,
      reason: "cooldown",
      retryAfterSeconds: Math.ceil((COOLDOWN_MS - (now - last)) / 1000),
    };
  }

  if (timestamps.length >= MAX) {
    const oldest = timestamps[0];
    return {
      ok: false,
      reason: "quota",
      retryAfterSeconds: Math.ceil((WINDOW_MS - (now - oldest)) / 1000),
    };
  }

  timestamps.push(now);
  hits.set(ip, timestamps);

  return { ok: true, remaining: MAX - timestamps.length };
}

export function clientIpFrom(headers: Headers): string {
  // Vercel sets x-forwarded-for reliably; the left-most entry is the client.
  const forwarded = headers.get("x-forwarded-for");
  if (forwarded) return forwarded.split(",")[0].trim();
  return headers.get("x-real-ip")?.trim() || "unknown";
}

export const rateLimitConfig = { MAX, WINDOW_MS, COOLDOWN_MS };
