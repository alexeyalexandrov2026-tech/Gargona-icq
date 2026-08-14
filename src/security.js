const encoder = new TextEncoder();

// Single source of truth for every size/length limit in the system.
// Keep application-layer limits <= database CHECK constraints (see
// supabase/migrations) so nothing can be accepted here and rejected there.
export const LIMITS = {
  ROOM_TITLE_MAX: 80,
  DISPLAY_NAME_MAX: 40,
  MESSAGE_BODY_MAX: 4000,
  HTTP_JSON_BODY_MAX: 32 * 1024, // generic small JSON API requests
  MEDIA_BYTES_MAX: 8 * 1024 * 1024, // photo/video upload stored in R2
  HISTORY_PAGE_DEFAULT: 50,
  HISTORY_PAGE_MAX: 100,
  PENDING_REQUEST_TTL_MS: 10 * 60 * 1000,
  JOIN_TICKET_TTL_MS: 5 * 60 * 1000,
  PAIRING_CODE_TTL_MS: 2 * 60 * 1000,
  MESSAGE_RATE_WINDOW_MS: 10 * 1000,
  MESSAGE_RATE_MAX: 20
};

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const PENDING_ID_RE = /^pending-[a-z0-9]{1,64}$/i;

export function isUuid(value) {
  return typeof value === "string" && UUID_RE.test(value);
}

export function isPendingId(value) {
  return typeof value === "string" && PENDING_ID_RE.test(value);
}

export function randomToken(bytes = 32) {
  const data = new Uint8Array(bytes);
  crypto.getRandomValues(data);
  return btoa(String.fromCharCode(...data))
    .replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
}

export async function sha256(value) {
  const digest = await crypto.subtle.digest("SHA-256", encoder.encode(value));
  return [...new Uint8Array(digest)]
    .map(x => x.toString(16).padStart(2, "0")).join("");
}

// Constant-time comparison for hash/token strings. Defense-in-depth only:
// stored values here are already one-way hashes, but comparing any
// credential-derived string byte-by-byte with early exit is bad practice.
export function timingSafeEqual(a, b) {
  if (typeof a !== "string" || typeof b !== "string") return false;
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

export function cleanName(value) {
  return String(value || "").trim().replace(/\s+/g, " ").slice(0, LIMITS.DISPLAY_NAME_MAX);
}

export function cleanRoomTitle(value) {
  return String(value || "").trim().slice(0, LIMITS.ROOM_TITLE_MAX);
}

export function cleanMessage(value) {
  return String(value || "").trim().slice(0, LIMITS.MESSAGE_BODY_MAX);
}

export function json(data, status = 200, extra = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
      ...extra
    }
  });
}

// Single consistent error envelope for the whole API surface.
export function apiError(code, message, status = 400, extra = {}) {
  return json({ error: { code, message } }, status, extra);
}

export function corsHeaders(request, env) {
  const requestOrigin = request.headers.get("Origin");
  const selfOrigin = new URL(request.url).origin;
  const allowed = allowedOrigins(env);

  const headers = {
    "access-control-allow-methods": "GET,POST,OPTIONS",
    "access-control-allow-headers": "content-type, authorization, sec-websocket-protocol",
    "access-control-max-age": "86400",
    "vary": "Origin"
  };

  if (requestOrigin && (requestOrigin === selfOrigin || allowed.has(requestOrigin))) {
    headers["access-control-allow-origin"] = requestOrigin;
  }
  // No Origin header (same-origin navigation, curl, server-to-server) or an
  // origin outside the allowlist: omit the header entirely rather than
  // reflecting an arbitrary Origin back. Browsers then block cross-origin
  // reads by default.

  return headers;
}

function allowedOrigins(env) {
  const raw = String(env?.ALLOWED_ORIGINS || "");
  return new Set(raw.split(",").map(s => s.trim()).filter(Boolean));
}

// Applied to every response the Worker returns, including static assets.
export function securityHeaders() {
  return {
    "x-content-type-options": "nosniff",
    "referrer-policy": "no-referrer",
    "x-frame-options": "DENY",
    "permissions-policy": "camera=(self), microphone=(self), geolocation=(self)",
    "strict-transport-security": "max-age=63072000; includeSubDomains",
    "content-security-policy": [
      "default-src 'self'",
      "script-src 'self'",
      "style-src 'self'",
      // api.qrserver.com renders the phone-pairing QR image (see BUG-008
      // fix in auth.js/chat-room.js: it only ever receives a short-lived,
      // single-use, opaque pairing URL, never the real invite token).
      "img-src 'self' data: blob: https://api.qrserver.com",
      "media-src 'self' data: blob:",
      "connect-src 'self'",
      "frame-ancestors 'none'",
      "base-uri 'none'",
      "form-action 'self'"
    ].join("; ")
  };
}

export function withSecurityHeaders(response) {
  const headers = new Headers(response.headers);
  for (const [key, value] of Object.entries(securityHeaders())) {
    if (!headers.has(key)) headers.set(key, value);
  }
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}
