// ════════════════════════════════════════════════════════════════════════════
// History for ANY Sleeper league — /api/history/*
//
// A league page needs a LEAGUES-shaped config (pages/league/leagues.js). Every
// field of it can be read from Sleeper given one league id:
//   seasons      walk previous_league_id back; forward through a member's leagues
//   draftIds     league.draft_id per season (a dynasty startup draft is left out)
//   format       settings.type === 2 → dynasty, else redraft
//   hasDivisions settings.divisions
//   takeovers    a roster_id that changes owner between seasons, where the old
//                owner has left and the new one wasn't there before (franchiseLinks)
//
// Opening a league for the FIRST time needs a signed-in account (sh_session, the
// helper's cookie on .ffhistorian.com, checked against the shared D1). After that
// the league is registered and its /l/{id} link works for anyone, no login. The
// link uses the NEWEST season's id (what Sleeper shows today) and moves on renewal;
// every older season's id keeps resolving, so a link shared last year still works.
//
// KV (FF_CACHE), no ttl:
//   hist:alias:{anySeasonId} → rootId      (rootId = the oldest season's league id)
//   hist:cfg:{rootId}        → { builtAt, config }
// ════════════════════════════════════════════════════════════════════════════

const SLEEPER = "https://api.sleeper.app/v1";
const ID_RE = /^\d{6,25}$/;
const FRESH_MS_IN_SEASON  = 6 * 60 * 60 * 1000;   // re-read the chain every 6h in season
const FRESH_MS_OFFSEASON  = 24 * 60 * 60 * 1000;
const STARTUP_MIN_ROUNDS  = 11;                    // a >10-round draft is a startup

function json(obj, status = 200, extra = {}) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store", ...extra },
  });
}

function nflSeason(d = new Date()) {
  return d.getUTCMonth() < 7 ? d.getUTCFullYear() - 1 : d.getUTCFullYear();
}
function inSeason(d = new Date()) {
  const m = d.getUTCMonth();
  return m >= 8 || m === 0;
}

async function sleeper(path) {
  const r = await fetch(SLEEPER + path, { headers: { "User-Agent": "ffhistorian/1.0" } });
  if (!r.ok) return null;
  const t = await r.text();
  if (!t || t === "null") return null;
  try { return JSON.parse(t); } catch { return null; }
}

// ── Auth (same lookup as my-ranks: helper owns sign-in, we only read sessions) ──
export async function getAuthUser(request, env) {
  if (!env.DB) return null;
  const m = (request.headers.get("Cookie") || "").match(/(?:^|;\s*)sh_session=([^;]+)/);
  if (!m) return null;
  const row = await env.DB.prepare(
    `SELECT s.user_id, s.expires_at, u.email, u.sleeper_username
       FROM sessions s JOIN users u ON s.user_id = u.id WHERE s.id = ?`
  ).bind(m[1]).first();
  if (!row || row.expires_at < Date.now()) return null;
  return row;
}

// ── The season chain ─────────────────────────────────────────────────────────
// Back via previous_league_id; forward by finding the league (in a later season)
// whose previous_league_id is our newest one, listed under one of its members.
export async function readChain(startId) {
  const byId = {};
  const start = await sleeper(`/league/${startId}`);
  if (!start || start.sport !== "nfl") return null;
  byId[start.league_id] = start;

  let cur = start;
  for (let i = 0; i < 25 && cur.previous_league_id && cur.previous_league_id !== "0"; i++) {
    const prev = await sleeper(`/league/${cur.previous_league_id}`);
    if (!prev || byId[prev.league_id]) break;
    byId[prev.league_id] = prev;
    cur = prev;
  }

  let newest = start;
  const lastSeason = nflSeason() + 1;
  while (Number(newest.season) < lastSeason) {
    const next = await findRenewal(newest);
    if (!next || byId[next.league_id]) break;
    byId[next.league_id] = next;
    newest = next;
  }

  const leagues = Object.values(byId).sort((a, b) => Number(a.season) - Number(b.season));
  // Two leagues for one season would mean a broken chain — keep the later-found one out
  const seen = new Set();
  return leagues.filter(l => (seen.has(l.season) ? false : seen.add(l.season)));
}

