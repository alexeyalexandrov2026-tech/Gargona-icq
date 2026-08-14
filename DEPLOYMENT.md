# Gorgona Chat deployment checklist

## 0. Install, check, test (do this first, every time)

```bash
npm ci
npm run check        # wrangler types -- validates wrangler.jsonc + generates types
npm test             # syntax check + the full unit/integration test suite
npm run build:check  # wrangler deploy --dry-run -- catches bundling/binding
                      # mistakes (missing import, wrong binding name, a
                      # named environment silently missing bindings) before
                      # they reach a real deploy
```

None of these three touch a real Supabase project or Cloudflare account --
they are fully self-contained (see
`test/` and the "Automated tests" section below).

## 1. Supabase

Run, in order, in the Supabase SQL Editor:

```
supabase/migrations/0001_gorgona_chat.sql
supabase/migrations/0002_media_support.sql
supabase/migrations/0003_participant_sessions.sql
supabase/migrations/0004_message_body_limit.sql
```

Create a server-side Supabase secret key (`sb_secret_...`) and keep it
private -- it goes into `.dev.vars` locally and a Cloudflare Worker secret
in production, never into `wrangler.jsonc`, Git, logs, or any API
response.

## 2. R2 bucket (one-time, before the first deploy)

```bash
npx wrangler r2 bucket create gargona-icq-media
```

The name must match `r2_buckets[0].bucket_name` in `wrangler.jsonc`.
Photo/video-note uploads (`POST /api/chats/:roomId/media`) will return
`503 MEDIA_NOT_CONFIGURED` until this exists and the binding resolves.

## 3. Cloudflare local

```bash
npm install
cp .dev.vars.example .dev.vars   # fill in SUPABASE_URL / SUPABASE_SECRET_KEY
npm run dev
```

`wrangler dev` provisions local emulations of the Durable Objects and R2
bucket automatically from `wrangler.jsonc` -- no extra local setup needed
for those.

## 4. Cloudflare production

```bash
npx wrangler secret put SUPABASE_URL
npx wrangler secret put SUPABASE_SECRET_KEY
npx wrangler secret put MCP_API_KEY     # optional, only if you want /mcp usable
npm run deploy
```

`wrangler.jsonc` has a single, top-level environment -- do not deploy
with `--env production` (or any other named environment) unless you first
give that environment its own complete `vars`/`durable_objects`/`r2_buckets`
block. Wrangler does not inherit those from the top level into a named
environment; verify with:

```bash
npx wrangler deploy --dry-run --env <name>
```

and confirm the printed binding list actually includes `CHAT_ROOMS`,
`RATE_LIMITER`, `MEDIA_BUCKET`, and the vars -- not just `ASSETS`.

## 5. Custom domain

Cloudflare Dashboard -> Workers & Pages -> gargona-icq -> Settings /
Domains & Routes -> add the chosen chat subdomain.

## 6. Manual walkthrough before calling it done

Automated tests (see below) cover the authorization logic in isolation.
They do not replace actually clicking through the app once against a real
deployment. At minimum:

**Scenario A -- create, join, refresh**
- Browser A: open the public URL, "Create Chat", enter a name.
- Send a message, refresh the page: the message and your identity
  persist (you reconnect using the stored session token, not by creating
  a new participant).

**Scenario B -- admin approval**
- Browser B: open A's invite URL, enter a different name, submit.
  Expect a "waiting for admin" screen, *not* immediate entry -- this is
  the join-ticket flow, and it is now enforced server-side, not just in
  the UI.
- Browser A: an "admin_join_request" prompt appears; click Approve.
- Browser B: joins automatically once approved; both directions of
  messaging work.
- Repeat, but click Decline instead: Browser B sees a decline notice and
  does **not** get a participant record (verify by trying to send a
  message -- there should be none to send from, since Browser B never
  completed joining).

**Scenario C -- impersonation is actually blocked**
- With Browser B already joined, open its devtools and try connecting a
  new WebSocket to `/api/rooms/<roomId>/ws` using Browser A's
  `participantId` (visible in any of A's messages) but without A's real
  session token. Expect the upgrade to be refused (403) rather than
  succeeding.

**Scenario D -- cross-room isolation**
- Create a second room (Browser A, "Create Chat" again). Confirm neither
  room's invite token, participant list, nor messages are reachable using
  the other room's roomId/invite combination.

**Scenario E -- large/invalid payloads are rejected cleanly**
- Try sending a message body over 4000 characters, an unsupported media
  content type, and a media file over 8&nbsp;MB. Expect clean `4xx`
  responses with the `{error:{code,message}}` shape, not a crash or a
  silently truncated/corrupted send.

## 7. Automated tests

```bash
npm test
```

Runs `test:syntax` (`node --check` over every source file) then
`test:unit` (98 tests at the time of writing, across `test/*.test.mjs`)
via Node's built-in test runner. No new dependencies were added to run
these -- Durable Object classes are tested directly using a small ESM
loader shim for the virtual `cloudflare:workers` module plus an in-memory
fake for the parts of the DO `ctx` they actually touch (storage, WebSocket
tagging); Supabase-backed functions are tested by swapping the global
`fetch`. See the file-by-file breakdown in the test-suite commit message
or just read `test/*.test.mjs` -- each file's `describe()` blocks name the
specific behavior (and, where relevant, which audit finding) they cover.

This is unit/integration coverage of the server-side authorization logic,
not a browser-driven E2E suite -- do the manual walkthrough in step 6 too.

## 8. Production gate

Before public launch, on top of everything already enforced by this
codebase (server-side admin authorization, join-ticket approval,
per-participant session credentials, rate limiting, security headers, a
real MCP auth gate), still consider:

- account auth / OAuth (this MVP is still invite-link based identity)
- invite rotation/revocation UI (`chat_invites.revoked_at` exists in the
  schema; nothing sets it yet)
- content moderation / abuse reporting
- file scanning for uploaded media
- a privacy/retention policy
- monitoring/alerting on the Worker and Supabase project
- connect the MCP server only after the manual walkthrough above passes
