import { DurableObject } from "cloudflare:workers";

// Fixed-window rate limiter backed by Durable Object storage, so counts
// survive eviction/hibernation instead of silently resetting (which is
// exactly the failure mode an in-memory-only counter in the Worker
// itself would have -- Workers isolates are not guaranteed to stick
// around, and there is no shared memory across them).
//
// One DO instance == one (bucket, key) pair, e.g. idFromName("msg:1.2.3.4").
// Cheap and strongly consistent; no new external dependency.
export class RateLimiter extends DurableObject {
  async fetch(request) {
    const { limit, windowMs } = await request.json();
    const now = Date.now();

    let windowStart = await this.ctx.storage.get("windowStart");
    let count = await this.ctx.storage.get("count");
    if (typeof windowStart !== "number" || now - windowStart >= windowMs) {
      windowStart = now;
      count = 0;
    }

    count = (count || 0) + 1;
    await this.ctx.storage.put({ windowStart, count });

    const allowed = count <= limit;
    const retryAfterMs = allowed ? 0 : Math.max(0, windowMs - (now - windowStart));
    return Response.json({ allowed, remaining: Math.max(0, limit - count), retryAfterMs });
  }
}

// Convenience wrapper used by the Worker. `bucket` namespaces the limit
// (e.g. "create-room", "join", "ws-connect") and `key` is normally the
// caller's IP address.
export async function rateLimit(env, bucket, key, limit, windowMs) {
  const id = env.RATE_LIMITER.idFromName(`${bucket}:${key}`);
  const stub = env.RATE_LIMITER.get(id);
  const response = await stub.fetch("https://rate-limiter/hit", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ limit, windowMs })
  });
  return response.json();
}

export function clientIp(request) {
  return request.headers.get("CF-Connecting-IP") || "unknown";
}
