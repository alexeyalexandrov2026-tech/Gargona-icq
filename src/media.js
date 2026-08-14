// Object storage for photo / video-note attachments.
//
// Media used to be embedded as base64 data URLs directly inside
// chat_messages.body. That meant multi-megabyte text rows in Postgres,
// the full blob re-sent to every connected client on every broadcast, and
// no separation between "chat text" and "binary attachment". Attachments
// now live in R2; a chat message only ever carries a small JSON
// reference (`{type, mediaPath, contentType, ...}`) that comfortably
// fits inside the normal message size limit.

import { LIMITS, isUuid } from "./security.js";

const EXTENSION_BY_CONTENT_TYPE = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
  "video/webm": "webm",
  "video/mp4": "mp4"
};

const OBJECT_NAME_RE = /^[0-9a-f-]{36}\.[a-z0-9]+$/i;

export function isAllowedContentType(contentType) {
  return Object.prototype.hasOwnProperty.call(EXTENSION_BY_CONTENT_TYPE, contentType);
}

// "<uuid>.<ext>" -- the object's file name within its participant's
// folder. Never derived from client input beyond the (validated)
// Content-Type, so it cannot be used for path traversal.
export function mediaObjectName(objectId, contentType) {
  const ext = EXTENSION_BY_CONTENT_TYPE[contentType];
  if (!isUuid(objectId) || !ext) return null;
  return `${objectId}.${ext}`;
}

export function mediaKey(roomId, participantId, objectName) {
  if (!isUuid(roomId) || !isUuid(participantId) || !OBJECT_NAME_RE.test(String(objectName || ""))) return null;
  return `${roomId}/${participantId}/${objectName}`;
}

export function mediaPath(roomId, participantId, objectName) {
  return `/api/media/${roomId}/${participantId}/${objectName}`;
}

export async function putMedia(env, key, body, contentType) {
  await env.MEDIA_BUCKET.put(key, body, { httpMetadata: { contentType } });
}

export async function getMedia(env, key) {
  return env.MEDIA_BUCKET.get(key);
}

export function contentLengthOk(request) {
  const header = request.headers.get("content-length");
  if (header === null) return true; // Workers still enforce a platform-level body cap regardless.
  const length = Number(header);
  return Number.isFinite(length) && length > 0 && length <= LIMITS.MEDIA_BYTES_MAX;
}
