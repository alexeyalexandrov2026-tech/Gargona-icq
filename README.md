# GORGONA CHAT

Production-oriented web chat for the Gorgona ecosystem.

## Product

- browser-only, no app install
- unique private invite links, with server-enforced admin approval for
  every participant after the room's creator
- realtime messaging, online presence, typing indicator
- persistent, paginated message history
- photo and video-note attachments (stored in Cloudflare R2, not embedded
  in the database)
- GPS-stamped photos when the browser actually has a location -- never a
  fabricated one
- one-to-one/group WebRTC video calls
- mobile-first UI
- Cloudflare Worker + Durable Objects + R2
- Supabase Postgres persistence
- a real (not placeholder) MCP endpoint for programmatic access
- ready for a custom domain

## Architecture

```
Browser
  -> Cloudflare Worker (src/index.mjs)         HTTP API, routing, CORS,
                                                security headers, rate
                                                limit checks, auth checks
       -> ChatRoom Durable Object (per room)    realtime WebSocket
          (src/chat-room.js)                    fan-out, join-approval
                                                 state machine, admin
                                                 identity, per-participant
                                                 rate limiting
       -> RateLimiter Durable Object            per-IP fixed-window
          (src/rate-limiter.js)                 counters (room creation,
                                                 joins, ws connects,
                                                 uploads, pairing codes,
                                                 MCP calls)
       -> R2 bucket (MEDIA_BUCKET)               photo / video-note blobs
       -> Supabase Postgres (REST/PostgREST)     rooms, invites,
                                                 participants, messages
```

A separate signaling path rides the same WebSocket connection:

```
Browser A <-- webrtc_offer/answer/ice, routed by the DO to the named
Browser B     target's own socket only, never broadcast to the room
```

And MCP is just another authenticated route on the same Worker, reusing
the same room-authorization module the web client uses:

```
MCP client --Bearer MCP_API_KEY--> POST /mcp --> src/mcp.js --> src/rooms.js / src/auth.js
```

## Authorization model

Nothing here is decided by the client. Specifically:

- **Room access** is a bearer invite token. Only its SHA-256 hash is
  stored (`chat_invites.token_hash`); the raw token is never written to
  the database.
- **Participant identity** is a per-participant session token, generated
  once when a participant row is created and returned to the client
  exactly once. Only its hash is stored
  (`chat_participants.session_token_hash`). Every WebSocket connection
  and every media upload must present the matching session token --
  holding the room's invite alone is not enough to act "as" a specific
  participant. This is what stops one participant from impersonating
  another.
- **Admin identity** is always "the participant with the earliest
  `created_at` in this room", derived from Supabase and cached inside the
  room's Durable Object. It is never taken from anything the client
  claims (there is no client-trusted `isAdmin` flag anymore), and it
  survives the Durable Object being evicted/restarted, because it is
  re-derived from Supabase rather than kept only in memory.
- **Joining a room beyond its first (creator) participant** requires a
  single-use, short-lived ticket minted by the room's real admin via the
  `approve_join` WebSocket message. `POST /api/chats/:roomId/participants`
  rejects the request outright (`403 APPROVAL_REQUIRED`) if no valid
  ticket is presented once the room already has a participant. A plain
  POST with just the invite token can no longer skip approval.

See `src/auth.js` for the two functions everything above funnels through:
`verifyInvite()` and `authenticateParticipant()`.

## Local development

Requirements: Node.js 20+ (developed against 22).

```bash
npm install
cp .dev.vars.example .dev.vars
npm run dev
```

Open the URL printed by Wrangler, normally:

`http://localhost:8787`

The same app can be opened from another device on the same LAN if Wrangler is started with:

```bash
npx wrangler dev --ip 0.0.0.0
```

Media uploads and the phone-pairing QR feature need `MEDIA_BUCKET` to be
usable locally too; `wrangler dev` provisions a local R2 emulation
automatically from the `r2_buckets` binding in `wrangler.jsonc`, so no
extra setup is needed for local dev.

## Supabase

Run these migrations, in order, in the Supabase SQL Editor:

1. `supabase/migrations/0001_gorgona_chat.sql` -- base schema (rooms,
   invites, participants, messages), RLS enabled with all grants revoked
   from `anon`/`authenticated` (the Worker is the only trusted caller,
   using the secret key).
