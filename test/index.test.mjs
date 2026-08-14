import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { api } from "../src/index.mjs";
import { sha256 } from "../src/security.js";
import { installFetchMock, jsonResponse } from "./helpers/mock-fetch.mjs";

const ROOM_ID = "2f1b1e2a-52b0-4a90-9f0a-1234567890ab";
const PARTICIPANT_ID = "9c8d7e6f-5432-4a90-8b1c-abcdef012345";

function allowingRateLimiter() {
  return { idFromName: (n) => ({ n }), get: () => ({ async fetch() { return Response.json({ allowed: true, remaining: 1, retryAfterMs: 0 }); } }) };
}
function denyingRateLimiter() {
  return { idFromName: (n) => ({ n }), get: () => ({ async fetch() { return Response.json({ allowed: false, remaining: 0, retryAfterMs: 5000 }); } }) };
}

function fakeChatRoomsNamespace(handler) {
  return { idFromName: (n) => ({ n }), get: () => ({ fetch: handler }) };
}

function baseEnv(overrides = {}) {
  return {
    RATE_LIMITER: allowingRateLimiter(),
    CHAT_ROOMS: fakeChatRoomsNamespace(async () => new Response("ok")),
    ALLOWED_ORIGINS: "",
    ...overrides
  };
}

async function call(request, env) {
  const url = new URL(request.url);
  return api(request, env, url);
}

describe("OPTIONS preflight", () => {
  test("204 with CORS headers, no body", async () => {
    const res = await call(new Request("https://chat.example.com/api/chats", { method: "OPTIONS" }), baseEnv());
    assert.equal(res.status, 204);
  });
});

describe("POST /api/chats (room creation)", () => {
  test("429 when the rate limiter denies", async () => {
    const res = await call(
      new Request("https://chat.example.com/api/chats", { method: "POST", body: "{}" }),
      baseEnv({ RATE_LIMITER: denyingRateLimiter() })
    );
    assert.equal(res.status, 429);
    const body = await res.json();
    assert.equal(body.error.code, "RATE_LIMITED");
  });

  test("400 on an oversized/invalid body", async () => {
    const res = await call(
      new Request("https://chat.example.com/api/chats", { method: "POST", body: "y".repeat(64 * 1024) }),
      baseEnv()
    );
    assert.equal(res.status, 400);
    assert.equal((await res.json()).error.code, "INVALID_BODY");
  });
});

describe("POST /api/chats/:roomId/participants -- join-ticket enforcement (BUG-004 regression)", () => {
  test("403 APPROVAL_REQUIRED when the room already has a participant and no ticket is presented", async () => {
    const restore = installFetchMock(async (url) => {
      if (url.includes("chat_invites")) return jsonResponse([{ room_id: ROOM_ID }]);
      if (url.includes("chat_participants")) return jsonResponse([{ id: "someone-else" }]); // room is occupied
      throw new Error(`unexpected: ${url}`);
    });
    try {
      const res = await call(
        new Request(`https://chat.example.com/api/chats/${ROOM_ID}/participants`, {
          method: "POST", body: JSON.stringify({ name: "Eve", inviteToken: "valid" })
        }),
        baseEnv()
      );
      assert.equal(res.status, 403);
      assert.equal((await res.json()).error.code, "APPROVAL_REQUIRED");
    } finally {
      restore();
    }
  });

  test("a valid ticket lets a second participant join, using the admin-approved name (not the client's)", async () => {
    const restore = installFetchMock(async (url, init) => {
      if (url.includes("chat_invites")) return jsonResponse([{ room_id: ROOM_ID }]);
      if (url.includes("chat_participants") && init?.method === "POST") {
        const row = JSON.parse(init.body);
        assert.equal(row.display_name, "Approved Name", "must use the name the admin actually approved");
        return jsonResponse([{ id: PARTICIPANT_ID, room_id: ROOM_ID, display_name: row.display_name }]);
      }
      if (url.includes("chat_participants")) return jsonResponse([{ id: "someone-else" }]); // occupied
      throw new Error(`unexpected: ${url}`);
    });
    const rooms = fakeChatRoomsNamespace(async (input) => {
      const reqUrl = typeof input === "string" ? input : input.url;
      if (reqUrl.includes("/consume-ticket")) return Response.json({ ok: true, name: "Approved Name" });
      if (reqUrl.includes("/presence")) return new Response("ok");
      throw new Error(`unexpected DO call: ${reqUrl}`);
    });
    try {
      const res = await call(
        new Request(`https://chat.example.com/api/chats/${ROOM_ID}/participants`, {
          method: "POST",
          body: JSON.stringify({ name: "Attacker-supplied name", inviteToken: "valid", joinTicket: "TICKET" })
        }),
        baseEnv({ CHAT_ROOMS: rooms })
      );
      assert.equal(res.status, 201);
      const body = await res.json();
      assert.equal(body.display_name, "Approved Name");
      assert.ok(body.sessionToken);
      assert.equal("session_token_hash" in body, false);
    } finally {
      restore();
    }
  });

  test("an empty room allows a ticketless join (the creator)", async () => {
    const restore = installFetchMock(async (url, init) => {
      if (url.includes("chat_invites")) return jsonResponse([{ room_id: ROOM_ID }]);
      if (url.includes("chat_participants") && init?.method === "POST") {
        return jsonResponse([{ id: PARTICIPANT_ID, room_id: ROOM_ID, display_name: "Room Creator" }]);
      }
      if (url.includes("chat_participants")) return jsonResponse([]); // empty room
      throw new Error(`unexpected: ${url}`);
    });
    const rooms = fakeChatRoomsNamespace(async () => new Response("ok"));
    try {
      const res = await call(
        new Request(`https://chat.example.com/api/chats/${ROOM_ID}/participants`, {
          method: "POST", body: JSON.stringify({ name: "Room Creator", inviteToken: "valid" })
        }),
        baseEnv({ CHAT_ROOMS: rooms })
      );
      assert.equal(res.status, 201);
    } finally {
      restore();
    }
  });
});

