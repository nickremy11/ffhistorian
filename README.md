# FF Historian

Fantasy football historical records site for Sleeper leagues, built on Cloudflare Pages + Workers.

🌐 **Live site:** https://ffhistorian.com

---

## Repo Structure

```
ffhistorian/
├── pages/                   # Cloudflare Pages (static HTML)
│   ├── index.html           # Landing page
│   ├── ncfl/
│   │   └── index.html       # NCFL sub-page
│   ├── assets/
│   │   └── ncfl_logo.png    # Drop your logo here
│   └── _redirects
│
├── worker/                  # Cloudflare Worker (API cache)
│   ├── src/index.js
│   └── wrangler.toml
│
└── .github/workflows/
    └── deploy.yml           # Auto-deploys on push to main
```

---

## First-Time Setup

### 1. Create KV Namespaces (run once in terminal)

```bash
cd worker
npx wrangler kv:namespace create FF_CACHE
npx wrangler kv:namespace create FF_CACHE --preview
```

Paste the returned IDs into `worker/wrangler.toml`.

### 2. Add GitHub Secrets

Repo → Settings → Secrets → Actions:

| Secret | Where to find it |
|---|---|
| `CLOUDFLARE_API_TOKEN` | Cloudflare → My Profile → API Tokens (use "Edit Cloudflare Workers" template + add Pages permission) |
| `CLOUDFLARE_ACCOUNT_ID` | Cloudflare dashboard right sidebar |

### 3. Create Cloudflare Pages Project

Cloudflare → Pages → Create project → Connect to Git → this repo.
- **Build output directory:** `pages`
- **Build command:** _(leave blank)_

### 4. Push to deploy

```bash
git add .
git commit -m "initial deploy"
git push origin main
```

---

## Adding a New League

1. Copy `pages/ncfl/index.html` → `pages/[leaguename]/index.html`
2. Update `LEAGUE_CONFIG` with the new Sleeper IDs
3. Add the league card to `pages/index.html`
4. Drop the logo in `pages/assets/`
5. Push

---

## NCFL League IDs

| Season | Sleeper ID |
|---|---|
| 2022 | 834179031011287040 |
| 2023 | 917118347102236672 |
| 2024 | 1050188337924902912 |
| 2025 | 1180232430068178944 |
| 2026 | 1312218053051678720 (no data yet) |
