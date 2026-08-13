import { ChatRoom } from "./chat-room.js";
import { insert, select } from "./supabase.js";
import { cleanName, json, randomToken, sha256, corsHeaders } from "./security.js";

export { ChatRoom };

function origin(request) {
  return new URL(request.url).origin;
}

function roomStub(env, roomId) {
  const id = env.CHAT_ROOMS.idFromName(roomId);
  return env.CHAT_ROOMS.get(id);
}

async function roomInfo(env, roomId, inviteToken) {
  if (!inviteToken) return null;
  const tokenHash = await sha256(inviteToken);
  const invites = await select(
    env,
    "chat_invites",
    `select=room_id&token_hash=eq.${encodeURIComponent(tokenHash)}&revoked_at=is.null&room_id=eq.${encodeURIComponent(roomId)}&limit=1`
  );
  return invites?.[0] || null;
}

async function readJson(request) {
  try { return await request.json(); } catch { return {}; }
}

async function api(request, env, url) {
  if (request.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: corsHeaders(origin(request)) });
  }

  if (url.pathname === "/api/health" && request.method === "GET") {
    return json({ ok: true, service: "gorgona-chat" });
  }

  if (url.pathname === "/api/chats" && request.method === "POST") {
    const body = await readJson(request);
    const title = String(body.title || "Gorgona Chat").trim().slice(0, 80) || "Gorgona Chat";
    const inviteToken = randomToken(32);
    const tokenHash = await sha256(inviteToken);

    const rooms = await insert(env, "chat_rooms", { title });
    const room = rooms?.[0];
    if (!room) return json({ error: "Room creation failed" }, 500, corsHeaders(origin(request)));

    await insert(env, "chat_invites", {
      token_hash: tokenHash,
      room_id: room.id
    }, { returning: false });

    return json({
      chatId: room.id,
      title: room.title,
      inviteToken,
      url: `${origin(request)}/c/${room.id}?invite=${encodeURIComponent(inviteToken)}`
    }, 201, corsHeaders(origin(request)));
  }

  const roomMatch = url.pathname.match(/^\/api\/chats\/([0-9a-f-]+)$/i);
  if (roomMatch && request.method === "GET") {
    const roomId = roomMatch[1];
    const invite = url.searchParams.get("invite");
    const authorized = await roomInfo(env, roomId, invite);
    if (!authorized) return json({ error: "Invalid invite" }, 403, corsHeaders(origin(request)));

    const [rooms, participants, messages] = await Promise.all([
      select(env, "chat_rooms", `select=id,title,created_at&id=eq.${encodeURIComponent(roomId)}&limit=1`),
      select(env, "chat_participants", `select=id,display_name,created_at&room_id=eq.${encodeURIComponent(roomId)}&order=created_at.asc`),
      select(env, "chat_messages", `select=id,participant_id,body,created_at&room_id=eq.${encodeURIComponent(roomId)}&order=created_at.asc&limit=500`)
    ]);

    const people = new Map((participants || []).map(p => [p.id, p.display_name]));
    return json({
      chat: rooms?.[0] || null,
      participants: participants || [],
      messages: (messages || []).map(m => ({ ...m, name: people.get(m.participant_id) || "Participant" }))
    }, 200, corsHeaders(origin(request)));
  }

  const participantMatch = url.pathname.match(/^\/api\/chats\/([0-9a-f-]+)\/participants$/i);
  if (participantMatch && request.method === "POST") {
    const roomId = participantMatch[1];
    const body = await readJson(request);
    const invite = String(body.inviteToken || "");
    const authorized = await roomInfo(env, roomId, invite);
    if (!authorized) return json({ error: "Invalid invite" }, 403, corsHeaders(origin(request)));

    const name = cleanName(body.name);
    if (!name) return json({ error: "Name is required" }, 400, corsHeaders(origin(request)));

    const rows = await insert(env, "chat_participants", {
      room_id: roomId,
      display_name: name
    });
    const participant = rows?.[0];
    if (!participant) return json({ error: "Could not join room" }, 500, corsHeaders(origin(request)));

    const stub = roomStub(env, roomId);
    await stub.fetch("https://room/presence", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ type: "participant_joined", participant })
    });

    return json(participant, 201, corsHeaders(origin(request)));
  }

  const wsMatch = url.pathname.match(/^\/api\/rooms\/([0-9a-f-]+)\/ws$/i);
  if (wsMatch && request.headers.get("Upgrade")?.toLowerCase() === "websocket") {
    const roomId = wsMatch[1];
    const invite = url.searchParams.get("invite");
    const participantId = url.searchParams.get("participantId");
    const authorized = await roomInfo(env, roomId, invite);
    if (!authorized || !participantId) return new Response("Forbidden", { status: 403 });

    const people = await select(
      env,
      "chat_participants",
      `select=id&room_id=eq.${encodeURIComponent(roomId)}&id=eq.${encodeURIComponent(participantId)}&limit=1`
    );
    if (!people?.[0]) return new Response("Forbidden", { status: 403 });

    return roomStub(env, roomId).fetch(new Request(
      `https://room/ws?roomId=${encodeURIComponent(roomId)}&participantId=${encodeURIComponent(participantId)}`,
      request
    ));
  }

  return null;
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    try {
      const response = await api(request, env, url);
      if (response) return response;
    } catch (error) {
      console.error("Gorgona API error", error);
      return json({ error: "Internal server error" }, 500, corsHeaders(origin(request)));
    }

    return env.ASSETS.fetch(request);
  }
};
