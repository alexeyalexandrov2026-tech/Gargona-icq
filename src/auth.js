// Shared authorization primitives. Every endpoint that needs to know
// "who is calling, and are they allowed to do this" should go through
// these functions instead of re-implementing checks inline.
//
//   verifyInvite()            -> does this bearer invite unlock this room?
//   authenticateParticipant() -> does this participantId+session belong to
//                                a real row in this room? (proves identity,
//                                prevents impersonation)
//
// Nothing here trusts client-supplied booleans (e.g. "isAdmin"). Admin
// status is derived and enforced inside the ChatRoom Durable Object from
// persisted participant creation order (see chat-room.js).

import { sha256, timingSafeEqual } from "./security.js";
import { select } from "./supabase.js";

export async function verifyInvite(env, roomId, inviteToken) {
  if (!roomId || !inviteToken) return false;
  const tokenHash = await sha256(inviteToken);
  const invites = await select(
    env,
    "chat_invites",
    `select=room_id&token_hash=eq.${encodeURIComponent(tokenHash)}&revoked_at=is.null&room_id=eq.${encodeURIComponent(roomId)}&limit=1`
  );
  return Boolean(invites?.[0]);
}

// Proves that the caller actually owns `participantId` in `roomId` by
// requiring the session token issued once, at participant-creation time.
// Returns the participant row on success, or null. This is what stands
// between "any invite holder" and "a specific named seat in the room".
export async function authenticateParticipant(env, roomId, participantId, sessionToken) {
  if (!roomId || !participantId || !sessionToken) return null;

  const rows = await select(
    env,
    "chat_participants",
    `select=id,display_name,session_token_hash&room_id=eq.${encodeURIComponent(roomId)}&id=eq.${encodeURIComponent(participantId)}&limit=1`
  );
  const person = rows?.[0];
  if (!person || !person.session_token_hash) return null;

  const candidateHash = await sha256(sessionToken);
  if (!timingSafeEqual(candidateHash, person.session_token_hash)) return null;

  return { id: person.id, displayName: person.display_name };
}

// Extracts bearer-style credentials from a request, preferring headers
// (not logged/kept in browser history the way URLs are) over query
// params, which remain supported as a fallback for callers that cannot
// set headers (e.g. plain hyperlinks).
export function readBearer(request, headerName, queryName, url) {
  const auth = request.headers.get(headerName);
  if (auth) {
    const match = auth.match(/^Bearer\s+(.+)$/i);
    if (match) return match[1].trim();
  }
  return url.searchParams.get(queryName) || "";
}

// WebSocket handshakes cannot set arbitrary headers from the browser, but
// they can offer a list of subprotocols via Sec-WebSocket-Protocol, which
// (unlike the URL) is never stored in browser history and never sent as a
// Referer. We smuggle the invite/session tokens as prefixed subprotocol
// entries so the client does not have to put bearer credentials in the
// connection URL. A `?invite=`/`&session=` query fallback is still
// accepted server-side for tooling/back-compat, but the shipped client
// always uses the protocol-header form.
export function readWebSocketCredentials(request, url) {
  const offered = (request.headers.get("Sec-WebSocket-Protocol") || "")
    .split(",")
    .map(s => s.trim())
    .filter(Boolean);

  let invite = "";
  let session = "";
  for (const value of offered) {
    if (value.startsWith("gorgona.invite.")) invite = value.slice("gorgona.invite.".length);
    else if (value.startsWith("gorgona.session.")) session = value.slice("gorgona.session.".length);
  }

  if (!invite) invite = url.searchParams.get("invite") || "";
  if (!session) session = url.searchParams.get("session") || "";

  return { invite, session, offeredProtocols: offered };
}
