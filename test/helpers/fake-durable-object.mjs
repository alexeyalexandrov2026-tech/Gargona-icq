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

// A macrotask yield, not just a microtask one: this is what actually
// forces two "concurrent" calls into a worst-case interleaving in tests
// (a bare `await` on an already-resolved value keeps callers in
// lockstep and can hide a race that real, variable-latency I/O would
// expose). Only used by the fake -- src/chat-room.js itself has no
// artificial delays.
function macrotaskYield() {
  return new Promise(resolve => setTimeout(resolve, 0));
}

export function createFakeCtx() {
  const store = new Map();
  const socketsByTag = new Map();
  let alarmTime = null;

  const storage = {
    async get(key) {
      await macrotaskYield();
      return store.has(key) ? clone(store.get(key)) : undefined;
    },
    async put(keyOrEntries, value) {
      await macrotaskYield();
      if (typeof keyOrEntries === "string") {
        store.set(keyOrEntries, clone(value));
        return;
      }
      for (const [k, v] of Object.entries(keyOrEntries)) store.set(k, clone(v));
    },
    async delete(key) {
      await macrotaskYield();
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

  // Models the one guarantee that matters for the tests: calls to
  // blockConcurrencyWhile on the same ctx run strictly one-at-a-time,
  // in call order, even if the callbacks interleave at their own await
  // points. This is what lets test/chat-room.test.mjs actually prove the
  // single-use ticket/pairing-code race is closed, instead of just
  // trusting a no-op stand-in.
  let concurrencyChain = Promise.resolve();
  function blockConcurrencyWhile(fn) {
    const result = concurrencyChain.then(fn, fn);
    concurrencyChain = result.then(() => {}, () => {});
    return result;
  }

  const ctx = {
    storage,
    blockConcurrencyWhile,
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
