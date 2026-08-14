import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { ChatRoom } from "../src/chat-room.js";
import { createFakeCtx } from "./helpers/fake-durable-object.mjs";
import { installFetchMock, jsonResponse } from "./helpers/mock-fetch.mjs";

const ROOM_ID = "2f1b1e2a-52b0-4a90-9f0a-1234567890ab";
const ADMIN_ID = "aaaaaaaa-0000-4000-8000-000000000001";
const OTHER_ID = "bbbbbbbb-0000-4000-8000-000000000002";

function makeRoom() {
  const ctx = createFakeCtx();
  const room = new ChatRoom(ctx, {});
  return { room, ctx };
}

describe("admin determination (BUG-009: no race, survives 'restart')", () => {
  test("resolves the admin from Supabase creation order, then caches it", async () => {
    const { room } = makeRoom();
    let fetchCalls = 0;
    const restore = installFetchMock(async (url) => {
      fetchCalls++;
      assert.match(url, /order=created_at\.asc/);
      return jsonResponse([{ id: ADMIN_ID }]);
    });
    try {
      assert.equal(await room.getAdminParticipantId(ROOM_ID), ADMIN_ID);
      assert.equal(await room.getAdminParticipantId(ROOM_ID), ADMIN_ID);
      assert.equal(fetchCalls, 1, "second call should be served from the cached/stored value");
    } finally {
      restore();
    }
  });

  test("a fresh ChatRoom instance ('after eviction/restart') re-derives the same admin from storage", async () => {
    const { ctx } = makeRoom();
    await ctx.storage.put("adminParticipantId", ADMIN_ID);

    // Simulates the Durable Object being evicted and reconstructed: a
    // brand new instance, same persisted ctx.storage.
    const restarted = new ChatRoom(ctx, {});
    const restore = installFetchMock(async () => { throw new Error("must not hit Supabase: already cached in storage"); });
    try {
      assert.equal(await restarted.getAdminParticipantId(ROOM_ID), ADMIN_ID);
    } finally {
      restore();
    }
  });
});

describe("join approval requires the real admin (BUG-002/BUG-004)", () => {
  async function setupPendingRequest(room, ctx) {
    await ctx.storage.put("adminParticipantId", ADMIN_ID);
    const adminSocket = ctx.connectFakeSocket([`room:${ROOM_ID}`, `participant:${ADMIN_ID}`]);
    const pendingSocket = ctx.connectFakeSocket([`room:${ROOM_ID}`, `participant:pending-abc`]);

    await room.onJoinRequest(pendingSocket, ROOM_ID, "pending-abc", { name: "Bob" });

    const notice = adminSocket.sent.find(m => m.type === "admin_join_request");
    assert.ok(notice, "admin should have been notified");
    return { adminSocket, pendingSocket, requestId: notice.requestId };
  }

  test("a non-admin participant's approve_join is silently ignored", async () => {
    const { room, ctx } = makeRoom();
    const { pendingSocket, requestId } = await setupPendingRequest(room, ctx);

    await room.onApproveJoin(ROOM_ID, OTHER_ID, { requestId });

    assert.equal(pendingSocket.sent.length, 0, "impostor approval must not grant a ticket");
  });

  test("only the real admin's approve_join mints and delivers a ticket", async () => {
    const { room, ctx } = makeRoom();
    const { pendingSocket, requestId } = await setupPendingRequest(room, ctx);

    await room.onApproveJoin(ROOM_ID, ADMIN_ID, { requestId });

    const approval = pendingSocket.sent.find(m => m.type === "join_approved");
    assert.ok(approval, "the real admin's approval must be delivered");
    assert.ok(approval.ticket, "an approval must carry a consumable ticket");
    assert.equal(approval.name, "Bob");
  });

  test("a non-admin's decline_join does not affect the pending request", async () => {
    const { room, ctx } = makeRoom();
    const { pendingSocket, requestId } = await setupPendingRequest(room, ctx);

    await room.onDeclineJoin(ROOM_ID, OTHER_ID, { requestId });
    assert.equal(pendingSocket.sent.length, 0);

    // The real admin can still approve afterwards -- the impostor's
    // decline had no effect on state.
    await room.onApproveJoin(ROOM_ID, ADMIN_ID, { requestId });
    assert.ok(pendingSocket.sent.find(m => m.type === "join_approved"));
  });

  test("no admin connected: the requester is auto-approved with a usable ticket", async () => {
    const { room, ctx } = makeRoom();
    await ctx.storage.put("adminParticipantId", ADMIN_ID); // admin exists but has no open socket
    const pendingSocket = ctx.connectFakeSocket([`room:${ROOM_ID}`, `participant:pending-xyz`]);

    await room.onJoinRequest(pendingSocket, ROOM_ID, "pending-xyz", { name: "Carol" });

    const auto = pendingSocket.sent.find(m => m.type === "auto_approved");
    assert.ok(auto);
    assert.ok(auto.ticket);
  });
});

