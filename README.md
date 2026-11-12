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

## Eastbound FFL League IDs

Redraft league (`/eastbound`). Draft IDs are set per season so pre/in-draft
pick trades resolve to the drafted player in the Trade History tab.

| Season | League ID | Draft ID |
|---|---|---|
| 2024 | 1115108446031994880 | 1115108446912880640 |
| 2025 | 1257452259906695168 | 1257452259906695169 |
| 2026 | 1387115849936035840 | 1387115849948606464 (pre-draft) |

---

## NCFL League IDs

| Season | Sleeper ID |
|---|---|
| 2022 | 834179031011287040 |
| 2023 | 917118347102236672 |
| 2024 | 1050188337924902912 |
| 2025 | 1180232430068178944 |
| 2026 | 1312218053051678720 (no data yet) |

---

## Elite FFL (ESPN) — live current season

Past seasons are served from the R2 archive (`espn/eliteffl/{year}.json`, written by
`scripts/migrate_espn_to_r2.py`). The **current** season (Sep–Jul, derived from the date)
is fetched live from ESPN by the worker, cached 1h in KV, and snapshotted to R2. Trade
History comes from `/api/espn/eliteffl/trades/{year}` (2018+; past seasons are built once
and kept in R2 as `trades-{year}.json`).

The league is private, so the worker needs a member's cookies (refresh when they expire):

```bash
cd worker
npx wrangler secret put ESPN_S2
npx wrangler secret put ESPN_SWID   # include the braces: {XXXXXXXX-...}
```

Without them the page falls back to the last R2 snapshot.

---

## Recap tab (`pages/recap.js`)

Every league page has a **📰 Recap** tab: playoff picture, still in the hunt, eliminated, and
(dynasty only) the projected next-season draft order. One shared file — each page only adds the
tab, the `#recapContent` panel and an `rcOpen(...)` call in `switchTab`.

- **Playoff %** is sleeper-helper's own engine (`shared-utils.js` + `league-engine.js`, loaded
  from helper.ffhistorian.com on first open — bump `RC_ENGINE_V` with helper's `?v=` stamp).
  Simulated from banked weeks with Sleeper weekly projections (`/api/projections/:season/:week`).
- **Clinched / eliminated** are mathematical and conservative (a possible tie on record counts as
  passable). Sleeper divisions don't affect qualification (top N by record every season
  2021–2025); ESPN's do — division winners are seeded first — and the ESPN rules account for it.
- **Draft order**: playoff teams pick last in reverse of finish (seed until the bracket decides
  it); everyone else by Max PF, lowest first. Traded picks from `/api/league/:id/traded_picks`.
- **ESPN** (Elite FFL) reads `/api/espn/eliteffl/recap/:season` (settings + rosters + schedule;
  needs the `ESPN_S2`/`ESPN_SWID` secrets) and prices rosters with Sleeper projections by name.
