import { DurableObject } from "cloudflare:workers";
import { insert, select } from "./supabase.js";
import { cleanMessage, cleanName, isUuid, randomToken, sha256, LIMITS } from "./security.js";

const MAX_RAW_FRAME = 32 * 1024; // JSON-wrapped text message; media travels over HTTP/R2, not WS.

// Message types that cost real resources (a Supabase write) or are
// security-sensitive share the strict per-participant budget. "typing"
// fires on every keystroke and WebRTC signaling arrives in bursts (ICE
// candidate gathering alone can be a dozen messages in under a second)
// -- gating those on the same strict budget would throttle normal use,
// so they get their own, more generous one instead.
const STRICT_RATE_TYPES = new Set(["message", "join_request", "approve_join", "decline_join"]);
const BURST_RATE_MAX = 60;

// One ChatRoom Durable Object instance == one room (see roomStub() in
// index.mjs, which derives the instance id from the roomId). Everything
// stored via this.ctx.storage is therefore already room-scoped and needs
// no roomId prefix, and it survives hibernation/eviction -- unlike plain
// instance fields, which are reset whenever the runtime reconstructs this
// class after evicting it from memory.
export class ChatRoom extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.env = env;
    // Per-participant message rate limiting is intentionally NOT persisted:
    // it is a short sliding window (seconds), a reset on eviction only
    // ever makes it more lenient for a moment, never a security issue.
    this.messageTimestamps = new Map();
  }

  // ---- admin identity -----------------------------------------------
  //
  // The admin is always "the participant with the earliest created_at in
  // this room", which is durable, authoritative data already sitting in
  // Supabase. We cache the resolved id in ctx.storage so we are not
  // making a round trip on every reconnect, but we NEVER trust "whichever
  // HTTP request happened to reach this DO first" (that was the old
  // behaviour, and it raced two concurrent joins against each other).
  async getAdminParticipantId(roomId) {
    const cached = await this.ctx.storage.get("adminParticipantId");
    if (cached) return cached;

    const people = await select(
      this.env,
      "chat_participants",
      `select=id&room_id=eq.${encodeURIComponent(roomId)}&order=created_at.asc&limit=1`
    );
    const adminId = people?.[0]?.id || null;
    if (adminId) await this.ctx.storage.put("adminParticipantId", adminId);
    return adminId;
  }

  // ---- HTTP-ish entry point (invoked only via the Worker binding; the
  // room id in the URL is never attacker-controlled independently of the
  // Worker's own routing, since Durable Objects are not reachable from
  // the public internet except through env.CHAT_ROOMS from index.mjs) ---
  async fetch(request) {
    const url = new URL(request.url);

    if (url.pathname === "/presence" && request.method === "POST") {
      return this.handlePresence(request);
    }
    if (url.pathname === "/consume-ticket" && request.method === "POST") {
      return this.handleConsumeTicket(request);
    }
    if (url.pathname === "/pairing/mint" && request.method === "POST") {
      return this.handleMintPairingCode(request);
    }
    if (url.pathname === "/pairing/consume" && request.method === "POST") {
      return this.handleConsumePairingCode(request);
    }
    if (url.pathname === "/send-message" && request.method === "POST") {
      return this.handleSendMessageHttp(request, url);
    }
    if (url.pathname === "/broadcast-media" && request.method === "POST") {
      return this.handleBroadcastMedia(request);
    }

    if (url.pathname !== "/ws" || request.headers.get("Upgrade")?.toLowerCase() !== "websocket") {
      return new Response("Not found", { status: 404 });
    }
    return this.handleWebSocketUpgrade(request, url);
  }

  // Lets trusted server-side callers (the MCP endpoint) post a message
  // into a room without a live WebSocket connection, going through the
  // exact same persist+broadcast path a real chat message does.
  async handleSendMessageHttp(request, url) {
    const roomId = url.searchParams.get("roomId");
    const { participantId, body } = await request.json().catch(() => ({}));
    if (!roomId || !participantId) return Response.json({ ok: false, code: "BAD_REQUEST" }, { status: 400 });

    const result = await this.persistAndBroadcastMessage(roomId, participantId, body);
    return Response.json(result, { status: result.ok ? 200 : 400 });
  }

  // The HTTP media-upload endpoint (index.mjs) stores the blob in R2 and
  // then calls this so the room's live WebSocket clients see it exactly
  // like any other message, without duplicating persistence logic here.
  async handleBroadcastMedia(request) {
    const { roomId, message } = await request.json().catch(() => ({}));
    if (!roomId || !message) return Response.json({ ok: false }, { status: 400 });
    this.broadcast(roomId, { type: "message", message });
    return Response.json({ ok: true });
  }

  async handlePresence(request) {
    try {
      const body = await request.json();
      if (body.type === "participant_joined" && body.participant?.room_id) {
        const adminId = await this.getAdminParticipantId(body.participant.room_id);
        this.broadcast(body.participant.room_id, {
          type: "participant_joined",
          participant: body.participant,
          adminId
        });
      }
    } catch (err) {
      console.error("presence handler failed", { message: err?.message });
    }
    return new Response("ok", { status: 200 });
  }

  async handleWebSocketUpgrade(request, url) {
    const roomId = url.searchParams.get("roomId");
    const participantId = url.searchParams.get("participantId");
    if (!roomId || !participantId) {
      return new Response("Missing roomId or participantId", { status: 400 });
    }

    const adminId = await this.getAdminParticipantId(roomId);

    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);

    this.ctx.acceptWebSocket(server, [`room:${roomId}`, `participant:${participantId}`]);
    server.serializeAttachment({ roomId, participantId });
    this.broadcast(roomId, { type: "presence", participantId, online: true, adminId }, server);

    const headers = {};
    const offeredProtocol = request.headers.get("Sec-WebSocket-Protocol");
    if (offeredProtocol) {
      // Echo back one of the offered values so clients that check
      // `socket.protocol` see a match. The actual invite/session token
      // values were already parsed out and verified by the Worker
      // (index.mjs) before this request ever reached the Durable Object.
      headers["Sec-WebSocket-Protocol"] = offeredProtocol.split(",")[0].trim();
    }
    return new Response(null, { status: 101, webSocket: client, headers });
  }

  async webSocketMessage(ws, message) {
    if (typeof message !== "string" || message.length === 0 || message.length > MAX_RAW_FRAME) return;

    let payload;
    try {
      payload = JSON.parse(message);
    } catch {
      return;
    }
    if (!payload || typeof payload.type !== "string") return;

    const meta = ws.deserializeAttachment() || {};
    const roomId = meta.roomId;
    const participantId = meta.participantId;
    if (!roomId || !participantId) return;

    const strict = STRICT_RATE_TYPES.has(payload.type);
    const rateKey = `${participantId}:${strict ? "strict" : "burst"}`;
    if (!this.checkRate(rateKey, strict ? LIMITS.MESSAGE_RATE_MAX : BURST_RATE_MAX)) {
      this.sendError(ws, "RATE_LIMITED", "Too many messages, slow down.");
      return;
    }

    switch (payload.type) {
      case "join_request":
        return this.onJoinRequest(ws, roomId, participantId, payload);
      case "approve_join":
        return this.onApproveJoin(roomId, participantId, payload);
      case "decline_join":
        return this.onDeclineJoin(roomId, participantId, payload);
      case "webrtc_offer":
      case "webrtc_answer":
      case "webrtc_ice_candidate":
        return this.onWebRtcSignal(roomId, participantId, payload);
      case "typing":
        this.broadcast(roomId, { type: "typing", participantId, typing: Boolean(payload.typing) }, ws);
        return;
      case "message":
        return this.onMessage(ws, roomId, participantId, payload);
      default:
        return; // Unknown message types are ignored, not trusted.
    }
  }

  async webSocketClose(ws) {
    const meta = ws.deserializeAttachment() || {};
    if (meta.roomId && meta.participantId) {
      this.broadcast(meta.roomId, { type: "presence", participantId: meta.participantId, online: false }, ws);
    }
  }

  async webSocketError(ws, error) {
    console.error("Gorgona Chat WebSocket error", { message: error?.message });
  }

  // ---- join request / approval state machine -------------------------
  //
  //   PENDING -> APPROVED (ticket minted, single-use, short TTL)
  //   PENDING -> DECLINED
  //
  // Approval is only ever effective when it comes from the room's actual
  // admin connection (proven by the WebSocket's authenticated
  // participantId, verified upstream in index.mjs before this DO is
  // reached -- not by anything the client claims in the payload).

  async onJoinRequest(ws, roomId, tempId, payload) {
    const name = cleanName(payload.name);
    if (!name) return;

    const reqId = crypto.randomUUID();
    const now = Date.now();
    const pending = { reqId, tempId, roomId, name, status: "pending", createdAt: now, expiresAt: now + LIMITS.PENDING_REQUEST_TTL_MS };
    await this.ctx.storage.put(`pending:${reqId}`, pending);
    await this.scheduleCleanup(pending.expiresAt);

    const adminId = await this.getAdminParticipantId(roomId);
    const adminSockets = adminId ? this.socketsFor(adminId) : [];

    if (adminSockets.length === 0) {
      // No admin connected right now (including "this is the very first
      // participant and there is no admin yet"): mint a ticket
      // immediately rather than leaving the requester stuck forever.
      const ticket = await this.mintTicket(reqId, name);
      pending.status = "approved";
      await this.ctx.storage.put(`pending:${reqId}`, pending);
      this.sendToParticipant(tempId, { type: "auto_approved", message: "No admin online, auto approved", ticket, name });
      return;
    }

    for (const socket of adminSockets) {
      socket.send(JSON.stringify({ type: "admin_join_request", requestId: reqId, name }));
    }
  }

  async onApproveJoin(roomId, participantId, payload) {
    const adminId = await this.getAdminParticipantId(roomId);
    if (!adminId || participantId !== adminId) return; // Not the admin: silently ignored.

    const reqId = String(payload.requestId || "");
    const pending = await this.ctx.storage.get(`pending:${reqId}`);
    if (!pending || pending.roomId !== roomId || pending.status !== "pending" || pending.expiresAt < Date.now()) return;

    const ticket = await this.mintTicket(reqId, pending.name);
    pending.status = "approved";
    await this.ctx.storage.put(`pending:${reqId}`, pending);

    this.sendToParticipant(pending.tempId, { type: "join_approved", name: pending.name, ticket });
  }

  async onDeclineJoin(roomId, participantId, payload) {
    const adminId = await this.getAdminParticipantId(roomId);
    if (!adminId || participantId !== adminId) return;

    const reqId = String(payload.requestId || "");
    const pending = await this.ctx.storage.get(`pending:${reqId}`);
    if (!pending || pending.roomId !== roomId || pending.status !== "pending") return;

    pending.status = "declined";
    await this.ctx.storage.put(`pending:${reqId}`, pending);
    this.sendToParticipant(pending.tempId, { type: "join_declined" });
  }

  async mintTicket(reqId, name) {
    const ticket = randomToken(24);
    const ticketHash = await sha256(ticket);
    const now = Date.now();
    await this.ctx.storage.put(`ticket:${ticketHash}`, {
      reqId, name, createdAt: now, expiresAt: now + LIMITS.JOIN_TICKET_TTL_MS, used: false
    });
    await this.scheduleCleanup(now + LIMITS.JOIN_TICKET_TTL_MS);
    return ticket;
  }

  // Called by the Worker (over the same trusted binding-only path as
  // everything else in this class) when a client tries to finish joining
  // with a ticket. Single-use: the entry is deleted on first successful
  // consumption so replaying an old ticket never works twice.
  async handleConsumeTicket(request) {
    const { ticket } = await request.json().catch(() => ({}));
    if (!ticket) return Response.json({ ok: false });
    const ticketHash = await sha256(String(ticket));

    // Durable Objects gate delivery of new events while a storage op is
    // in flight, which already makes a lone get-then-put race-free in
    // the common case -- but that gating is only as good as "this
    // handler never awaits anything ungated in between", which is easy
    // to accidentally violate later. blockConcurrencyWhile() makes the
    // single-use invariant explicit and unconditional rather than
    // relying on it staying true by construction.
    return this.ctx.blockConcurrencyWhile(async () => {
      const entry = await this.ctx.storage.get(`ticket:${ticketHash}`);
      if (!entry || entry.used || entry.expiresAt < Date.now()) {
        return Response.json({ ok: false });
      }
      await this.ctx.storage.delete(`ticket:${ticketHash}`);
      return Response.json({ ok: true, name: entry.name });
    });
  }

  // ---- QR pairing codes (see BUG-008 in the audit) --------------------
  //
  // The "scan this on your phone" QR must never encode the real invite
  // bearer token, because that value gets sent to a third-party QR
  // image-rendering API. Instead we mint a short-lived, single-use,
  // opaque code that only resolves to the real invite URL via our own
  // server, so the third party only ever sees a meaningless code, never
  // the credential itself.
  async handleMintPairingCode(request) {
    const { inviteToken } = await request.json().catch(() => ({}));
    if (!inviteToken) return Response.json({ ok: false });

    const code = randomToken(16);
    const codeHash = await sha256(code);
    const now = Date.now();
    await this.ctx.storage.put(`pairing:${codeHash}`, {
      inviteToken, createdAt: now, expiresAt: now + LIMITS.PAIRING_CODE_TTL_MS, used: false
    });
    await this.scheduleCleanup(now + LIMITS.PAIRING_CODE_TTL_MS);
    return Response.json({ ok: true, code, expiresAt: now + LIMITS.PAIRING_CODE_TTL_MS });
  }

  async handleConsumePairingCode(request) {
    const { code } = await request.json().catch(() => ({}));
    if (!code) return Response.json({ ok: false });
    const codeHash = await sha256(String(code));

    return this.ctx.blockConcurrencyWhile(async () => {
      const entry = await this.ctx.storage.get(`pairing:${codeHash}`);
      if (!entry || entry.used || entry.expiresAt < Date.now()) {
        return Response.json({ ok: false });
      }

      // Single-use, but tolerate the phone's browser prefetching/retrying
      // the redirect by leaving a short "already used" tombstone instead
      // of deleting outright -- delete would make a benign double-
      // navigation fail with a confusing error.
      entry.used = true;
      await this.ctx.storage.put(`pairing:${codeHash}`, entry);
      return Response.json({ ok: true, inviteToken: entry.inviteToken });
    });
  }

  // ---- WebRTC signaling ------------------------------------------------
  //
  // Routed directly to the intended target's own socket(s) only, proven
  // sender id (server-verified connection metadata, never the payload),
  // and a target id that must actually look like a participant.
  onWebRtcSignal(roomId, participantId, payload) {
    const targetId = String(payload.targetId || "");
    if (!isUuid(targetId) || targetId === participantId) return;
    if (!this.socketsFor(targetId).length) return; // Target not connected to this room right now.

    this.sendToParticipant(targetId, {
      type: payload.type,
      senderId: participantId,
      data: payload.data
    });
  }

  async onMessage(ws, roomId, participantId, payload) {
    const result = await this.persistAndBroadcastMessage(roomId, participantId, payload.body);
    if (!result.ok) {
      this.sendError(ws, result.code, result.code === "EMPTY_MESSAGE" ? "Message body is empty." : "Message could not be saved.");
    }
  }

  async persistAndBroadcastMessage(roomId, participantId, rawBody) {
    const body = cleanMessage(rawBody);
    if (!body) return { ok: false, code: "EMPTY_MESSAGE" };

    try {
      const rows = await insert(this.env, "chat_messages", { room_id: roomId, participant_id: participantId, body });
      const saved = rows?.[0];
      if (!saved) return { ok: false, code: "SAVE_FAILED" };

      const people = await select(
        this.env,
        "chat_participants",
        `select=id,display_name&room_id=eq.${encodeURIComponent(roomId)}&id=eq.${encodeURIComponent(participantId)}`
      );
      const person = people?.[0];
      const message = {
        id: saved.id,
        participant_id: saved.participant_id,
        name: person?.display_name || "Participant",
        body: saved.body,
        created_at: saved.created_at
      };

      this.broadcast(roomId, { type: "message", message });
      return { ok: true, message };
    } catch (error) {
      console.error("message persistence failed", { message: error?.message });
      return { ok: false, code: "SAVE_FAILED" };
    }
  }

  // ---- rate limiting ---------------------------------------------------
  checkRate(key, max) {
    const now = Date.now();
    const timestamps = (this.messageTimestamps.get(key) || [])
      .filter(t => now - t < LIMITS.MESSAGE_RATE_WINDOW_MS);
    timestamps.push(now);
    this.messageTimestamps.set(key, timestamps);
    return timestamps.length <= max;
  }

  // ---- storage cleanup (Durable Object alarm) --------------------------
  //
  // Pending join requests, tickets and pairing codes all carry an
  // expiresAt. Rather than relying on every read path to notice
  // expiration (already done defensively above), an alarm periodically
  // sweeps stale entries so storage does not grow unboundedly across a
  // long-lived room.
  async scheduleCleanup(expiresAt) {
    const existing = await this.ctx.storage.getAlarm();
    if (existing === null || existing > expiresAt) {
      await this.ctx.storage.setAlarm(expiresAt + 1000);
    }
  }

  async alarm() {
    const now = Date.now();
    let nextAlarm = null;

    for (const prefix of ["pending:", "ticket:", "pairing:"]) {
      const entries = await this.ctx.storage.list({ prefix });
      for (const [key, value] of entries) {
        if (value?.expiresAt && value.expiresAt < now) {
          await this.ctx.storage.delete(key);
        } else if (value?.expiresAt) {
          nextAlarm = nextAlarm === null ? value.expiresAt : Math.min(nextAlarm, value.expiresAt);
        }
      }
    }

    if (nextAlarm !== null) await this.ctx.storage.setAlarm(nextAlarm + 1000);
  }

  // ---- socket helpers ---------------------------------------------------
  socketsFor(participantId) {
    return this.ctx.getWebSockets(`participant:${participantId}`).filter(ws => ws.readyState === WebSocket.OPEN);
  }

  sendToParticipant(participantId, payload) {
    const data = JSON.stringify(payload);
    for (const ws of this.socketsFor(participantId)) ws.send(data);
  }

  sendError(ws, code, message) {
    if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: "error", code, message }));
  }

  broadcast(roomId, payload, except = null) {
    const data = JSON.stringify(payload);
    for (const ws of this.ctx.getWebSockets(`room:${roomId}`)) {
      if (ws === except || ws.readyState !== WebSocket.OPEN) continue;
      ws.send(data);
    }
  }
}
