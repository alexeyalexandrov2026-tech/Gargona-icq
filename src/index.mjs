import { ChatRoom } from "./chat-room.js";
import { RateLimiter, rateLimit, clientIp } from "./rate-limiter.js";
import { handleMcpRequest } from "./mcp.js";
import {
  json, apiError, corsHeaders, withSecurityHeaders,
  cleanName, isUuid, isPendingId, LIMITS
} from "./security.js";
import { verifyInvite, authenticateParticipant, readBearer, readWebSocketCredentials } from "./auth.js";
import {
  roomStub, createRoom, getRoomSummary, listParticipants, listMessages,
  createParticipant, hasAnyParticipant, withDisplayNames
} from "./rooms.js";
import {
  isAllowedContentType, mediaObjectName, mediaKey, mediaPath, putMedia, getMedia, contentLengthOk
} from "./media.js";

export { ChatRoom, RateLimiter };

function origin(request) {
  return new URL(request.url).origin;
}

async function readJson(request, maxBytes = LIMITS.HTTP_JSON_BODY_MAX) {
  const text = await request.text();
  if (text.length > maxBytes) return { ok: false };
  if (!text) return { ok: true, data: {} };
  try {
    return { ok: true, data: JSON.parse(text) };
  } catch {
    return { ok: false };
  }
}

// No inline styles here: the response carries the same strict CSP
// (style-src 'self', no 'unsafe-inline') as the rest of the app, via
// withSecurityHeaders() in the default export below.
function pairingExpiredPage() {
  return `<!doctype html><html lang="ru"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Код недействителен — Gorgona Chat</title></head>
<body>
<main><h1>Код истёк или уже использован</h1><p>Попросите администратора чата показать QR-код заново.</p></main>
</body></html>`;
}

