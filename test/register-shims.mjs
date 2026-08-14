// Loaded via `node --import ./test/register-shims.mjs --test`.
// Registers an ESM resolve hook (test/loader.mjs) that redirects the
// virtual "cloudflare:workers" specifier to a local shim, so Durable
// Object classes can be imported and unit tested under plain Node. See
// test/shims/cloudflare-workers.mjs for what the shim actually provides.
import { register } from "node:module";

register("./loader.mjs", import.meta.url);
