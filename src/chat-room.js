import { DurableObject } from "cloudflare:workers";
import { insert, select } from "./supabase.js";
import { cleanMessage } from "./security.js";

export class ChatRoom extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.env = env;
    this.adminParticipantId = null;
    this.pendingRequests = new Map();
  }

  async fetch(request) {
    const url = new URL(request.url);

    if (url.pathname === "/presence" && request.method === "POST") {
      try {
        const body = await request.json();
        if (body.type === "participant_joined" && body.participant?.room_id) {
          if (!this.adminParticipantId) {
            this.adminParticipantId = body.participant.id;
          }
          this.broadcast(body.participant.room_id, {
            type: "participant_joined",
            participant: body.participant,
            adminId: this.adminParticipantId
          });
        }
      } catch (err) {
        console.error("Presence error", err);
      }
      return new Response("ok", { status: 200 });
    }

    if (url.pathname !== "/ws" || request.headers.get("Upgrade")?.toLowerCase() !== "websocket") {
      return new Response("Not found", { status: 404 });
    }

    const roomId = url.searchParams.get("roomId");
    const participantId = url.searchParams.get("participantId");
    if (!roomId || !participantId) {
      return new Response("Missing roomId or participantId", { status: 400 });
    }

    if (!this.adminParticipantId) {
      const people = await select(
        this.env,
        "chat_participants",
        `select=id&room_id=eq.${encodeURIComponent(roomId)}&order=created_at.asc&limit=1`
      );
      if (people?.[0]) {
        this.adminParticipantId = people[0].id;
      }
    }

    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);

    this.ctx.acceptWebSocket(server, [`room:${roomId}`, `participant:${participantId}`]);
    server.serializeAttachment({ roomId, participantId });
    this.broadcast(roomId, { type: "presence", participantId, online: true, adminId: this.adminParticipantId }, server);

    return new Response(null, { status: 101, webSocket: client });
  }

  async webSocketMessage(ws, message) {
    let payload;
    try {
      payload = JSON.parse(message);
    } catch {
      return;
    }

    const meta = ws.deserializeAttachment() || {};
    const roomId = meta.roomId;
    const participantId = meta.participantId;

    if (!roomId || !participantId) return;

    if (payload.type === "join_request") {
      const reqId = crypto.randomUUID();
      this.pendingRequests.set(reqId, { ...payload, roomId, socket: ws });
      
      const adminSockets = this.ctx.getWebSockets(`participant:${this.adminParticipantId}`);
      const adminPayload = JSON.stringify({
        type: "admin_join_request",
        requestId: reqId,
        name: payload.name
      });

      let sentToAdmin = false;
      for (const adminWs of adminSockets) {
        if (adminWs.readyState === WebSocket.OPEN) {
          adminWs.send(adminPayload);
          sentToAdmin = true;
        }
      }

      if (!sentToAdmin) {
        ws.send(JSON.stringify({ type: "auto_approved", message: "Admin offline, auto approved" }));
      }
      return;
    }

    if (payload.type === "approve_join" && participantId === this.adminParticipantId) {
      const pending = this.pendingRequests.get(payload.requestId);
      if (pending && pending.socket?.readyState === WebSocket.OPEN) {
        pending.socket.send(JSON.stringify({ type: "join_approved", name: pending.name }));
      }
      this.pendingRequests.delete(payload.requestId);
      return;
    }

    if (payload.type === "decline_join" && participantId === this.adminParticipantId) {
      const pending = this.pendingRequests.get(payload.requestId);
      if (pending && pending.socket?.readyState === WebSocket.OPEN) {
        pending.socket.send(JSON.stringify({ type: "join_declined" }));
      }
      this.pendingRequests.delete(payload.requestId);
      return;
    }

    if (payload.type === "webrtc_offer" || payload.type === "webrtc_answer" || payload.type === "webrtc_ice_candidate") {
      this.broadcast(roomId, {
        type: payload.type,
        senderId: participantId,
        targetId: payload.targetId,
        data: payload.data
      }, ws);
      return;
    }

    if (payload.type === "participant_joined") {
      this.broadcast(roomId, {
        type: "participant_joined",
        participant: payload.participant,
        adminId: this.adminParticipantId
      });
      return;
    }

    if (payload.type === "typing") {
      this.broadcast(roomId, {
        type: "typing",
        participantId,
        typing: Boolean(payload.typing)
      }, ws);
      return;
    }

    if (payload.type !== "message") return;

    const body = cleanMessage(payload.body);
    if (!body) return;

    try {
      const rows = await insert(this.env, "chat_messages", {
        room_id: roomId,
        participant_id: participantId,
        body
      });
      const saved = rows?.[0];
      if (!saved) return;

      const people = await select(
        this.env,
        "chat_participants",
        `select=id,display_name&room_id=eq.${encodeURIComponent(roomId)}&id=eq.${encodeURIComponent(participantId)}`
      );
      const person = people?.[0];

      this.broadcast(roomId, {
        type: "message",
        message: {
          id: saved.id,
          participant_id: saved.participant_id,
          name: person?.display_name || "Participant",
          body: saved.body,
          created_at: saved.created_at
        }
      });
    } catch (error) {
      console.error("message persistence failed", error);
      ws.send(JSON.stringify({ type: "error", message: "Message could not be saved." }));
    }
  }

  async webSocketClose(ws) {
    const meta = ws.deserializeAttachment() || {};
    if (meta.roomId && meta.participantId) {
      this.broadcast(meta.roomId, {
        type: "presence",
        participantId: meta.participantId,
        online: false
      }, ws);
    }
  }

  async webSocketError(ws, error) {
    console.error("Gorgona Chat WebSocket error", error);
  }

  broadcast(roomId, payload, except = null) {
    const data = JSON.stringify(payload);
    for (const ws of this.ctx.getWebSockets(`room:${roomId}`)) {
      if (ws === except || ws.readyState !== WebSocket.OPEN) continue;
      ws.send(data);
    }
  }
}