2. `supabase/migrations/0002_media_support.sql` -- historical: temporarily
   widened the message body limit to fit embedded base64 media. Kept for
   history; superseded by 0004.
3. `supabase/migrations/0003_participant_sessions.sql` -- adds
   `chat_participants.session_token_hash`, the per-participant credential
   described above.
4. `supabase/migrations/0004_message_body_limit.sql` -- restores the
   message body limit to 4000 characters now that photos/videos are
   referenced (a small JSON pointer), not embedded.

Then:

- Copy the Project URL into `SUPABASE_URL`.
- Create a server-side secret key (`sb_secret_...`) in Supabase and put it
  only in `.dev.vars` locally, or as a Cloudflare Worker secret in
  production. **Never** put it in `wrangler.jsonc`'s `vars`, in Git, or in
  any API/MCP response.

The schema denies direct client table access; the Worker is the trusted
API boundary, matching the comments already in `0001_gorgona_chat.sql`.

## R2 (media storage)

Photos and video notes are uploaded through an authenticated Worker
endpoint and stored in R2 as `<roomId>/<participantId>/<uuid>.<ext>`; a
chat message only ever carries a small JSON reference to that object, not
the binary itself. Before the **first** deploy, create the bucket once:

```bash
npx wrangler r2 bucket create gargona-icq-media
```

(The name must match `r2_buckets[0].bucket_name` in `wrangler.jsonc` if
you rename it.)

## Cloudflare production

Set the secrets:

```bash
npx wrangler secret put SUPABASE_URL
npx wrangler secret put SUPABASE_SECRET_KEY
npx wrangler secret put MCP_API_KEY   # optional -- only needed to use /mcp
```

Deploy:

```bash
npm run deploy
```

Then attach the custom domain to the Worker in Cloudflare.

There is intentionally only one environment in `wrangler.jsonc` (no
`env.production` block). A previous version had one, but Wrangler does
not inherit top-level `vars`/`durable_objects`/`r2_buckets` into named
environments, and nothing in this repo's deploy path ever passed `--env`
-- so that block was silent, broken configuration rather than a real
second environment. If you genuinely need a second environment (e.g. a
staging Worker with its own Supabase project), give it its own complete
binding set rather than assuming inheritance; verify with
`wrangler deploy --dry-run --env <name>` that every binding listed under
"Your Worker has access to the following bindings" is the one you expect.

## Invite URLs

A room URL looks like:

`https://chat.example.com/c/<roomId>?invite=<inviteToken>`

The invite token is a high-entropy bearer credential, hashed at rest.
Internal API calls the web client makes (fetching room data, opening the
WebSocket) send this token via an `Authorization` header or a WebSocket
`Sec-WebSocket-Protocol` entry rather than a URL query string wherever the
browser API allows it, which keeps it out of browser history and Referer
headers for those specific requests. The shareable room URL itself still
has to carry the token in the URL, because it is a plain link someone
pastes/clicks -- there is no way around that without a larger redesign
(e.g. exchanging the link-token for a separate long-lived credential on
first open). Treat these links the same way you would a password reset
link: private, short-lived in practice, not something to paste into public
channels or logs.

The phone-camera QR code does **not** encode this token. It mints a
separate, single-use, 2-minute pairing code server-side and only sends
`https://<your-domain>/p/<roomId>/<code>` to the third-party QR-rendering
API (`api.qrserver.com`); scanning it redirects (after consuming the code
exactly once) to the real invite URL. If you need zero third-party
network calls for the QR image itself, replace that one `<img src>` in
`public/app.js`'s `phoneCameraBtn` handler with a locally-rendered QR
code -- the pairing-code endpoint (`POST /api/chats/:roomId/pairing-code`)
already does the hard part (never leaking the real invite) independently
of how the image gets drawn.

## Rate limiting

Backed by a small Durable Object (`src/rate-limiter.js`), fixed-window,
per client IP (`CF-Connecting-IP`):

| Bucket | Limit |
|---|---|
| room creation | 10 / 10 min |
| join attempts | 20 / 10 min |
| WebSocket connects | 30 / 1 min |
| media uploads | 20 / 10 min |
| pairing-code mints | 10 / 10 min |
| MCP calls | 60 / 1 min |

