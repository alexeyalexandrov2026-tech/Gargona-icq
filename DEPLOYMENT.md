# Gorgona Chat deployment checklist

## 1. Supabase
Run:
`supabase/migrations/0001_gorgona_chat.sql`

Create a server-side Supabase secret key and keep it private.

## 2. Cloudflare local
```bash
npm install
copy .dev.vars.example .dev.vars
npm run dev
```

## 3. Cloudflare production
```bash
npx wrangler secret put SUPABASE_URL
npx wrangler secret put SUPABASE_SECRET_KEY
npm run deploy
```

## 4. Custom domain
Cloudflare Dashboard → Workers & Pages → gorgona-chat → Settings / Domains & Routes → add the chosen chat subdomain.

Suggested:
`chat.gorgona-one.com`

## 5. Two-browser test
Browser A:
- open the public URL
- Create Chat
- enter a name

Browser B:
- open the invite URL
- enter a different name

Then send messages in both directions.

## 6. Production gate
Before public launch:
- add account auth
- rotate/revoke invites
- rate-limit room creation and messages
- add abuse/moderation controls
- add file storage/scanning
- add privacy/retention policy
- add security headers/CSP
- add monitoring
- connect the MCP server only after the web chat passes the two-browser test.