describe("join tickets are single-use (replay protection)", () => {
  test("a ticket can be consumed exactly once", async () => {
    const { room, ctx } = makeRoom();
    await ctx.storage.put("adminParticipantId", ADMIN_ID);
    const adminSocket = ctx.connectFakeSocket([`room:${ROOM_ID}`, `participant:${ADMIN_ID}`]);
    const pendingSocket = ctx.connectFakeSocket([`room:${ROOM_ID}`, `participant:pending-abc`]);

    await room.onJoinRequest(pendingSocket, ROOM_ID, "pending-abc", { name: "Dave" });
    const requestId = adminSocket.sent.find(m => m.type === "admin_join_request").requestId;
    await room.onApproveJoin(ROOM_ID, ADMIN_ID, { requestId });
    const ticket = pendingSocket.sent.find(m => m.type === "join_approved").ticket;

    const first = await room.handleConsumeTicket(new Request("https://room/consume-ticket", {
      method: "POST", body: JSON.stringify({ ticket })
    }));
    assert.deepEqual(await first.json(), { ok: true, name: "Dave" });

    const second = await room.handleConsumeTicket(new Request("https://room/consume-ticket", {
      method: "POST", body: JSON.stringify({ ticket })
    }));
    assert.deepEqual(await second.json(), { ok: false });
  });

  test("an unknown ticket is rejected", async () => {
    const { room } = makeRoom();
    const res = await room.handleConsumeTicket(new Request("https://room/consume-ticket", {
      method: "POST", body: JSON.stringify({ ticket: "never-issued" })
    }));
    assert.deepEqual(await res.json(), { ok: false });
  });
});

describe("QR pairing codes never carry the real invite to a third party twice (BUG-008)", () => {
  test("a pairing code resolves to the invite token exactly once", async () => {
    const { room } = makeRoom();
    const minted = await room.handleMintPairingCode(new Request("https://room/pairing/mint", {
      method: "POST", body: JSON.stringify({ inviteToken: "REAL-INVITE-TOKEN" })
    })).then(r => r.json());
    assert.ok(minted.ok);
    assert.notEqual(minted.code, "REAL-INVITE-TOKEN");

    const first = await room.handleConsumePairingCode(new Request("https://room/pairing/consume", {
      method: "POST", body: JSON.stringify({ code: minted.code })
    })).then(r => r.json());
    assert.deepEqual(first, { ok: true, inviteToken: "REAL-INVITE-TOKEN" });

    const second = await room.handleConsumePairingCode(new Request("https://room/pairing/consume", {
      method: "POST", body: JSON.stringify({ code: minted.code })
    })).then(r => r.json());
    assert.equal(second.ok, false, "a pairing code must not be usable twice");
  });
});

describe("WebRTC signaling is routed only to the target, never broadcast (section 17)", () => {
  test("only the target's socket receives the offer", async () => {
    const { room, ctx } = makeRoom();
    const targetSocket = ctx.connectFakeSocket([`room:${ROOM_ID}`, `participant:${OTHER_ID}`]);
    const bystanderSocket = ctx.connectFakeSocket([`room:${ROOM_ID}`, `participant:cccccccc-0000-4000-8000-000000000003`]);

    room.onWebRtcSignal(ROOM_ID, ADMIN_ID, { type: "webrtc_offer", targetId: OTHER_ID, data: { sdp: "..." } });

    assert.equal(targetSocket.sent.length, 1);
    assert.equal(targetSocket.sent[0].senderId, ADMIN_ID);
    assert.equal(bystanderSocket.sent.length, 0, "signaling must not be broadcast to uninvolved participants");
  });

  test("a non-connected target is silently dropped rather than queued or broadcast", async () => {
    const { room, ctx } = makeRoom();
    const bystanderSocket = ctx.connectFakeSocket([`room:${ROOM_ID}`, `participant:cccccccc-0000-4000-8000-000000000003`]);
    room.onWebRtcSignal(ROOM_ID, ADMIN_ID, { type: "webrtc_offer", targetId: OTHER_ID, data: {} });
    assert.equal(bystanderSocket.sent.length, 0);
  });
});

describe("rate limiting has separate strict/burst budgets (found while implementing: typing must not starve message sends)", () => {
  test("checkRate enforces independent ceilings per key", () => {
    const { room } = makeRoom();
    for (let i = 0; i < 5; i++) assert.equal(room.checkRate("p1:strict", 5), true);
    assert.equal(room.checkRate("p1:strict", 5), false, "6th call over a limit of 5 must be rejected");
    // A different key (e.g. the burst bucket) is unaffected by the strict bucket being exhausted.
    assert.equal(room.checkRate("p1:burst", 60), true);
  });
});

describe("message persistence (persistAndBroadcastMessage)", () => {
  test("rejects an empty message without touching Supabase", async () => {
    const { room } = makeRoom();
    const restore = installFetchMock(async () => { throw new Error("should not be called"); });
    try {
      const result = await room.persistAndBroadcastMessage(ROOM_ID, ADMIN_ID, "   ");
      assert.deepEqual(result, { ok: false, code: "EMPTY_MESSAGE" });
    } finally {
      restore();
    }
  });

  test("persists, resolves the sender's display name, and broadcasts to the room", async () => {
    const { room, ctx } = makeRoom();
    const roomSocket = ctx.connectFakeSocket([`room:${ROOM_ID}`, `participant:${OTHER_ID}`]);

    const restore = installFetchMock(async (url, init) => {
      if (init?.method === "POST") {
        const row = JSON.parse(init.body);
        return jsonResponse([{ id: "m1", participant_id: row.participant_id, body: row.body, created_at: "2026-01-01T00:00:00Z" }]);
      }
      return jsonResponse([{ id: ADMIN_ID, display_name: "Admin" }]);
    });
    try {
      const result = await room.persistAndBroadcastMessage(ROOM_ID, ADMIN_ID, "hello room");
      assert.equal(result.ok, true);
      assert.equal(result.message.name, "Admin");

      const broadcast = roomSocket.sent.find(m => m.type === "message");
      assert.ok(broadcast, "other room members must receive the broadcast");
      assert.equal(broadcast.message.body, "hello room");
    } finally {
      restore();
    }
  });
});
