// Domain logic shared by the HTTP API (index.mjs) and the MCP endpoint
// (mcp.js), so "how a room/participant/message is created or read" is
// defined exactly once instead of drifting between two implementations.

import { insert, select } from "./supabase.js";
import { cleanName, cleanRoomTitle, randomToken, sha256, LIMITS } from "./security.js";

export function roomStub(env, roomId) {
  const id = env.CHAT_ROOMS.idFromName(roomId);
  return env.CHAT_ROOMS.get(id);
}

export async function createRoom(env, rawTitle) {
  const title = cleanRoomTitle(rawTitle) || "Gorgona Chat";
  const inviteToken = randomToken(32);
  const tokenHash = await sha256(inviteToken);

  const rooms = await insert(env, "chat_rooms", { title });
  const room = rooms?.[0];
  if (!room) return null;

  await insert(env, "chat_invites", { token_hash: tokenHash, room_id: room.id }, { returning: false });
  return { room, inviteToken };
}

export async function createInvite(env, roomId) {
  const inviteToken = randomToken(32);
  const tokenHash = await sha256(inviteToken);
  await insert(env, "chat_invites", { token_hash: tokenHash, room_id: roomId }, { returning: false });
  return inviteToken;
}

export async function getRoomSummary(env, roomId) {
  const rooms = await select(env, "chat_rooms", `select=id,title,created_at&id=eq.${encodeURIComponent(roomId)}&limit=1`);
  return rooms?.[0] || null;
}

export async function listParticipants(env, roomId) {
  return (await select(
    env,
    "chat_participants",
    `select=id,display_name,created_at&room_id=eq.${encodeURIComponent(roomId)}&order=created_at.asc`
  )) || [];
}

// Callers only ever need "is this room empty or not" (to decide whether
// the join-ticket requirement applies to the very first participant) --
// a 1-row existence probe avoids pulling a full count for that.
export async function hasAnyParticipant(env, roomId) {
  const rows = await select(env, "chat_participants", `select=id&room_id=eq.${encodeURIComponent(roomId)}&limit=1`);
  return Boolean(rows?.length);
}

export async function createParticipant(env, roomId, name) {
  const cleaned = cleanName(name);
  if (!cleaned) return { error: "NAME_REQUIRED" };

  const sessionToken = randomToken(32);
  const sessionTokenHash = await sha256(sessionToken);

  const rows = await insert(env, "chat_participants", {
    room_id: roomId,
    display_name: cleaned,
    session_token_hash: sessionTokenHash
  });
  const participant = rows?.[0];
  if (!participant) return { error: "JOIN_FAILED" };

  // Never let the session hash itself leave the server, even though it
  // is one-way -- there is no reason to expose it.
  const { session_token_hash, ...publicParticipant } = participant;
  return { participant: publicParticipant, sessionToken };
}

// Compound-cursor pagination: (created_at, id) both descending, so pages
// stay stable and gap/duplicate-free even when two messages share the
// same microsecond-resolution timestamp (real under concurrent senders).
export async function listMessages(env, roomId, { beforeCreatedAt, beforeId, limit } = {}) {
  const pageSize = Math.min(Math.max(Number(limit) || LIMITS.HISTORY_PAGE_DEFAULT, 1), LIMITS.HISTORY_PAGE_MAX);

  let query = `select=id,participant_id,body,created_at&room_id=eq.${encodeURIComponent(roomId)}` +
    `&order=created_at.desc,id.desc&limit=${pageSize + 1}`;

  if (beforeCreatedAt && beforeId) {
    query += `&or=(created_at.lt.${encodeURIComponent(beforeCreatedAt)},and(created_at.eq.${encodeURIComponent(beforeCreatedAt)},id.lt.${encodeURIComponent(beforeId)}))`;
  } else if (beforeCreatedAt) {
    query += `&created_at=lt.${encodeURIComponent(beforeCreatedAt)}`;
  }

  const rows = (await select(env, "chat_messages", query)) || [];
  const hasMore = rows.length > pageSize;
  const page = rows.slice(0, pageSize).reverse(); // oldest-first for the client

  return {
    messages: page,
    hasMore,
    cursor: hasMore && page.length ? { beforeCreatedAt: page[0].created_at, beforeId: page[0].id } : null
  };
}

export function withDisplayNames(messages, participants) {
  const people = new Map(participants.map(p => [p.id, p.display_name]));
  return messages.map(m => ({ ...m, name: people.get(m.participant_id) || "Participant" }));
}
