# Gorgona Chat — Deployment Checklist

## 1. Supabase (one time)
- Create project
- Run `supabase/migrations/0001_gorgona_chat.sql` in SQL Editor
- Copy Project URL + create secret key (`sb_secret_...`)

## 2. Local
```bash
npm install
cp .dev.vars.example .dev.vars
# edit .dev.vars with real values
npm run dev
```

## 3. Two-browser test
Must succeed before production:
- Create room in browser A
- Open invite in browser B with different name
- Messages + presence + typing work both ways

## 4. Production
```bash
npx wrangler secret put SUPABASE_URL
npx wrangler secret put SUPABASE_SECRET_KEY
npm run deploy
```

## 5. Custom domain
Cloudflare Dashboard → Workers → gorgona-chat → Domains & Routes  
Suggested: `chat.gorgona-one.com`

## 6. Before public launch
- Add authentication
- Rate limiting
- Invite revocation
- Moderation / abuse controls
- Security headers / CSP
