// Minimal global-fetch stub for tests that exercise code paths calling
// out to the Supabase REST API (src/supabase.js uses the platform
// `fetch` global directly, same as it does in the Workers runtime, so
// swapping `globalThis.fetch` is enough -- no HTTP mocking library
// needed for this small a surface).

export function installFetchMock(handler) {
  const original = globalThis.fetch;
  globalThis.fetch = async (url, init) => handler(String(url), init);
  return () => { globalThis.fetch = original; };
}

export function jsonResponse(body, status = 200) {
  return new Response(body === null ? "" : JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" }
  });
}
