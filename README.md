# GORGONA CHAT

Production-oriented web chat for the Gorgona ecosystem.

## Product

- browser-only, no app install
- unique private invite links
- multiple participants
- realtime messaging
- online presence
- typing indicator
- persistent message history
- mobile-first UI
- Cloudflare Worker + Durable Objects
- Supabase Postgres persistence
- ready for a custom domain
- MCP/ChatGPT can be added without changing the web client

## Architecture

Browser
→ Cloudflare Worker
→ Durable Object per room for realtime WebSockets
→ Supabase Postgres for durable data

Durable Objects are used only for live room coordination. Important data is persisted in Supabase.

## Local development

Requirements: Node.js 20+.

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

## Supabase

1. Open Supabase SQL Editor.
2. Run `supabase/migrations/0001_gorgona_chat.sql`.
3. Copy the Project URL.
4. Create a server-side secret key (`sb_secret_...`) in Supabase.
5. Put it only in `.dev.vars` locally or as a Cloudflare Worker secret in production.

Never expose `SUPABASE_SECRET_KEY` to browser code.

The schema deliberately denies direct client table access. The Worker is the trusted API boundary.

## Cloudflare production

Set the secret:

```bash
npx wrangler secret put SUPABASE_URL
npx wrangler secret put SUPABASE_SECRET_KEY
```

Deploy:

```bash
npm run deploy
```

Then attach the custom domain to the Worker in Cloudflare.

## Invite URLs

A room URL looks like:

`https://chat.example.com/c/<roomId>?invite=<inviteToken>`

The invite token is a high-entropy bearer credential. It is never stored in a public table exposed to the browser.

## Security before broad public launch

This MVP has room-level bearer invites. Before opening it to an unrestricted public audience, add:

- authenticated accounts / OAuth
- invite rotation and revocation UI
- rate limits
- message abuse controls
- file scanning
- moderation
- audit logs
- CSP and security headers
- origin restrictions
- CSRF protections for non-idempotent HTTP endpoints
- privacy/retention policy

## ChatGPT / MCP

The web product is independent of ChatGPT.

A separate MCP server should expose narrowly scoped tools such as:

- `create_chat`
- `get_chat`
- `list_messages`
- `send_message`
- `create_invite`

For hosted ChatGPT, the MCP endpoint must be publicly reachable over HTTPS and authenticated. A private `localhost` endpoint is not directly reachable by hosted ChatGPT.

Do not put an OpenAI API key into the browser.
