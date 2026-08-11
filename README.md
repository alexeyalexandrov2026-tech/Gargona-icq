# Gorgona Chat (Production Ready)

Private invite-link web chat built for Cloudflare.

**Architecture**
```
Browser  →  Cloudflare Worker  →  Durable Object (realtime WebSockets)
                              ↘  Supabase Postgres (persistent data)
```

## What works

- Create private rooms with unique invite links
- Multiple participants
- Realtime messaging (WebSocket)
- Online presence + typing indicator
- Message history
- Mobile-first UI
- Fully serverless on Cloudflare Workers + Durable Objects
- Supabase as the only database

## Critical fixes already applied

1. Durable Object now correctly handles internal `/presence` notifications when a user joins.
2. Frontend updates the participants list live when someone joins.

## Requirements

- Node.js 20+
- Cloudflare account
- Supabase project (free tier is enough)

## 1. Supabase setup (do this once)

1. Create a project at https://supabase.com
2. Open **SQL Editor** → paste and run the file:
   `supabase/migrations/0001_gorgona_chat.sql`
3. Project Settings → API:
   - Copy **Project URL**
   - Create a **secret key** (`sb_secret_...`) — keep it private forever

## 2. Local development

```bash
npm install
cp .dev.vars.example .dev.vars
```

Edit `.dev.vars`:

```
SUPABASE_URL=https://YOUR_PROJECT.supabase.co
SUPABASE_SECRET_KEY=sb_secret_YOUR_KEY
```

Start:

```bash
npm run dev
```

Open the URL shown by Wrangler (normally http://localhost:8787).

### Two-browser test (must pass)

- Browser A → Create room → copy invite link
- Browser B → open invite link → enter different name
- Send messages both ways
- Check presence + typing indicators

## 3. Production deploy

```bash
npx wrangler secret put SUPABASE_URL
npx wrangler secret put SUPABASE_SECRET_KEY
npm run deploy
```

Then attach a custom domain in Cloudflare Dashboard  
(Workers → gorgona-chat → Domains & Routes).

Suggested domain: `chat.gorgona-one.com`

## Security notes

- Invite tokens are high-entropy and stored only as SHA-256 hashes.
- Browser never receives the Supabase secret key.
- Row Level Security is enabled and direct client access is revoked.
- The Worker is the only trusted boundary.

Before opening to the unrestricted public, add:
- Account authentication / OAuth
- Invite rotation & revocation
- Rate limiting
- Abuse / moderation controls
- CSP + security headers

## MCP / ChatGPT

The web chat is independent.  
A separate authenticated MCP endpoint can be added later without changing the frontend.

## Scripts

| Command            | Purpose                    |
|--------------------|----------------------------|
| `npm run dev`      | Local development          |
| `npm run deploy`   | Deploy to Cloudflare       |
| `npm run test:syntax` | Quick JS syntax check   |

---

Built for the Gorgona ecosystem. Ready for production use after the two-browser test passes.
