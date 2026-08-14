// Minimal, real MCP (Model Context Protocol) endpoint for Gorgona Chat.
//
// This intentionally replaces a previous placeholder file that was just
// a comment block describing what MCP tools *should* exist. It is now a
// working "Streamable HTTP" JSON-RPC 2.0 transport (POST-only; every
// response is a plain JSON body, which is valid for tools that do not
// need to stream) exposing the five tools the README always documented:
// create_chat, get_chat, list_messages, send_message, create_invite.
//
// Authorization model, matching the web app rather than bypassing it:
//   - The whole endpoint requires `Authorization: Bearer <MCP_API_KEY>`,
//     a server-only secret. SUPABASE_SECRET_KEY is never referenced here
//     and never leaves the Worker.
//   - Tools that read/write a specific room still require that room's
//     invite token, exactly like the web client. MCP is not a backdoor
//     around room authorization.
//   - send_message requires a real participantId + sessionToken, exactly
//     like a WebSocket connection would. create_chat can optionally mint
//     that identity in the same call (the room's first participant), so
//     a caller can create a room and immediately speak in it.

import { verifyInvite, authenticateParticipant } from "./auth.js";
import {
  createRoom, createInvite, getRoomSummary, listParticipants,
  listMessages, createParticipant, withDisplayNames, roomStub
} from "./rooms.js";
import { cleanMessage, isUuid, LIMITS } from "./security.js";
import { rateLimit, clientIp } from "./rate-limiter.js";

const PROTOCOL_VERSION = "2025-03-26";

const TOOLS = [
  {
    name: "create_chat",
    description: "Create a new Gorgona Chat room and its first invite link. Optionally also creates a first participant identity (e.g. for a bot) that can immediately call send_message.",
    inputSchema: {
      type: "object",
      properties: {
        title: { type: "string", maxLength: 80 },
        participantName: { type: "string", maxLength: 40, description: "If set, also creates a first participant with this name and returns participantId/sessionToken for it." }
      }
    }
  },
  {
    name: "create_invite",
    description: "Mint an additional invite link for a room you already hold a valid invite to.",
    inputSchema: {
      type: "object",
      properties: { roomId: { type: "string" }, inviteToken: { type: "string" } },
      required: ["roomId", "inviteToken"]
    }
  },
  {
    name: "get_chat",
    description: "Get a room's title, participant list, and the most recent page of messages.",
    inputSchema: {
      type: "object",
      properties: { roomId: { type: "string" }, inviteToken: { type: "string" } },
      required: ["roomId", "inviteToken"]
    }
  },
  {
    name: "list_messages",
    description: "Paginate a room's message history using the (beforeCreatedAt, beforeId) cursor returned by the previous page.",
    inputSchema: {
      type: "object",
      properties: {
        roomId: { type: "string" },
        inviteToken: { type: "string" },
        limit: { type: "integer", minimum: 1, maximum: LIMITS.HISTORY_PAGE_MAX },
        beforeCreatedAt: { type: "string" },
        beforeId: { type: "string" }
      },
      required: ["roomId", "inviteToken"]
    }
  },
  {
    name: "send_message",
    description: "Send a text message as a participant you already hold a participantId + sessionToken for.",
    inputSchema: {
      type: "object",
      properties: {
        roomId: { type: "string" },
        participantId: { type: "string" },
        sessionToken: { type: "string" },
        body: { type: "string", maxLength: LIMITS.MESSAGE_BODY_MAX }
      },
      required: ["roomId", "participantId", "sessionToken", "body"]
    }
  }
];

function toolError(message) {
  return { content: [{ type: "text", text: message }], isError: true };
}

function toolResult(data) {
  return { content: [{ type: "text", text: JSON.stringify(data) }] };
}

