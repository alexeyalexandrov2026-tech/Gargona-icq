import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  LIMITS, randomToken, sha256, timingSafeEqual, isUuid, isPendingId,
  cleanName, cleanRoomTitle, cleanMessage, json, apiError, corsHeaders, securityHeaders
} from "../src/security.js";

describe("randomToken", () => {
  test("produces URL-safe strings with no padding", () => {
    const token = randomToken(32);
    assert.match(token, /^[A-Za-z0-9_-]+$/);
    assert.ok(!token.includes("+") && !token.includes("/") && !token.includes("="));
  });

  test("is not predictable across calls", () => {
    const a = randomToken(32);
    const b = randomToken(32);
    assert.notEqual(a, b);
  });

  test("longer input produces longer token", () => {
    assert.ok(randomToken(32).length > randomToken(8).length);
  });
});

describe("sha256", () => {
  test("matches a known test vector", async () => {
    // sha256("") — a standard, checkable constant.
    const digest = await sha256("");
    assert.equal(digest, "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855".slice(0, 64));
  });

  test("is deterministic", async () => {
    const a = await sha256("gorgona");
    const b = await sha256("gorgona");
    assert.equal(a, b);
  });

  test("small input changes produce a different digest", async () => {
    const a = await sha256("token-a");
    const b = await sha256("token-b");
    assert.notEqual(a, b);
  });
});

describe("timingSafeEqual", () => {
  test("true for identical strings", () => {
    assert.equal(timingSafeEqual("abc123", "abc123"), true);
  });
  test("false for different strings of equal length", () => {
    assert.equal(timingSafeEqual("abc123", "abc124"), false);
  });
  test("false for different-length strings (no length leak via early return)", () => {
    assert.equal(timingSafeEqual("short", "muchlonger"), false);
  });
  test("false for non-string input instead of throwing", () => {
    assert.equal(timingSafeEqual(null, "abc"), false);
    assert.equal(timingSafeEqual(undefined, undefined), false);
  });
});

describe("isUuid / isPendingId", () => {
  test("accepts a well-formed UUID", () => {
    assert.equal(isUuid("2f1b1e2a-52b0-4a90-9f0a-1234567890ab"), true);
  });
  test("rejects non-UUID strings", () => {
    for (const bad of ["not-a-uuid", "", "12345", "pending-abc123", null, undefined, 42]) {
      assert.equal(isUuid(bad), false, `expected isUuid(${JSON.stringify(bad)}) to be false`);
    }
  });
  test("accepts a well-formed pending id", () => {
    assert.equal(isPendingId("pending-abc123xyz"), true);
  });
  test("rejects pending ids that look like an attempted injection", () => {
    for (const bad of ["pending-", "pending-abc/../etc", "pending-abc def", "not-pending-abc", ""]) {
      assert.equal(isPendingId(bad), false, `expected isPendingId(${JSON.stringify(bad)}) to be false`);
    }
  });
});

describe("input cleaning respects LIMITS", () => {
  test("cleanName trims, collapses whitespace, and truncates", () => {
    assert.equal(cleanName("  Alice   Smith  "), "Alice Smith");
    assert.equal(cleanName("a".repeat(200)).length, LIMITS.DISPLAY_NAME_MAX);
    assert.equal(cleanName(null), "");
    assert.equal(cleanName(undefined), "");
  });

  test("cleanRoomTitle truncates to the room title limit", () => {
    assert.equal(cleanRoomTitle("x".repeat(500)).length, LIMITS.ROOM_TITLE_MAX);
  });

  test("cleanMessage truncates to the message body limit", () => {
    // This is the fix for BUG-001: the application-layer limit must never
    // exceed what the database CHECK constraint (migration 0004) allows.
    const huge = "y".repeat(5_000_000);
    const cleaned = cleanMessage(huge);
    assert.equal(cleaned.length, LIMITS.MESSAGE_BODY_MAX);
    assert.equal(LIMITS.MESSAGE_BODY_MAX, 4000);
  });

  test("cleanMessage trims but does not collapse internal whitespace/newlines", () => {
    assert.equal(cleanMessage("  hello\nworld  "), "hello\nworld");
  });
});

describe("json / apiError response envelope", () => {
  test("json() sets JSON content-type and no-store caching", async () => {
    const res = json({ ok: true });
    assert.equal(res.headers.get("content-type"), "application/json; charset=utf-8");
    assert.equal(res.headers.get("cache-control"), "no-store");
    assert.deepEqual(await res.json(), { ok: true });
  });

  test("apiError() always uses the {error:{code,message}} shape", async () => {
    const res = apiError("INVALID_INVITE", "Invalid invite.", 403);
    assert.equal(res.status, 403);
    const body = await res.json();
    assert.deepEqual(body, { error: { code: "INVALID_INVITE", message: "Invalid invite." } });
  });
});

describe("corsHeaders", () => {
  test("reflects the same-origin Origin", () => {
    const request = new Request("https://chat.example.com/api/health", {
      headers: { Origin: "https://chat.example.com" }
    });
    const headers = corsHeaders(request, {});
    assert.equal(headers["access-control-allow-origin"], "https://chat.example.com");
  });

  test("does NOT reflect an arbitrary cross-site Origin by default (BUG-005)", () => {
    const request = new Request("https://chat.example.com/api/health", {
      headers: { Origin: "https://evil.example" }
    });
    const headers = corsHeaders(request, {});
    assert.equal(headers["access-control-allow-origin"], undefined);
  });

  test("allows an Origin explicitly listed in ALLOWED_ORIGINS", () => {
    const request = new Request("https://chat.example.com/api/health", {
      headers: { Origin: "https://partner.example" }
    });
    const headers = corsHeaders(request, { ALLOWED_ORIGINS: "https://partner.example, https://other.example" });
    assert.equal(headers["access-control-allow-origin"], "https://partner.example");
  });

  test("omits the header entirely when there is no Origin at all", () => {
    const request = new Request("https://chat.example.com/api/health");
    const headers = corsHeaders(request, {});
    assert.equal(headers["access-control-allow-origin"], undefined);
    assert.equal(headers.vary, "Origin");
  });
});

describe("securityHeaders", () => {
  test("includes the core protective headers", () => {
    const headers = securityHeaders();
    assert.equal(headers["x-content-type-options"], "nosniff");
    assert.equal(headers["x-frame-options"], "DENY");
    assert.match(headers["content-security-policy"], /default-src 'self'/);
    assert.doesNotMatch(headers["content-security-policy"], /unsafe-inline/);
    assert.match(headers["strict-transport-security"], /max-age=\d+/);
  });
});
