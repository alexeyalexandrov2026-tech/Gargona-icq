import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { verifyInvite, authenticateParticipant, readBearer, readWebSocketCredentials } from "../src/auth.js";
import { sha256 } from "../src/security.js";
import { installFetchMock, jsonResponse } from "./helpers/mock-fetch.mjs";

const ROOM_ID = "2f1b1e2a-52b0-4a90-9f0a-1234567890ab";
const PARTICIPANT_ID = "9c8d7e6f-5432-4a90-8b1c-abcdef012345";

describe("readBearer", () => {
  test("prefers the Authorization header over the query param", () => {
    const url = new URL("https://chat.example.com/api/chats/room?invite=from-query");
    const request = new Request(url, { headers: { Authorization: "Bearer from-header" } });
    assert.equal(readBearer(request, "Authorization", "invite", url), "from-header");
  });

  test("falls back to the query param when no header is present", () => {
    const url = new URL("https://chat.example.com/api/chats/room?invite=from-query");
    const request = new Request(url);
    assert.equal(readBearer(request, "Authorization", "invite", url), "from-query");
  });

  test("returns empty string when neither is present", () => {
    const url = new URL("https://chat.example.com/api/chats/room");
    const request = new Request(url);
    assert.equal(readBearer(request, "Authorization", "invite", url), "");
  });
});

describe("readWebSocketCredentials", () => {
  test("parses invite/session out of Sec-WebSocket-Protocol, not the URL", () => {
    const url = new URL("https://chat.example.com/api/rooms/room/ws?participantId=abc");
    const request = new Request(url, {
      headers: { "Sec-WebSocket-Protocol": "gorgona.invite.INVITETOKEN, gorgona.session.SESSIONTOKEN" }
    });
    const { invite, session } = readWebSocketCredentials(request, url);
    assert.equal(invite, "INVITETOKEN");
    assert.equal(session, "SESSIONTOKEN");
  });

  test("falls back to query params when no subprotocol is offered", () => {
    const url = new URL("https://chat.example.com/api/rooms/room/ws?invite=Q_INVITE&session=Q_SESSION");
    const request = new Request(url);
    const { invite, session } = readWebSocketCredentials(request, url);
    assert.equal(invite, "Q_INVITE");
    assert.equal(session, "Q_SESSION");
  });

  test("ignores subprotocol entries that do not match the expected prefixes", () => {
    const url = new URL("https://chat.example.com/api/rooms/room/ws");
    const request = new Request(url, { headers: { "Sec-WebSocket-Protocol": "json, graphql-ws" } });
    const { invite, session } = readWebSocketCredentials(request, url);
    assert.equal(invite, "");
    assert.equal(session, "");
  });
});

describe("verifyInvite (Supabase-backed)", () => {
  test("true when Supabase returns a matching, non-revoked invite row", async () => {
    const restore = installFetchMock(async (url) => {
      assert.match(url, /chat_invites/);
      assert.match(url, /revoked_at=is\.null/);
      return jsonResponse([{ room_id: ROOM_ID }]);
    });
    try {
      assert.equal(await verifyInvite({}, ROOM_ID, "sometoken"), true);
    } finally {
      restore();
    }
  });

  test("false when Supabase returns no rows", async () => {
    const restore = installFetchMock(async () => jsonResponse([]));
    try {
      assert.equal(await verifyInvite({}, ROOM_ID, "sometoken"), false);
    } finally {
      restore();
    }
  });

  test("false without hitting the network at all when roomId or token is missing", async () => {
    const restore = installFetchMock(async () => { throw new Error("should not be called"); });
    try {
      assert.equal(await verifyInvite({}, ROOM_ID, ""), false);
      assert.equal(await verifyInvite({}, "", "sometoken"), false);
    } finally {
      restore();
    }
  });
});

describe("authenticateParticipant (BUG-003 regression: no impersonation without the session token)", () => {
  test("succeeds only when the presented session token hashes to the stored hash", async () => {
    const realToken = "the-real-session-token";
    const storedHash = await sha256(realToken);
    const restore = installFetchMock(async () =>
      jsonResponse([{ id: PARTICIPANT_ID, display_name: "Alice", session_token_hash: storedHash }])
    );
    try {
      const ok = await authenticateParticipant({}, ROOM_ID, PARTICIPANT_ID, realToken);
      assert.deepEqual(ok, { id: PARTICIPANT_ID, displayName: "Alice" });
    } finally {
      restore();
    }
  });

  test("fails when the presented session token is wrong (an attacker who only knows the participantId)", async () => {
    const storedHash = await sha256("the-real-session-token");
    const restore = installFetchMock(async () =>
      jsonResponse([{ id: PARTICIPANT_ID, display_name: "Alice", session_token_hash: storedHash }])
    );
    try {
      const ok = await authenticateParticipant({}, ROOM_ID, PARTICIPANT_ID, "guessed-or-observed-value");
      assert.equal(ok, null);
    } finally {
      restore();
    }
  });

  test("fails for a legacy participant row with no session hash at all", async () => {
    const restore = installFetchMock(async () =>
      jsonResponse([{ id: PARTICIPANT_ID, display_name: "Alice", session_token_hash: null }])
    );
    try {
      const ok = await authenticateParticipant({}, ROOM_ID, PARTICIPANT_ID, "anything");
      assert.equal(ok, null);
    } finally {
      restore();
    }
  });

  test("fails closed when required arguments are missing, without a network call", async () => {
    const restore = installFetchMock(async () => { throw new Error("should not be called"); });
    try {
      assert.equal(await authenticateParticipant({}, ROOM_ID, PARTICIPANT_ID, ""), null);
      assert.equal(await authenticateParticipant({}, ROOM_ID, "", "token"), null);
    } finally {
      restore();
    }
  });

  test("a real participant+session from one room cannot authenticate against a different room (cross-room isolation)", async () => {
    const OTHER_ROOM_ID = "ffffffff-0000-4000-8000-000000000099";
    const sessionToken = "valid-session-for-room-a-only";
    const restore = installFetchMock(async (url) => {
      // Faithful to Postgres/PostgREST: the participant row's room_id is
      // ROOM_ID, so a query filtered by room_id=eq.OTHER_ROOM_ID never
      // matches it -- there is no row to authenticate against.
      assert.match(url, /room_id=eq\./);
      if (url.includes(`room_id=eq.${encodeURIComponent(OTHER_ROOM_ID)}`)) return jsonResponse([]);
      return jsonResponse([{ id: PARTICIPANT_ID, display_name: "Alice", session_token_hash: await sha256(sessionToken) }]);
    });
    try {
      assert.ok(await authenticateParticipant({}, ROOM_ID, PARTICIPANT_ID, sessionToken), "sanity: works for the real room");
      const crossRoom = await authenticateParticipant({}, OTHER_ROOM_ID, PARTICIPANT_ID, sessionToken);
      assert.equal(crossRoom, null, "the same participantId+session must not authenticate against a room it doesn't belong to");
    } finally {
      restore();
    }
  });
});
