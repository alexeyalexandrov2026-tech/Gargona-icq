const encoder = new TextEncoder();

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

export function cleanName(value) {
  return String(value || "").trim().replace(/\s+/g, " ").slice(0, 40);
}

export function cleanMessage(value) {
  return String(value || "").trim().slice(0, 51200);
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

export function corsHeaders(requestOrigin) {
  // Only allow same-origin requests
  const allowed = requestOrigin || "*";
  return {
    "access-control-allow-origin": allowed,
    "access-control-allow-methods": "GET,POST,OPTIONS",
    "access-control-allow-headers": "content-type",
    "access-control-max-age": "86400",
    "vary": "Origin"
  };
}