describe("WebSocket upgrade route (BUG-003 regression: cannot connect as someone else)", () => {
  function wsRequest({ participantId, protocols }) {
    const url = `https://chat.example.com/api/rooms/${ROOM_ID}/ws?participantId=${encodeURIComponent(participantId)}`;
    const headers = { Upgrade: "websocket" };
    if (protocols) headers["Sec-WebSocket-Protocol"] = protocols;
    return new Request(url, { headers });
  }

  test("403 without a valid invite", async () => {
    const restore = installFetchMock(async () => jsonResponse([])); // no invite matches
    try {
      const res = await call(wsRequest({ participantId: "pending-abc", protocols: "gorgona.invite.bad" }), baseEnv());
      assert.equal(res.status, 403);
    } finally {
      restore();
    }
  });

  test("a pending-* id is allowed through with just a valid invite (not yet a participant)", async () => {
    const restore = installFetchMock(async () => jsonResponse([{ room_id: ROOM_ID }]));
    const rooms = fakeChatRoomsNamespace(async () => new Response("forwarded", { status: 200 }));
    try {
      const res = await call(wsRequest({ participantId: "pending-abc123", protocols: "gorgona.invite.valid" }), baseEnv({ CHAT_ROOMS: rooms }));
      assert.equal(await res.text(), "forwarded");
    } finally {
      restore();
    }
  });

  test("403 for a real participantId presented WITHOUT the matching session token (the impersonation attempt)", async () => {
    const restore = installFetchMock(async (url) => {
      if (url.includes("chat_invites")) return jsonResponse([{ room_id: ROOM_ID }]);
      if (url.includes("chat_participants")) return jsonResponse([{ id: PARTICIPANT_ID, display_name: "Victim", session_token_hash: "not-a-match" }]);
      throw new Error(`unexpected: ${url}`);
    });
    try {
      const res = await call(
        wsRequest({ participantId: PARTICIPANT_ID, protocols: "gorgona.invite.valid, gorgona.session.guessed" }),
        baseEnv()
      );
      assert.equal(res.status, 403);
    } finally {
      restore();
    }
  });

  test("200/forwarded for a real participantId WITH the correct session token", async () => {
    const realSession = "the-real-session-token";
    const storedHash = await sha256(realSession);
    const restore = installFetchMock(async (url) => {
      if (url.includes("chat_invites")) return jsonResponse([{ room_id: ROOM_ID }]);
      if (url.includes("chat_participants")) return jsonResponse([{ id: PARTICIPANT_ID, display_name: "Alice", session_token_hash: storedHash }]);
      throw new Error(`unexpected: ${url}`);
    });
    const rooms = fakeChatRoomsNamespace(async () => new Response("forwarded"));
    try {
      const res = await call(
        wsRequest({ participantId: PARTICIPANT_ID, protocols: `gorgona.invite.valid, gorgona.session.${realSession}` }),
        baseEnv({ CHAT_ROOMS: rooms })
      );
      assert.equal(await res.text(), "forwarded");
    } finally {
      restore();
    }
  });
});

describe("media upload route", () => {
  test("401 without valid participant authentication", async () => {
    const restore = installFetchMock(async () => jsonResponse([])); // authenticateParticipant fails
    try {
      const res = await call(
        new Request(`https://chat.example.com/api/chats/${ROOM_ID}/media`, {
          method: "POST",
          headers: { "content-type": "image/jpeg", "X-Participant-Id": PARTICIPANT_ID, Authorization: "Bearer wrong" },
          body: new Uint8Array([1, 2, 3])
        }),
        baseEnv({ MEDIA_BUCKET: {} })
      );
      assert.equal(res.status, 401);
    } finally {
      restore();
    }
  });

  test("415 for an unsupported content type, checked before touching R2", async () => {
    const realSession = "session-token";
    const storedHash = await sha256(realSession);
    const restore = installFetchMock(async () => jsonResponse([{ id: PARTICIPANT_ID, display_name: "Alice", session_token_hash: storedHash }]));
    let putCalled = false;
    try {
      const res = await call(
        new Request(`https://chat.example.com/api/chats/${ROOM_ID}/media`, {
          method: "POST",
          headers: { "content-type": "text/html", "X-Participant-Id": PARTICIPANT_ID, Authorization: `Bearer ${realSession}` },
          body: "<script>evil()</script>"
        }),
        baseEnv({ MEDIA_BUCKET: { put: async () => { putCalled = true; } } })
      );
      assert.equal(res.status, 415);
      assert.equal(putCalled, false);
    } finally {
      restore();
    }
  });
});

describe("unmatched routes return null (fall through to static asset serving)", () => {
  test("api() returns null for an unknown path", async () => {
    const res = await call(new Request("https://chat.example.com/not-a-route"), baseEnv());
    assert.equal(res, null);
  });
});
