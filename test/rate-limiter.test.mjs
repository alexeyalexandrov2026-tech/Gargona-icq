import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { RateLimiter, rateLimit, clientIp } from "../src/rate-limiter.js";
import { createFakeCtx } from "./helpers/fake-durable-object.mjs";

describe("RateLimiter Durable Object (fixed window, persisted in ctx.storage)", () => {
  test("allows up to the limit within a window, then rejects", async () => {
    const limiter = new RateLimiter(createFakeCtx(), {});
    const hit = () => limiter.fetch(new Request("https://rate-limiter/hit", {
      method: "POST", body: JSON.stringify({ limit: 3, windowMs: 60_000 })
    })).then(r => r.json());

    assert.equal((await hit()).allowed, true);
    assert.equal((await hit()).allowed, true);
    assert.equal((await hit()).allowed, true);
    const fourth = await hit();
    assert.equal(fourth.allowed, false);
    assert.ok(fourth.retryAfterMs > 0);
  });

  test("survives 'eviction' (a fresh instance over the same ctx.storage keeps counting the window)", async () => {
    const ctx = createFakeCtx();
    const first = new RateLimiter(ctx, {});
    await first.fetch(new Request("https://rate-limiter/hit", {
      method: "POST", body: JSON.stringify({ limit: 1, windowMs: 60_000 })
    }));

    const restarted = new RateLimiter(ctx, {}); // same persisted storage, new instance
    const second = await restarted.fetch(new Request("https://rate-limiter/hit", {
      method: "POST", body: JSON.stringify({ limit: 1, windowMs: 60_000 })
    })).then(r => r.json());
    assert.equal(second.allowed, false, "an in-memory-only counter would have reset to 0 here and wrongly allowed this");
  });
});

describe("rateLimit() helper: buckets are namespaced by (bucket, key)", () => {
  test("different buckets/keys get independent limiter instances", async () => {
    const seenIds = [];
    const fakeNamespace = {
      idFromName(name) { seenIds.push(name); return { name }; },
      get(id) {
        return {
          async fetch() { return Response.json({ allowed: true, remaining: 9, retryAfterMs: 0 }); }
        };
      }
    };
    await rateLimit({ RATE_LIMITER: fakeNamespace }, "create-room", "1.2.3.4", 10, 60_000);
    await rateLimit({ RATE_LIMITER: fakeNamespace }, "join", "1.2.3.4", 10, 60_000);
    assert.deepEqual(seenIds, ["create-room:1.2.3.4", "join:1.2.3.4"]);
  });
});

describe("clientIp", () => {
  test("reads CF-Connecting-IP", () => {
    const request = new Request("https://x", { headers: { "CF-Connecting-IP": "203.0.113.5" } });
    assert.equal(clientIp(request), "203.0.113.5");
  });
  test("falls back to a constant instead of throwing when absent (local dev)", () => {
    const request = new Request("https://x");
    assert.equal(clientIp(request), "unknown");
  });
});
