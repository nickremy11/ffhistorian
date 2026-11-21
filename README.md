# FF Historian — the landing page and The Record Book

- **`home/`** → **ffhistorian.com**: the site landing page (tool cards) and `/getting-started/`.
  Deployed to the `ffhistorian` Pages project. `home/_redirects` sends every old record-book URL
  (`/ncfl`, `/l/{id}`, `/league/*`…) to recordbook.ffhistorian.com.
- **`pages/` + `worker/`** → **recordbook.ffhistorian.com**: The Record Book. ONE Worker serves the
  pages as static assets (`[assets]` in `worker/wrangler.toml`, `_redirects` included) and the API,
  on a custom domain. `ffhistorian.com/api/*` still routes to it for old callers.
- Styling comes from League Assist's `shared-styles.css` (Game-Day Programme, dark mode too).

---

## Repo Structure

```
ffhistorian/
├── pages/                   # Cloudflare Pages (static HTML)
│   ├── index.html           # Record Book landing: search (live filter), grid/list, your leagues
│   ├── league/
│   │   ├── leagues.js       # THE league list: ids, branding, format, merges
│   │   ├── league.js        # the shared league page (all tabs, all logic)
│   │   └── league.css       # its styles
│   ├── {slug}/index.html    # one per league — identical stubs, never edited
│   ├── eliteffl/            # Elite FFL — its own bespoke page
│   ├── recap.js             # Recap tab (shared)
│   └── assets/              # logos
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

## Shared league framework

Every standard league page is the same code. `pages/{slug}/index.html` is an identical
stub that loads `/league/leagues.js` + `/league/league.js`; the script reads the slug from
the URL and renders that league from its `LEAGUES` entry. A change to `league.js` or
`league.css` changes every league at once. Elite FFL keeps its own page.

What varies per league lives in its entry (documented at the top of `leagues.js`):
`platform` (`sleeper` / `espn` — ESPN comes Sleeper-shaped from the worker, so the page
doesn't care), `format` (`dynasty` → FantasyCalc trade market; `redraft` → in-league PPG),
season and draft ids, `hasDivisions`, `ownershipMerges`, `teamNameAliases`.

Tables fit the screen with no sideways scroll: a table fills the normal 1100px page column
and only grows past it when its columns don't fit there — up to the full screen width,
never wider. Text scales with the viewport, and on narrow screens the least important
standings columns drop out (`tier: "sec"` under 900px, `"ter"` under 560px in the
`cols` list in `renderStandings`).

## Any Sleeper league — `/l/{leagueId}`

The same league page, for any Sleeper league, with no `leagues.js` entry. `pages/l/index.html`
is the stub and `_redirects` rewrites every `/l/:id` to it; `league.js` sees the `/l/` path and
asks the worker for a config instead of looking in `LEAGUES`.

- **Config from Sleeper** (`worker/src/history.js`, `GET /api/history/config/{id}`): any season's
  league id works. Seasons come from walking `previous_league_id` back and finding the renewal
  forward (a member's leagues next season whose `previous_league_id` is ours); draft ids per season
  (a dynasty's first-season draft of 11+ rounds is a startup and left out); dynasty = `settings.type`
  2; divisions = `settings.divisions`. Checked against every curated Sleeper entry: seasons, format
  and divisions all match.
- **Takeovers are linked, not merged** (`franchiseLinks`, dynasty only): a roster_id that gets a
  new owner links to that roster's LAST real owner, even across seasons it sat ownerless. Only a
  clean hand-over: the new owner never owned/co-owned a roster here before, and the old owner holds
  no other roster that season. Both owners keep separate records; Standings tags them "↩ took over from X '24"
  / "↪ X took over '24". Redraft leagues get none — a redraft roster is emptied every year.
  (Curated leagues still use hand-written `ownershipMerges`, which DO merge.)
- **Sign-in to open, public to view.** The first open of a league needs an account (the helper's
  `sh_session` cookie, checked against the shared `sleeper-helper-db` D1 — the `DB` binding). That
  registers it in KV (`hist:cfg:{rootId}`, `hist:alias:{seasonId}`, no ttl; `rootId` = oldest
  season's id) and after that the link works for anyone. The link shown and copied uses the
  **newest** season's id (`shareId`), so it follows the league when it renews; every older
  season's id keeps resolving, so last year's link still opens it.
  The config is re-read from Sleeper every 6h in season / 24h off, by any visitor; a failed
  rebuild keeps the last good one.
- **`*` marks current members** on Standings (every league page, curated too): owners or co-owners
  of a roster in the newest season.
- **A curated league always wins**: any of its season ids on `/l/` redirects to `/{slug}/`.
- **Landing page**: paste a league id or sleeper.com link; signed in, "Your Sleeper leagues"
  (`GET /api/history/mine`, from the account's Sleeper username, one card per league chain).
- Generated pages show **🔗 Copy share link**. No logos/aliases beyond what Sleeper has (league avatar).

## Day-of trade values — daily FantasyCalc snapshots

A cron (`[triggers]` in `worker/wrangler.toml`, 11:15 UTC) saves FantasyCalc's dynasty values to
R2 as `fc-snapshots/YYYY-MM-DD.json` (~5 KB/day, ~2 MB/year). A trade is frozen from the snapshot
of its own day, or the closest one up to 3 days before. A trade with no snapshot that close (from
before snapshots began) gets **no** day-of value rather than a wrong one, and stays open to a later
backfill; a trade from the last 3 days with no snapshot yet uses the live values. Trades before
2026-07-01 still come from the DynastyProcess backfill script. Run a snapshot by hand locally with
`wrangler dev --test-scheduled` and `curl "localhost:8787/__scheduled"`.

## Adding a New League

1. Add an entry to `pages/league/leagues.js` (the landing card comes from it)
2. Drop the logo in `pages/assets/`
3. Copy any league's `index.html` into `pages/{slug}/` — every copy is identical
4. ESPN only: register the league in `ESPN_LEAGUES` in `worker/src/index.js`
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

## Carolina Sickos

Dynasty league (`/sickos`). Started on Sleeper in 2026 — no earlier seasons exist.

| Season | League ID |
|---|---|
| 2026 | 1350954271008358400 (startup draft 1350954272145027072) |

---

## ESPN leagues on the standard template (`/wolfpack`, `/standrews`)

Wolfpack of 10 (ESPN `1656310`) and St. Andrew's Partments (ESPN `845744`), 2018 →. These use
the standard (Sleeper) redraft page, not the Elite FFL page: the worker serves each ESPN season
in Sleeper's shape under `/api/league/espn_{espnId}_{season}/…` (`handleEspnLeague`, the
"ESPN → SLEEPER ADAPTER" block in `worker/src/index.js`). To add another ESPN league, register it
in `ESPN_LEAGUES`, copy `pages/wolfpack/index.html` and change `LEAGUE_CONFIG`.

- Owners are ESPN member ids, shown as first + last name; rosters are ESPN team ids; players `e{espnId}`.
- **Consolation games don't count**: only regular-season and winners-bracket games become matchups.
  3rd place comes from ESPN's final rank.
- Wolfpack's 2018–2020 playoff rounds were two-week matchups: one game for W/L, kept out of the
  single-game score records (`weeks` on the matchup row).
- St. Andrew's 2018–2020 only exist via ESPN's `leagueHistory` (the cookie owner wasn't a member):
  no player box scores (no PPG chips) and no trades for those years (`tradesFrom: 2021`).
- Past seasons are stored once in R2 (`espn/{key}/core-{season}.json`, `pp-{season}-{week}.json`);
  the current season refreshes on the KV ttl. Needs the same `ESPN_S2`/`ESPN_SWID` secrets.

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

## Consolation games don't count

On every standard league page, a playoff week's game counts only if it's on the championship
path: a winners-bracket match with no placement tag or `p: 1`. 3rd/5th-place games and the losers
bracket keep their rows (player points still feed PPG) but get `matchup_id = null` in
`fetchAllSeasons`, so H2H, all-play and League Records skip them. Standings W/L/PF come from
roster settings (regular season only) and were never affected. Elite FFL already skipped them.

---

## Recap tab (`pages/recap.js`)

Every league page has a **📰 Recap** tab: playoff picture, still in the hunt, eliminated, and
(dynasty only) the projected next-season draft order. One shared file — `league/league.js` adds the
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
