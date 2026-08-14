import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { handleMcpRequest } from "../src/mcp.js";
import { installFetchMock, jsonResponse } from "./helpers/mock-fetch.mjs";

const ROOM_ID = "2f1b1e2a-52b0-4a90-9f0a-1234567890ab";

function fakeRateLimiterNamespace() {
  return {
    idFromName: (name) => ({ name }),
    get: () => ({ async fetch() { return Response.json({ allowed: true, remaining: 59, retryAfterMs: 0 }); } })
  };
}

function baseEnv(extra = {}) {
  return { MCP_API_KEY: "test-mcp-key", RATE_LIMITER: fakeRateLimiterNamespace(), ...extra };
}

function rpcRequest(body, headers = {}) {
  return new Request("https://worker/mcp", {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body)
  });
}

describe("MCP endpoint authorization (BUG-010: no longer a placeholder)", () => {
  test("503 when MCP_API_KEY is not configured -- fails closed, not open", async () => {
    const res = await handleMcpRequest(rpcRequest({ jsonrpc: "2.0", id: 1, method: "tools/list" }), baseEnv({ MCP_API_KEY: "" }));
    assert.equal(res.status, 503);
  });

  test("401 with a missing or wrong bearer token", async () => {
    const noAuth = await handleMcpRequest(rpcRequest({ jsonrpc: "2.0", id: 1, method: "tools/list" }), baseEnv());
    assert.equal(noAuth.status, 401);

    const wrongAuth = await handleMcpRequest(
      rpcRequest({ jsonrpc: "2.0", id: 1, method: "tools/list" }, { Authorization: "Bearer wrong-key" }),
      baseEnv()
    );
    assert.equal(wrongAuth.status, 401);
  });

  test("a configured SUPABASE_SECRET_KEY never appears in any MCP response body", async () => {
    const secret = "sb_secret_should_never_leak_via_mcp";
    const restore = installFetchMock(async () => jsonResponse([]));
    try {
      const responses = await Promise.all([
        handleMcpRequest(rpcRequest({ jsonrpc: "2.0", id: 1, method: "initialize" }, { Authorization: "Bearer test-mcp-key" }), baseEnv({ SUPABASE_SECRET_KEY: secret })),
        handleMcpRequest(rpcRequest({ jsonrpc: "2.0", id: 2, method: "tools/list" }, { Authorization: "Bearer test-mcp-key" }), baseEnv({ SUPABASE_SECRET_KEY: secret })),
        handleMcpRequest(rpcRequest({
          jsonrpc: "2.0", id: 3, method: "tools/call",
          params: { name: "get_chat", arguments: { roomId: ROOM_ID, inviteToken: "x" } }
        }, { Authorization: "Bearer test-mcp-key" }), baseEnv({ SUPABASE_SECRET_KEY: secret }))
      ]);
      for (const res of responses) {
        const text = await res.text();
        assert.doesNotMatch(text, new RegExp(secret));
      }
    } finally {
      restore();
    }
  });

  test("valid key: tools/list returns the documented tool set", async () => {
    const res = await handleMcpRequest(
      rpcRequest({ jsonrpc: "2.0", id: 1, method: "tools/list" }, { Authorization: "Bearer test-mcp-key" }),
      baseEnv()
    );
    assert.equal(res.status, 200);
    const body = await res.json();
    const names = body.result.tools.map(t => t.name).sort();
    assert.deepEqual(names, ["create_chat", "create_invite", "get_chat", "list_messages", "send_message"].sort());
  });

  test("unknown method returns a JSON-RPC method-not-found error", async () => {
    const res = await handleMcpRequest(
      rpcRequest({ jsonrpc: "2.0", id: 7, method: "not/a/real/method" }, { Authorization: "Bearer test-mcp-key" }),
      baseEnv()
    );
    const body = await res.json();
    assert.equal(body.error.code, -32601);
    assert.equal(body.id, 7);
  });
});

describe("MCP tools/call still goes through the same room authorization as the web app", () => {
  test("get_chat fails without a valid invite, even with a valid MCP key", async () => {
    const restore = installFetchMock(async () => jsonResponse([])); // no invite row found
    try {
      const res = await handleMcpRequest(
        rpcRequest({
          jsonrpc: "2.0", id: 1, method: "tools/call",
          params: { name: "get_chat", arguments: { roomId: ROOM_ID, inviteToken: "wrong" } }
        }, { Authorization: "Bearer test-mcp-key" }),
        baseEnv()
      );
      const body = await res.json();
      assert.equal(body.result.isError, true);
      assert.match(body.result.content[0].text, /Invalid invite/i);
    } finally {
      restore();
    }
  });

  test("create_chat creates a room and, given a participantName, a first participant too", async () => {
    const restore = installFetchMock(async (url, init) => {
      if (url.includes("chat_rooms")) {
        return jsonResponse([{ id: ROOM_ID, title: "Bot Room", created_at: "2026-01-01T00:00:00Z" }]);
      }
      if (url.includes("chat_invites")) {
        return jsonResponse(null);
      }
      if (url.includes("chat_participants")) {
        const row = JSON.parse(init.body);
        return jsonResponse([{ id: "9c8d7e6f-5432-4a90-8b1c-abcdef012345", room_id: ROOM_ID, display_name: row.display_name }]);
      }
      throw new Error(`unexpected Supabase call: ${url}`);
    });
    try {
      const res = await handleMcpRequest(
        rpcRequest({
          jsonrpc: "2.0", id: 1, method: "tools/call",
          params: { name: "create_chat", arguments: { title: "Bot Room", participantName: "Gorgona Bot" } }
        }, { Authorization: "Bearer test-mcp-key" }),
        baseEnv()
      );
      const body = await res.json();
      const payload = JSON.parse(body.result.content[0].text);
      assert.equal(payload.chatId, ROOM_ID);
      assert.ok(payload.inviteToken);
      assert.ok(payload.participantId);
      assert.ok(payload.sessionToken);
    } finally {
      restore();
    }
  });
});