// Exported for direct route testing (test/index.test.mjs); the default
// export below is what Cloudflare actually invokes per-request.
export async function api(request, env, url) {
  const cors = corsHeaders(request, env);

  if (request.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: cors });
  }

  if (url.pathname === "/api/health" && request.method === "GET") {
    return json({ ok: true, service: "gorgona-chat" }, 200, cors);
  }

  if (url.pathname === "/mcp" && request.method === "POST") {
    return handleMcpRequest(request, env);
  }

  if (url.pathname === "/api/chats" && request.method === "POST") {
    const rl = await rateLimit(env, "create-room", clientIp(request), 10, 10 * 60_000);
    if (!rl.allowed) {
      return apiError("RATE_LIMITED", "Too many rooms created from this network, try again later.", 429,
        { ...cors, "retry-after": String(Math.ceil(rl.retryAfterMs / 1000)) });
    }

    const parsed = await readJson(request);
    if (!parsed.ok) return apiError("INVALID_BODY", "Request body is invalid or too large.", 400, cors);

    const created = await createRoom(env, parsed.data.title);
    if (!created) return apiError("CREATE_FAILED", "Room creation failed.", 500, cors);

    return json({
      chatId: created.room.id,
      title: created.room.title,
      inviteToken: created.inviteToken,
      url: `${origin(request)}/c/${created.room.id}?invite=${encodeURIComponent(created.inviteToken)}`
    }, 201, cors);
  }

  const roomMatch = url.pathname.match(/^\/api\/chats\/([0-9a-f-]+)$/i);
  if (roomMatch && request.method === "GET") {
    const roomId = roomMatch[1];
    if (!isUuid(roomId)) return apiError("NOT_FOUND", "Room not found.", 404, cors);

    const invite = readBearer(request, "Authorization", "invite", url);
    if (!(await verifyInvite(env, roomId, invite))) return apiError("INVALID_INVITE", "Invalid invite.", 403, cors);

    const room = await getRoomSummary(env, roomId);
    const participants = await listParticipants(env, roomId);
    const { messages, hasMore, cursor } = await listMessages(env, roomId, {
      beforeCreatedAt: url.searchParams.get("before") || undefined,
      beforeId: url.searchParams.get("beforeId") || undefined,
      limit: url.searchParams.get("limit") || undefined
    });

    return json({
      chat: room,
      participants,
      messages: withDisplayNames(messages, participants),
      hasMore,
      cursor
    }, 200, cors);
  }

  const participantMatch = url.pathname.match(/^\/api\/chats\/([0-9a-f-]+)\/participants$/i);
  if (participantMatch && request.method === "POST") {
    const roomId = participantMatch[1];
    if (!isUuid(roomId)) return apiError("NOT_FOUND", "Room not found.", 404, cors);

    const rl = await rateLimit(env, "join", clientIp(request), 20, 10 * 60_000);
    if (!rl.allowed) return apiError("RATE_LIMITED", "Too many join attempts, try again later.", 429, cors);

    const parsed = await readJson(request);
    if (!parsed.ok) return apiError("INVALID_BODY", "Request body is invalid or too large.", 400, cors);
    const body = parsed.data;

    const invite = String(body.inviteToken || "");
    if (!(await verifyInvite(env, roomId, invite))) return apiError("INVALID_INVITE", "Invalid invite.", 403, cors);

    // The very first participant in a room has nobody to approve them --
    // they are the creator, and holding the invite is already the trust
    // boundary for that. Every participant after that must present a
    // single-use ticket minted by the room's real admin (see
    // ChatRoom#onApproveJoin) -- a plain POST with just the invite is no
    // longer enough to skip the approval flow.
    let name = cleanName(body.name);
    const roomOccupied = await hasAnyParticipant(env, roomId);

    if (roomOccupied) {
      const ticket = String(body.joinTicket || "");
      if (!ticket) return apiError("APPROVAL_REQUIRED", "This room requires admin approval to join.", 403, cors);

      const consumed = await roomStub(env, roomId).fetch("https://room/consume-ticket", {
        method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ ticket })
      }).then(r => r.json());
      if (!consumed.ok) return apiError("INVALID_TICKET", "Join approval is missing, expired, or already used.", 403, cors);

      // Trust the name the admin actually saw and approved, not whatever
      // the client sends in this request.
      name = cleanName(consumed.name);
    }

    const result = await createParticipant(env, roomId, name);
    if (result.error === "NAME_REQUIRED") return apiError("NAME_REQUIRED", "Name is required.", 400, cors);
    if (result.error) return apiError("JOIN_FAILED", "Could not join room.", 500, cors);

    await roomStub(env, roomId).fetch("https://room/presence", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ type: "participant_joined", participant: result.participant })
    });

    return json({ ...result.participant, sessionToken: result.sessionToken }, 201, cors);
  }

  const wsMatch = url.pathname.match(/^\/api\/rooms\/([0-9a-f-]+)\/ws$/i);
  if (wsMatch && request.headers.get("Upgrade")?.toLowerCase() === "websocket") {
    const roomId = wsMatch[1];
    if (!isUuid(roomId)) return new Response("Not found", { status: 404 });

    const rl = await rateLimit(env, "ws-connect", clientIp(request), 30, 60_000);
    if (!rl.allowed) {
      return new Response("Too Many Requests", { status: 429, headers: { "retry-after": String(Math.ceil(rl.retryAfterMs / 1000)) } });
    }

    const { invite, session } = readWebSocketCredentials(request, url);
    if (!(await verifyInvite(env, roomId, invite))) return new Response("Forbidden", { status: 403 });

    const participantId = url.searchParams.get("participantId") || "";
    if (isPendingId(participantId)) {
      // Not a participant yet -- allowed to connect only to submit a
      // join_request; the Durable Object enforces that restriction.
    } else if (isUuid(participantId)) {
      // Proves this connection actually owns participantId, closing the
      // impersonation hole where any invite holder could open a socket
      // "as" any participantId they had merely observed in a broadcast.
      if (!(await authenticateParticipant(env, roomId, participantId, session))) {
        return new Response("Forbidden", { status: 403 });
      }
    } else {
      return new Response("Forbidden", { status: 403 });
    }

    return roomStub(env, roomId).fetch(new Request(
      `https://room/ws?roomId=${encodeURIComponent(roomId)}&participantId=${encodeURIComponent(participantId)}`,
      request
    ));
  }

  const mediaUploadMatch = url.pathname.match(/^\/api\/chats\/([0-9a-f-]+)\/media$/i);
  if (mediaUploadMatch && request.method === "POST") {
    const roomId = mediaUploadMatch[1];
    if (!isUuid(roomId)) return apiError("NOT_FOUND", "Room not found.", 404, cors);
    if (!env.MEDIA_BUCKET) return apiError("MEDIA_NOT_CONFIGURED", "Media storage is not configured on this deployment.", 503, cors);

    const rl = await rateLimit(env, "media-upload", clientIp(request), 20, 10 * 60_000);
    if (!rl.allowed) return apiError("RATE_LIMITED", "Too many uploads, try again later.", 429, cors);

    const participantId = request.headers.get("X-Participant-Id") || "";
    const session = readBearer(request, "Authorization", "session", url);
    const authed = await authenticateParticipant(env, roomId, participantId, session);
    if (!authed) return apiError("UNAUTHORIZED", "Not authenticated for this room.", 401, cors);

    const contentType = (request.headers.get("content-type") || "").split(";")[0].trim().toLowerCase();
    if (!isAllowedContentType(contentType)) return apiError("UNSUPPORTED_MEDIA_TYPE", "Unsupported media type.", 415, cors);
    if (!contentLengthOk(request)) return apiError("PAYLOAD_TOO_LARGE", "File is too large.", 413, cors);

    const objectName = mediaObjectName(crypto.randomUUID(), contentType);
    const key = mediaKey(roomId, authed.id, objectName);
    if (!key) return apiError("BAD_REQUEST", "Could not create a storage key.", 400, cors);

    const bytes = await request.arrayBuffer();
    if (bytes.byteLength === 0) return apiError("EMPTY_BODY", "Empty upload.", 400, cors);
    if (bytes.byteLength > LIMITS.MEDIA_BYTES_MAX) return apiError("PAYLOAD_TOO_LARGE", "File is too large.", 413, cors);

    await putMedia(env, key, bytes, contentType);

    return json({ mediaPath: mediaPath(roomId, authed.id, objectName), contentType, size: bytes.byteLength }, 201, cors);
  }

  const mediaGetMatch = url.pathname.match(/^\/api\/media\/([0-9a-f-]+)\/([0-9a-f-]+)\/([0-9a-f-]+\.[a-z0-9]+)$/i);
  if (mediaGetMatch && request.method === "GET") {
    const [, roomId, participantId, objectName] = mediaGetMatch;
    if (!isUuid(roomId) || !isUuid(participantId)) return new Response("Not found", { status: 404 });
    if (!env.MEDIA_BUCKET) return new Response("Not found", { status: 404 });

    const invite = readBearer(request, "Authorization", "invite", url);
    if (!(await verifyInvite(env, roomId, invite))) return new Response("Forbidden", { status: 403 });

    const key = mediaKey(roomId, participantId, objectName);
    if (!key) return new Response("Not found", { status: 404 });

    const object = await getMedia(env, key);
    if (!object) return new Response("Not found", { status: 404 });

    const headers = new Headers();
    object.writeHttpMetadata(headers);
    headers.set("etag", object.httpEtag);
    headers.set("cache-control", "private, max-age=31536000, immutable");
    return new Response(object.body, { headers });
  }

  const pairingMintMatch = url.pathname.match(/^\/api\/chats\/([0-9a-f-]+)\/pairing-code$/i);
  if (pairingMintMatch && request.method === "POST") {
    const roomId = pairingMintMatch[1];
    if (!isUuid(roomId)) return apiError("NOT_FOUND", "Room not found.", 404, cors);

    const parsed = await readJson(request);
    if (!parsed.ok) return apiError("INVALID_BODY", "Request body is invalid.", 400, cors);

    const invite = String(parsed.data.inviteToken || "");
    if (!(await verifyInvite(env, roomId, invite))) return apiError("INVALID_INVITE", "Invalid invite.", 403, cors);

    const rl = await rateLimit(env, "pairing-mint", clientIp(request), 10, 10 * 60_000);
    if (!rl.allowed) return apiError("RATE_LIMITED", "Too many pairing codes requested.", 429, cors);

    const minted = await roomStub(env, roomId).fetch("https://room/pairing/mint", {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ inviteToken: invite })
    }).then(r => r.json());
    if (!minted.ok) return apiError("PAIRING_FAILED", "Could not create a pairing code.", 500, cors);

    return json({ url: `${origin(request)}/p/${roomId}/${minted.code}`, expiresAt: minted.expiresAt }, 201, cors);
  }

  // Opened directly by a phone browser scanning the QR code. Resolves a
  // short-lived single-use code to the real invite and redirects -- the
  // QR image itself only ever encoded this opaque URL, never the invite
  // bearer token (see ChatRoom#handleMintPairingCode).
  const pairingRedirectMatch = url.pathname.match(/^\/p\/([0-9a-f-]+)\/([A-Za-z0-9_-]+)$/);
  if (pairingRedirectMatch && request.method === "GET") {
    const [, roomId, code] = pairingRedirectMatch;
    if (!isUuid(roomId)) return new Response("Not found", { status: 404 });

    const consumed = await roomStub(env, roomId).fetch("https://room/pairing/consume", {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ code })
    }).then(r => r.json());

    if (!consumed.ok) {
      return new Response(pairingExpiredPage(), { status: 410, headers: { "content-type": "text/html; charset=utf-8" } });
    }
    return Response.redirect(`${origin(request)}/c/${roomId}?invite=${encodeURIComponent(consumed.inviteToken)}`, 302);
  }

  return null;
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    try {
      const response = await api(request, env, url);
      if (response) {
        // A 101 Switching Protocols response carries a live `webSocket`
        // that would be lost if reconstructed via `new Response(...)`,
        // so it must be returned exactly as-is.
        if (response.status === 101) return response;
        return withSecurityHeaders(response);
      }
    } catch (error) {
      console.error("Gorgona API error", { message: error?.message });
      return withSecurityHeaders(apiError("INTERNAL_ERROR", "Internal server error.", 500, corsHeaders(request, env)));
    }

    return withSecurityHeaders(await env.ASSETS.fetch(request));
  }
};
