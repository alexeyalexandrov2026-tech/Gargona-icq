// A small in-memory stand-in for the Durable Object `ctx` surface that
// src/chat-room.js and src/rate-limiter.js actually use:
//   ctx.storage.{get,put,delete,list,getAlarm,setAlarm}
//   ctx.acceptWebSocket(socket, tags)
//   ctx.getWebSockets(tag)
//
// This is intentionally NOT a full Miniflare/workerd emulation -- it is
// just enough to exercise the actual authorization/state-machine logic
// (who can approve a join, is a ticket single-use, does the admin survive
// a "restart", ...) deterministically and fast, without needing a real
// Cloudflare account or network access. `WebSocket.OPEN`/`WebSocket.CLOSED`
// are real Node globals (Node ships a spec-compliant WebSocket global),
// so readyState comparisons in the code under test work unmodified.

export function createFakeCtx() {
  const store = new Map();
  const socketsByTag = new Map();
  let alarmTime = null;

  const storage = {
    async get(key) {
      return store.has(key) ? clone(store.get(key)) : undefined;
    },
    async put(keyOrEntries, value) {
      if (typeof keyOrEntries === "string") {
        store.set(keyOrEntries, clone(value));
        return;
      }
      for (const [k, v] of Object.entries(keyOrEntries)) store.set(k, clone(v));
    },
    async delete(key) {
      return store.delete(key);
    },
    async list({ prefix = "" } = {}) {
      const result = new Map();
      for (const [k, v] of store) {
        if (k.startsWith(prefix)) result.set(k, clone(v));
      }
      return result;
    },
    async getAlarm() {
      return alarmTime;
    },
    async setAlarm(time) {
      alarmTime = time;
    }
  };

  function tag(name, socket) {
    if (!socketsByTag.has(name)) socketsByTag.set(name, new Set());
    socketsByTag.get(name).add(socket);
  }

  const ctx = {
    storage,
    acceptWebSocket(socket, tags = []) {
      for (const t of tags) tag(t, socket);
    },
    getWebSockets(tagName) {
      return [...(socketsByTag.get(tagName) || [])];
    },
    // Test helper, not part of the real DO ctx surface: simulates a
    // client connecting and being tagged the way handleWebSocketUpgrade
    // tags real sockets (`room:<roomId>`, `participant:<id>`).
    connectFakeSocket(tags) {
      const socket = {
        readyState: WebSocket.OPEN,
        sent: [],
        send(data) { socket.sent.push(JSON.parse(data)); },
        close() { socket.readyState = WebSocket.CLOSED; }
      };
      for (const t of tags) tag(t, socket);
      return socket;
    },
    get pendingAlarm() {
      return alarmTime;
    }
  };

  return ctx;
}

function clone(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}