Inside a room, `ChatRoom` also rate-limits per participant: a strict
budget (20 / 10s) for anything that hits the database or is
security-sensitive (`message`, `join_request`, `approve_join`,
`decline_join`), and a separate, more generous burst budget (60 / 10s)
for `typing` and WebRTC signaling, which legitimately fire far more
often (every keystroke; a burst of ICE candidates on call setup).

These numbers are reasonable starting points, not load-tested production
tuning -- adjust the constants in `src/security.js` (`LIMITS`) and the
call sites in `src/index.mjs` if real traffic patterns call for it.

## CORS and security headers

`corsHeaders()` (`src/security.js`) reflects `Access-Control-Allow-Origin`
only for same-origin requests or an origin explicitly listed in the
`ALLOWED_ORIGINS` Worker var (comma-separated); everything else gets no
CORS header at all rather than a reflected arbitrary origin. Leave
`ALLOWED_ORIGINS` empty unless another site legitimately needs to call
this API cross-origin.

Every response (including static assets) also gets a fixed set of
security headers: `Content-Security-Policy`, `Strict-Transport-Security`,
`X-Content-Type-Options: nosniff`, `X-Frame-Options: DENY`,
`Referrer-Policy: no-referrer`, and a `Permissions-Policy` that only
allows camera/microphone/geolocation for the app's own origin. See
`securityHeaders()` in `src/security.js`.

## Message history pagination

`GET /api/chats/:roomId` returns the most recent page (default 50,
max 100 -- see `LIMITS.HISTORY_PAGE_DEFAULT`/`HISTORY_PAGE_MAX`) plus
`hasMore` and a `cursor` (`{beforeCreatedAt, beforeId}`). Fetch older
messages with `?before=<cursor.beforeCreatedAt>&beforeId=<cursor.beforeId>`.
The compound cursor (timestamp + id, both descending) keeps pages stable
even when two messages share the same microsecond-resolution timestamp.

## ChatGPT / MCP

`POST /mcp` is a real, working, minimal MCP endpoint (JSON-RPC 2.0 over
plain HTTP responses -- no SSE streaming, which is valid for tools that
are simple request/response and not long-running). It requires
`Authorization: Bearer <MCP_API_KEY>`; with no `MCP_API_KEY` secret
configured, the endpoint fails closed with `503` rather than silently
accepting unauthenticated calls.

Tools (see `src/mcp.js` for exact schemas):

- `create_chat` -- creates a room + invite; optionally also creates a
  first participant (e.g. for a bot identity) and returns its
  `participantId`/`sessionToken`.
- `create_invite` -- mints an additional invite for a room you already
  hold a valid invite to.
- `get_chat` -- room summary + participants + latest message page.
- `list_messages` -- paginated history, same cursor shape as the HTTP API.
- `send_message` -- requires a `participantId` + `sessionToken` (from
  `create_chat` or a prior join); goes through the exact same
  persist-and-broadcast path a live WebSocket message does, so connected
  browser clients see it in real time.

MCP never references `SUPABASE_SECRET_KEY` and never returns it; room
operations still require a valid invite token exactly like the web
client, so MCP is not a bypass around room authorization. This is a
minimal, hand-rolled JSON-RPC transport rather than the official MCP SDK
-- validate it against whatever MCP client/connector you plan to use
(especially anything expecting the full Streamable HTTP spec with SSE)
before relying on it for a hosted integration.

## Known limitations / before a fully public launch

This MVP still has room-level bearer invites rather than accounts. Before
opening it to a fully public, adversarial audience, consider adding:

- authenticated accounts / OAuth (removes the "link = identity" trust
  model entirely)
- invite rotation/revocation UI (the schema already supports
  `revoked_at`; there is no UI or endpoint to set it yet)
- content moderation / abuse reporting
- file scanning for uploaded media
- audit logs
- a privacy/retention policy and a way to delete a room's data
- browser-side end-to-end automated tests (this repo's test suite is
  unit/integration-level against the security-critical server logic --
  see `test/`; the manual two/three-browser walkthrough in
  `DEPLOYMENT.md` is still the closest thing to an E2E check)
- self-hosted QR rendering if zero third-party network calls is a hard
  requirement (see the Invite URLs section above)

Do not put an OpenAI API key, `SUPABASE_SECRET_KEY`, or `MCP_API_KEY` into
the browser bundle.