async function findRenewal(lg) {
  const users = await sleeper(`/league/${lg.league_id}/users`);
  if (!Array.isArray(users)) return null;
  const season = Number(lg.season) + 1;
  // Three members is plenty: a renewal keeps (nearly) everyone
  for (const u of users.slice(0, 3)) {
    const list = await sleeper(`/user/${u.user_id}/leagues/nfl/${season}`);
    const hit = Array.isArray(list) && list.find(l => l.previous_league_id === lg.league_id);
    if (hit) return hit;
  }
  return null;
}

// ── Owner changes on one roster → franchiseLinks ─────────────────────────────
// A roster_id that gets a new owner is a takeover of that roster's LAST real owner —
// even when the roster sat ownerless for a season or more in between (an orphan
// nobody picked up straight away). Only a clean hand-over counts: the new owner
// never owned or co-owned a roster here before, and the old owner holds no other
// roster that season (a swap between existing owners is left alone). The owners
// stay SEPARATE in every record — the page only labels the link.
export function deriveTakeovers(seasons) {
  // seasons: [{ season, rosters }] oldest first
  const links = [];
  const lastOwner = {};          // roster_id → most recent non-empty owner
  const everIn = new Set();      // anyone who owned/co-owned a roster in an earlier season
  for (const s of seasons) {
    if (!Array.isArray(s.rosters)) continue;
    const ownersNow = new Set(s.rosters.flatMap(r => [r.owner_id, ...(r.co_owners || [])]).filter(Boolean));
    for (const r of s.rosters) {
      const o = r.owner_id, prev = lastOwner[r.roster_id];
      if (o && prev && o !== prev && !everIn.has(o) && !ownersNow.has(prev)) {
        links.push({ from: prev, to: o, season: s.season });
      }
    }
    for (const r of s.rosters) if (r.owner_id) lastOwner[r.roster_id] = r.owner_id;
    ownersNow.forEach(u => everIn.add(u));
  }
  return links;
}

function splitTitle(name) {
  const words = String(name || "League").trim().split(/\s+/);
  return words.length > 1 ? [words.slice(0, -1).join(" "), words.at(-1)] : [words[0], ""];
}

// ── Build the LEAGUES-shaped config ──────────────────────────────────────────
export async function buildConfig(startId) {
  const chain = await readChain(startId);
  if (!chain || !chain.length) return null;

  const details = await Promise.all(chain.map(async lg => {
    const [rosters, users, drafts] = await Promise.all([
      sleeper(`/league/${lg.league_id}/rosters`),
      sleeper(`/league/${lg.league_id}/users`),
      lg.draft_id ? sleeper(`/league/${lg.league_id}/drafts`) : null,
    ]);
    const draft = Array.isArray(drafts) ? drafts.find(d => d.draft_id === lg.draft_id) : null;
    return { lg, season: String(lg.season), rosters, users, draft };
  }));

  const newest = chain.at(-1);
  const dynasty = Number(newest.settings?.type) === 2;
  const seasons = {}, draftIds = {};
  details.forEach((d, i) => {
    seasons[d.season] = d.lg.league_id;
    if (!d.lg.draft_id) return;
    // A dynasty's first Sleeper season usually opens with a startup draft, which the
    // trade-history pick resolver isn't built for. Rounds tell it apart.
    const rounds = Number(d.draft?.settings?.rounds) || 0;
    if (dynasty && i === 0 && rounds >= STARTUP_MIN_ROUNDS) return;
    draftIds[d.season] = d.lg.draft_id;
  });

  const name = newest.name || "League";
  return {
    slug: `l/${chain[0].league_id}`,
    id: chain[0].league_id,            // storage key — never changes
    shareId: newest.league_id,         // the link shown/copied: this season's Sleeper id
    name,
    title: name,
    cardName: name,
    h1: splitTitle(name),
    logo: newest.avatar ? `https://sleepercdn.com/avatars/${newest.avatar}` : "",
    emoji: "🏈",
    platform: "sleeper",
    format: dynasty ? "dynasty" : "redraft",
    seasons,
    draftIds,
    hasDivisions: details.some(d => Number(d.lg.settings?.divisions) > 1),
    ownershipMerges: [],
    // Dynasty only: a redraft roster is emptied every year, so a new manager in an
    // old roster slot hasn't taken anyone's team over.
    franchiseLinks: dynasty
      ? deriveTakeovers(details.map(d => ({ season: d.season, rosters: d.rosters })))
      : [],
    generated: true,
  };
}

