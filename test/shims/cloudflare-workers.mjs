// Test-only stand-in for the real "cloudflare:workers" built-in module,
// which only exists inside the actual Workers runtime. Registered via
// test/register-shims.mjs (module.register) so `import { DurableObject }
// from "cloudflare:workers"` resolves under plain Node for unit tests.
//
// This mirrors only the one thing chat-room.js/rate-limiter.js actually
// use from it: a base class that stashes ctx/env. Everything else those
// classes touch (this.ctx.storage, this.ctx.getWebSockets, ...) comes
// from the fake `ctx` the tests construct themselves (see
// test/helpers/fake-durable-object.mjs), not from this shim.
export class DurableObject {
  constructor(ctx, env) {
    this.ctx = ctx;
    this.env = env;
  }
}
