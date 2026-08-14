import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  createParticipant, hasAnyParticipant, listMessages, withDisplayNames, roomStub
} from "../src/rooms.js";
import { installFetchMock, jsonResponse } from "./helpers/mock-fetch.mjs";

const ROOM_ID = "2f1b1e2a-52b0-4a90-9f0a-1234567890ab";

describe("createParticipant", () => {
  test("issues a session token and never returns the stored hash", async () => {
    const restore = installFetchMock(async (url, init) => {
      const row = JSON.parse(init.body);
      assert.equal(row.room_id, ROOM_ID);
      assert.equal(row.display_name, "Alice");
      assert.match(row.session_token_hash, /^[0-9a-f]{64}$/); // sha256 hex, never the raw token
      return jsonResponse([{
        id: "9c8d7e6f-5432-4a90-8b1c-abcdef012345",
        room_id: ROOM_ID,
        display_name: "Alice",
        created_at: "2026-01-01T00:00:00Z",
        session_token_hash: row.session_token_hash
      }]);
    });
    try {
      const result = await createParticipant({}, ROOM_ID, "  Alice  ");
      assert.equal(result.error, undefined);
      assert.equal(result.participant.display_name, "Alice");
      assert.ok(result.sessionToken.length > 0);
      // The hash must never leak back out of this function.
      assert.equal("session_token_hash" in result.participant, false);
    } finally {
      restore();
    }
  });

  test("rejects an empty/whitespace-only name before touching the network", async () => {
    const restore = installFetchMock(async () => { throw new Error("should not be called"); });
    try {
      const result = await createParticipant({}, ROOM_ID, "   ");
      assert.equal(result.error, "NAME_REQUIRED");
    } finally {
      restore();
    }
  });
});

describe("hasAnyParticipant (drives the join-ticket-required decision)", () => {
  test("false for an empty room", async () => {
    const restore = installFetchMock(async () => jsonResponse([]));
    try {
      assert.equal(await hasAnyParticipant({}, ROOM_ID), false);
    } finally {
      restore();
    }
  });

  test("true once at least one participant exists", async () => {
    const restore = installFetchMock(async () => jsonResponse([{ id: "x" }]));
    try {
      assert.equal(await hasAnyParticipant({}, ROOM_ID), true);
    } finally {
      restore();
    }
  });
});

describe("listMessages pagination", () => {
  test("first page: no cursor filter, requests pageSize+1 rows to detect hasMore", async () => {
    const restore = installFetchMock(async (url) => {
      assert.match(url, /limit=51/); // default page size (50) + 1
      assert.doesNotMatch(url, /created_at=lt\./);
      return jsonResponse([]); // empty room
    });
    try {
      const { messages, hasMore, cursor } = await listMessages({}, ROOM_ID, {});
      assert.deepEqual(messages, []);
      assert.equal(hasMore, false);
      assert.equal(cursor, null);
    } finally {
      restore();
    }
  });

  test("hasMore is true and a cursor is returned when more rows exist than the page size", async () => {
    const rows = Array.from({ length: 51 }, (_, i) => ({
      id: `id-${i}`, participant_id: "p", body: `msg ${i}`, created_at: `2026-01-01T00:00:${String(50 - i).padStart(2, "0")}Z`
    }));
    const restore = installFetchMock(async () => jsonResponse(rows));
    try {
      const { messages, hasMore, cursor } = await listMessages({}, ROOM_ID, { limit: 50 });
      assert.equal(messages.length, 50); // the +1 probe row is trimmed off
      assert.equal(hasMore, true);
      assert.ok(cursor.beforeCreatedAt);
      assert.ok(cursor.beforeId);
    } finally {
      restore();
    }
  });

  test("messages come back oldest-first even though Supabase is queried newest-first", async () => {
    const rows = [
      { id: "3", participant_id: "p", body: "third", created_at: "2026-01-01T00:00:03Z" },
      { id: "2", participant_id: "p", body: "second", created_at: "2026-01-01T00:00:02Z" },
      { id: "1", participant_id: "p", body: "first", created_at: "2026-01-01T00:00:01Z" }
    ];
    const restore = installFetchMock(async () => jsonResponse(rows));
    try {
      const { messages } = await listMessages({}, ROOM_ID, {});
      assert.deepEqual(messages.map(m => m.body), ["first", "second", "third"]);
    } finally {
      restore();
    }
  });

  test("a (beforeCreatedAt, beforeId) cursor builds a compound tie-break filter", async () => {
    const restore = installFetchMock(async (url) => {
      assert.match(url, /or=\(created_at\.lt\./);
      assert.match(url, /and\(created_at\.eq\./);
      assert.match(url, /id\.lt\./);
      return jsonResponse([]);
    });
    try {
      await listMessages({}, ROOM_ID, { beforeCreatedAt: "2026-01-01T00:00:00Z", beforeId: "abc" });
    } finally {
      restore();
    }
  });

  test("the page size is clamped to LIMITS.HISTORY_PAGE_MAX", async () => {
    const restore = installFetchMock(async (url) => {
      assert.match(url, /limit=101/); // 100 (max) + 1
      return jsonResponse([]);
    });
    try {
      await listMessages({}, ROOM_ID, { limit: 999999 });
    } finally {
      restore();
    }
  });
});

describe("withDisplayNames", () => {
  test("resolves participant_id to a display name, falling back for unknown ids", () => {
    const participants = [{ id: "p1", display_name: "Alice" }];
    const messages = [{ id: "m1", participant_id: "p1", body: "hi" }, { id: "m2", participant_id: "gone", body: "bye" }];
    const named = withDisplayNames(messages, participants);
    assert.equal(named[0].name, "Alice");
    assert.equal(named[1].name, "Participant");
  });
});

describe("roomStub", () => {
  test("derives the Durable Object id from the roomId (same room -> same stub)", () => {
    const seen = [];
    const fakeNamespace = {
      idFromName: (name) => { seen.push(name); return { name }; },
      get: (id) => ({ id })
    };
    const stub = roomStub({ CHAT_ROOMS: fakeNamespace }, ROOM_ID);
    assert.deepEqual(seen, [ROOM_ID]);
    assert.deepEqual(stub, { id: { name: ROOM_ID } });
  });
});