async function storeConfig(env, cfg) {
  const rec = { builtAt: Date.now(), config: cfg };
  await env.FF_CACHE.put(`hist:cfg:${cfg.id}`, JSON.stringify(rec));
  await Promise.all(Object.values(cfg.seasons).map(lid =>
    env.FF_CACHE.put(`hist:alias:${lid}`, cfg.id)));
  return rec;
}

// GET /api/history/config/{anySeasonLeagueId}
async function handleConfig(request, env, id) {
  if (!ID_RE.test(id)) return json({ error: "That isn't a Sleeper league id." }, 400);

  const rootId = await env.FF_CACHE.get(`hist:alias:${id}`);
  const raw = rootId && await env.FF_CACHE.get(`hist:cfg:${rootId}`);
  let rec = null;
  try { rec = raw ? JSON.parse(raw) : null; } catch { rec = null; }

  if (!rec) {
    // Never opened before: only an account may make the worker read a new league.
    const user = await getAuthUser(request, env);
    if (!user) return json({ error: "Sign in to open a league for the first time.", needsSignIn: true }, 401);
    const cfg = await buildConfig(id);
    if (!cfg) return json({ error: "Sleeper has no NFL league with that id." }, 404);
    rec = await storeConfig(env, cfg);
    return json(rec.config);
  }

  const maxAge = inSeason() ? FRESH_MS_IN_SEASON : FRESH_MS_OFFSEASON;
  if (Date.now() - rec.builtAt > maxAge) {
    // Registered already, so anyone's visit may refresh it (new season, renewal).
    // A failed rebuild keeps serving the last good config.
    try {
      const cfg = await buildConfig(rec.config.seasons[Object.keys(rec.config.seasons).sort().at(-1)]);
      if (cfg) {
        // Keep the original root id even if the chain now reaches further back
        if (cfg.id !== rec.config.id) { cfg.id = rec.config.id; cfg.slug = rec.config.slug; }
        rec = await storeConfig(env, cfg);
      }
    } catch { /* stale is fine */ }
  }
  return json(rec.config);
}

// GET /api/history/mine — the signed-in user's Sleeper leagues, one per chain
async function handleMine(request, env) {
  const user = await getAuthUser(request, env);
  if (!user) return json({ error: "Not signed in", needsSignIn: true }, 401);
  if (!user.sleeper_username) return json({ leagues: [], noUsername: true });

  const su = await sleeper(`/user/${encodeURIComponent(user.sleeper_username)}`);
  if (!su?.user_id) return json({ leagues: [], badUsername: user.sleeper_username });

  const s = nflSeason();
  const [cur, next] = await Promise.all([
    sleeper(`/user/${su.user_id}/leagues/nfl/${s}`),
    sleeper(`/user/${su.user_id}/leagues/nfl/${s + 1}`),
  ]);
  const all = [...(Array.isArray(next) ? next : []), ...(Array.isArray(cur) ? cur : [])];
  // A renewal already listed for next season stands for its previous league
  const renewed = new Set(all.map(l => l.previous_league_id).filter(Boolean));
  const leagues = all
    .filter(l => !renewed.has(l.league_id))
    .map(l => ({
      league_id: l.league_id,
      previous_league_id: l.previous_league_id || null,
      name: l.name,
      season: l.season,
      avatar: l.avatar || null,
      teams: l.total_rosters,
      dynasty: Number(l.settings?.type) === 2,
      best_ball: Number(l.settings?.best_ball) === 1,
    }));
  const opened = await Promise.all(leagues.map(l => env.FF_CACHE.get(`hist:alias:${l.league_id}`)));
  leagues.forEach((l, i) => { l.opened = !!opened[i]; });
  return json({ leagues, username: user.sleeper_username });
}

export async function handleHistory(request, env, path) {
  if (request.method !== "GET") return json({ error: "Method not allowed" }, 405);
  const seg = path.replace("/api/history/", "").split("/");
  try {
    if (seg[0] === "config" && seg[1]) return await handleConfig(request, env, seg[1]);
    if (seg[0] === "mine") return await handleMine(request, env);
  } catch (e) {
    return json({ error: e.message }, 500);
  }
  return json({ error: "Not found" }, 404);
}