async function callTool(env, name, args) {
  switch (name) {
    case "create_chat": {
      const created = await createRoom(env, args?.title);
      if (!created) return toolError("Room creation failed.");
      const out = { chatId: created.room.id, title: created.room.title, inviteToken: created.inviteToken };

      if (args?.participantName) {
        const joined = await createParticipant(env, created.room.id, args.participantName);
        if (!joined.error) {
          out.participantId = joined.participant.id;
          out.sessionToken = joined.sessionToken;
        }
      }
      return toolResult(out);
    }

    case "create_invite": {
      if (!isUuid(args?.roomId)) return toolError("Invalid roomId.");
      if (!(await verifyInvite(env, args.roomId, args.inviteToken))) return toolError("Invalid invite.");
      return toolResult({ inviteToken: await createInvite(env, args.roomId) });
    }

    case "get_chat": {
      if (!isUuid(args?.roomId)) return toolError("Invalid roomId.");
      if (!(await verifyInvite(env, args.roomId, args.inviteToken))) return toolError("Invalid invite.");
      const room = await getRoomSummary(env, args.roomId);
      const participants = await listParticipants(env, args.roomId);
      const { messages, hasMore, cursor } = await listMessages(env, args.roomId, {});
      return toolResult({ chat: room, participants, messages: withDisplayNames(messages, participants), hasMore, cursor });
    }

    case "list_messages": {
      if (!isUuid(args?.roomId)) return toolError("Invalid roomId.");
      if (!(await verifyInvite(env, args.roomId, args.inviteToken))) return toolError("Invalid invite.");
      const participants = await listParticipants(env, args.roomId);
      const page = await listMessages(env, args.roomId, {
        beforeCreatedAt: args.beforeCreatedAt, beforeId: args.beforeId, limit: args.limit
      });
      return toolResult({ ...page, messages: withDisplayNames(page.messages, participants) });
    }

    case "send_message": {
      if (!isUuid(args?.roomId)) return toolError("Invalid roomId.");
      const authed = await authenticateParticipant(env, args.roomId, args?.participantId, args?.sessionToken);
      if (!authed) return toolError("Not authenticated for this room/participant.");
      const body = cleanMessage(args?.body);
      if (!body) return toolError("Message body is empty.");

      const result = await roomStub(env, args.roomId)
        .fetch(`https://room/send-message?roomId=${encodeURIComponent(args.roomId)}`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ participantId: authed.id, body })
        })
        .then(r => r.json());

      if (!result.ok) return toolError(`Message could not be sent (${result.code || "unknown error"}).`);
      return toolResult({ message: result.message });
    }

    default:
      return toolError(`Unknown tool: ${name}`);
  }
}

const rpcResult = (id, result) => ({ jsonrpc: "2.0", id, result });
const rpcError = (id, code, message) => ({ jsonrpc: "2.0", id, error: { code, message } });

export async function handleMcpRequest(request, env) {
  // Rate-limited by IP before the key check even runs, so this endpoint
  // cannot be used to hammer MCP_API_KEY guesses (infeasible regardless,
  // given a full random token, but this also caps abuse from a single
  // source once authenticated).
  const rl = await rateLimit(env, "mcp", clientIp(request), 60, 60_000);
  if (!rl.allowed) {
    return Response.json(rpcError(null, -32003, "Rate limited."), { status: 429, headers: { "retry-after": String(Math.ceil(rl.retryAfterMs / 1000)) } });
  }

  const configuredKey = String(env.MCP_API_KEY || "");
  if (!configuredKey) {
    return Response.json(rpcError(null, -32000, "MCP is not configured on this deployment."), { status: 503 });
  }

  const provided = (request.headers.get("Authorization") || "").match(/^Bearer\s+(.+)$/i)?.[1] || "";
  if (provided !== configuredKey) {
    return Response.json(rpcError(null, -32001, "Unauthorized."), { status: 401 });
  }

  let body;
  try {
    body = await request.json();
  } catch {
    return Response.json(rpcError(null, -32700, "Parse error."), { status: 400 });
  }

  const { id = null, method, params = {} } = body || {};

  if (method === "initialize") {
    return Response.json(rpcResult(id, {
      protocolVersion: PROTOCOL_VERSION,
      capabilities: { tools: {} },
      serverInfo: { name: "gorgona-chat", version: "1.0.0" }
    }));
  }

  if (method === "tools/list") {
    return Response.json(rpcResult(id, { tools: TOOLS }));
  }

  if (method === "tools/call") {
    const name = params?.name;
    if (!TOOLS.some(t => t.name === name)) {
      return Response.json(rpcError(id, -32602, `Unknown tool: ${name}`), { status: 400 });
    }
    try {
      const result = await callTool(env, name, params?.arguments || {});
      return Response.json(rpcResult(id, result));
    } catch (error) {
      console.error("MCP tool call failed", { tool: name, message: error?.message });
      return Response.json(rpcResult(id, toolError("Internal error while executing the tool.")));
    }
  }

  if (method === "notifications/initialized" || method === "ping") {
    return Response.json(rpcResult(id, {}));
  }

  return Response.json(rpcError(id, -32601, `Method not found: ${method}`), { status: 400 });
}
