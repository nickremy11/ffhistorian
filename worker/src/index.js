/**
 * FF Historian — Cloudflare Worker
 * Caches Sleeper API responses in KV to avoid rate limits.
 * Routes:  /api/league/:leagueId/rosters
 *          /api/league/:leagueId/users
 *          /api/league/:leagueId/winners_bracket
 *          /api/league/:leagueId/matchups/:week
 *          /api/league/:leagueId/transactions/:week
 *          /api/league/:leagueId/trades   ← aggregates all trade transactions
 *          /api/league/:leagueId/traded_picks
 *          /api/projections/:season/:week ← Sleeper weekly projections (Recap tab)
 *          /api/espn/:key/recap/:season   ← ESPN settings + rosters + schedule (Recap tab)
 */

const SLEEPER_BASE = "https://api.sleeper.app/v1";

// Cache TTL in seconds
const TTL_ACTIVE_SEASON = 60 * 60;        // 1 hour  (in-season)
const TTL_OFFSEASON     = 60 * 60 * 24;   // 24 hours (off-season)

// NFL fantasy season in progress: September through January (playoffs end early Jan).
// Derived from the date so nothing needs bumping each year.
function isInSeason(d = new Date()) {
  const m = d.getUTCMonth(); // 0 = Jan
  return m >= 8 || m === 0;
}

// The NFL season year: Jan–Jul belong to the previous season.
function currentSeason(d = new Date()) {
  return d.getUTCMonth() < 7 ? d.getUTCFullYear() - 1 : d.getUTCFullYear();
}

function getTTL() {
  return isInSeason() ? TTL_ACTIVE_SEASON : TTL_OFFSEASON;
}

// ── TRADE MARKET (FantasyCalc "then vs now") ─────────────────────────────────
// Day-of trade values. Trades on/after FC_CUTOFF freeze live FantasyCalc values
// (lazily, on first read); earlier trades are backfilled from DynastyProcess by
// scripts/backfill_trade_values.py. Both write the same trade-values/{lid}.json
// shape into R2 (ESPN_DATA bucket).
const FC_URL       = "https://api.fantasycalc.com/values/current?isDynasty=true&numQbs=2&ppr=1&includePickValues=true";
const FC_CACHE_KEY = "fc_values";
const FC_TTL       = 60 * 60 * 24;                       // 24h
const FC_CUTOFF_MS = Date.parse("2026-07-01T00:00:00Z"); // FC on/after, DP before

// Fetch + parse FantasyCalc into { players: {sleeperId: value}, picks: {year_round[_q]: value} }
async function getFcMaps(env) {
  let raw = await env.FF_CACHE.get(FC_CACHE_KEY);
  if (!raw) {
    const res = await fetch(FC_URL, { headers: { "User-Agent": "ffhistorian/1.0" } });
    if (!res.ok) return null;
    raw = await res.text();
    await env.FF_CACHE.put(FC_CACHE_KEY, raw, { expirationTtl: FC_TTL });
  }
  let arr;
  try { arr = JSON.parse(raw); } catch { return null; }

  const players = {};
  const picks   = {};
  for (const item of arr) {
    const sid = item.player?.sleeperId || item.player?.maybeSleeperID;
    const pos = (item.player?.position || "").toUpperCase();
    const isPick = pos === "PI" || pos === "PICK" || !sid || String(sid) === "0";
    if (!isPick) { players[String(sid)] = item.value; continue; }

    const name = (item.player?.name || "").toLowerCase();
    const ym = name.match(/20(\d\d)/);
    if (!ym) continue;
    const year = "20" + ym[1];
    let round = 0;
    if      (/\b1(st)?\b/.test(name) || /first/.test(name))  round = 1;
    else if (/\b2(nd)?\b/.test(name) || /second/.test(name)) round = 2;
    else if (/\b3(rd)?\b/.test(name) || /third/.test(name))  round = 3;
    else if (/\b4(th)?\b/.test(name) || /fourth/.test(name)) round = 4;
    else if (/\b5(th)?\b/.test(name) || /fifth/.test(name))  round = 5;
    else if (/\b6(th)?\b/.test(name) || /sixth/.test(name))  round = 6;
    if (!round) continue;
    let q = "mid";
    if (/early/.test(name)) q = "early";
    else if (/late/.test(name)) q = "late";
    picks[`${year}_${round}_${q}`] = item.value;
    if (!picks[`${year}_${round}`] || item.value > picks[`${year}_${round}`]) {
      picks[`${year}_${round}`] = item.value;
    }
  }
  return { players, picks };
}

// Generic (slot-unknown) pick value — used at freeze time before a draft happens
function genericPickValue(season, round, picks) {
  if (round > 6) return 0;
  return picks[`${season}_${round}_mid`]
      || picks[`${season}_${round}`]
      || picks[`${season}_${round}_early`]
      || 0;
}

// Aggregate completed trades for a league (KV-cached, shared by /trades + /trade-values)
async function fetchAllTrades(env, leagueId, ttl) {
  const cacheKey = `trades:${leagueId}`;
  const cached = await env.FF_CACHE.get(cacheKey);
  if (cached) { try { return JSON.parse(cached); } catch { /* refetch below */ } }

  const weekFetches = Array.from({ length: 18 }, (_, i) =>
    fetch(`${SLEEPER_BASE}/league/${leagueId}/transactions/${i + 1}`)
      .then(r => (r.ok ? r.json() : []))
      .catch(() => [])
  );
  const allWeeks = await Promise.all(weekFetches);
  const trades = allWeeks.flat().filter(tx => tx.type === "trade" && tx.status === "complete");
  await env.FF_CACHE.put(cacheKey, JSON.stringify(trades), { expirationTtl: ttl });
  return trades;
}

async function fetchWithCache(env, cacheKey, url, ttl) {
  // 1. Try KV cache first
  const cached = await env.FF_CACHE.get(cacheKey);
  if (cached) {
    return new Response(cached, {
      headers: {
        "Content-Type": "application/json",
        "X-Cache": "HIT",
        "Access-Control-Allow-Origin": "*",
      },
    });
  }

  // 2. Fetch from Sleeper
  const sleeperRes = await fetch(url);
  if (!sleeperRes.ok) {
    return new Response(
      JSON.stringify({ error: `Sleeper API error: ${sleeperRes.status}` }),
      { status: sleeperRes.status, headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" } }
    );
  }

  const body = await sleeperRes.text();

  // 3. Store in KV with TTL
  await env.FF_CACHE.put(cacheKey, body, { expirationTtl: ttl });

  return new Response(body, {
    headers: {
      "Content-Type": "application/json",
      "X-Cache": "MISS",
      "Access-Control-Allow-Origin": "*",
    },
  });
}

// ── ESPN (live current season) ───────────────────────────────────────────────
// Private leagues need the league member's cookies:
//   wrangler secret put ESPN_S2
//   wrangler secret put ESPN_SWID
// Past seasons are served from the R2 archive (scripts/migrate_espn_to_r2.py).
const ESPN_LEAGUES = {
  eliteffl:  { id: 330437,  tradesFrom: 2018 }, // transactions aren't kept for leagueHistory years
  // Standard-template ESPN leagues — served Sleeper-shaped under /api/league/espn_{id}_{season}/…
  // (see ESPN → SLEEPER ADAPTER below). Seasons before tradesFrom only exist via leagueHistory.
  wolfpack:  { id: 1656310, tradesFrom: 2018 },
  standrews: { id: 845744,  tradesFrom: 2021 },
};
const ESPN_BASE = "https://lm-api-reads.fantasy.espn.com/apis/v3/games/ffl";
const ESPN_POS  = { 1: "QB", 2: "RB", 3: "WR", 4: "TE", 5: "K", 16: "D/ST" };

function espnJson(obj, status = 200, maxAge = 0) {
  const headers = { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" };
  if (maxAge) headers["Cache-Control"] = `public, max-age=${maxAge}`;
  return new Response(typeof obj === "string" ? obj : JSON.stringify(obj), { status, headers });
}

async function espnFetch(env, url) {
  if (!env.ESPN_S2 || !env.ESPN_SWID) throw new Error("ESPN cookies not configured");
  const res = await fetch(url, {
    headers: {
      Cookie: `espn_s2=${env.ESPN_S2}; SWID=${env.ESPN_SWID}`,
      Accept: "application/json",
      "User-Agent": "Mozilla/5.0",
    },
  });
  if (!res.ok) throw new Error(`ESPN ${res.status}`);
  return res.json();
}

// Same shape the R2 archive stores, so the page reads live and archived seasons alike.
async function getEspnLiveSeason(env, key, league, season) {
  const kvKey = `espn:${key}:${season}`;
  const cached = await env.FF_CACHE.get(kvKey);
  if (cached) { try { return JSON.parse(cached); } catch { /* refetch */ } }
  try {
    const d = await espnFetch(env,
      `${ESPN_BASE}/seasons/${season}/segments/0/leagues/${league.id}?view=mTeam&view=mMatchupScore&view=mStatus`);
    if (!Array.isArray(d.teams) || !d.teams.length) return null;
    const data = {
      seasonId: season,
      members:  d.members  || [],
      teams:    d.teams,
      schedule: d.schedule || [],
      status:   d.status   || {},
    };
    const body = JSON.stringify(data);
    await env.FF_CACHE.put(kvKey, body, { expirationTtl: getTTL() });
    // Snapshot so the season survives expired cookies, and stays archived once it ends
    await env.ESPN_DATA.put(`espn/${key}/${season}.json`, body, {
      httpMetadata: { contentType: "application/json" },
    }).catch(() => {});
    return data;
  } catch (e) {
    console.warn(`ESPN live ${key} ${season}:`, e.message);
    return null;
  }
}

// Everything the Recap tab needs for one ESPN season, in one KV-cached read: the
// settings that define the playoffs (playoff team count, regular-season length),
// scoring + lineup slots (for projected scores), every roster (player names, matched
// to Sleeper ids on the page), team records / ESPN's own current seeds, and the
// schedule. Rosters are trimmed to {name, pos, proTeamId} so the cached value stays small.
async function getEspnRecap(env, key, league, season) {
  const kvKey = `espnrecap:${key}:${season}`;
  const cached = await env.FF_CACHE.get(kvKey);
  if (cached) { try { return JSON.parse(cached); } catch { /* refetch */ } }
  try {
    const d = await espnFetch(env, `${ESPN_BASE}/seasons/${season}/segments/0/leagues/${league.id}`
      + "?view=mSettings&view=mTeam&view=mRoster&view=mMatchupScore&view=mStatus");
    if (!Array.isArray(d.teams) || !d.teams.length) return null;
    const st = d.settings || {};
    const data = {
      seasonId: season,
      settings: {
        scheduleSettings: st.scheduleSettings || {},
        scoringSettings:  { scoringItems: st.scoringSettings?.scoringItems || [] },
        rosterSettings:   { lineupSlotCounts: st.rosterSettings?.lineupSlotCounts || {} },
      },
      status:   d.status || {},
      members:  d.members || [],
      schedule: d.schedule || [],
      teams: d.teams.map(t => ({
        id: t.id, name: t.name || [t.location, t.nickname].filter(Boolean).join(" "),
        primaryOwner: t.primaryOwner, owners: t.owners || [],
        divisionId: t.divisionId, playoffSeed: t.playoffSeed,
        record: t.record || {},
        roster: (t.roster?.entries || []).map(e => {
          const p = e.playerPoolEntry?.player || e.playerPoolEntry?.playerPoolEntry?.player || {};
          return { name: p.fullName, pos: p.defaultPositionId, proTeamId: p.proTeamId };
        }).filter(p => p.name),
      })),
    };
    await env.FF_CACHE.put(kvKey, JSON.stringify(data), { expirationTtl: getTTL() });
    return data;
  } catch (e) {
    console.warn(`ESPN recap ${key} ${season}:`, e.message);
    return null;
  }
}

// Completed trades for one season → [{ id, season, week, date, teams:[teamId], items:[{playerId,
// name, pos, from, to, type}] }]. type is "TRADE" or "DROP" (a roster-space drop made with it).
// Past seasons are built once and kept in R2; the current season refreshes on the KV ttl.
async function getEspnTrades(env, key, league, season) {
  if (season < league.tradesFrom) return [];
  const live  = season >= currentSeason();
  // v2: adds trades rebuilt from weekly rosters (ESPN hides other teams' trades) — the v1
  // files only hold the cookie owner's own trades, so they're ignored rather than reused.
  const r2Key = `espn/${key}/trades-v2-${season}.json`;
  const kvKey = `espntrades:${key}:${season}`;

  if (live) {
    const cached = await env.FF_CACHE.get(kvKey);
    if (cached) { try { return JSON.parse(cached); } catch { /* rebuild */ } }
  } else {
    const obj = await env.ESPN_DATA.get(r2Key);
    if (obj) { try { return JSON.parse(await obj.text()); } catch { /* rebuild */ } }
  }

  let trades;
  try {
    trades = await buildEspnTrades(env, league, season);
  } catch (e) {
    // No cookies / ESPN down — serve the last snapshot rather than nothing (v1 = own trades only)
    for (const k of [r2Key, `espn/${key}/trades-${season}.json`]) {
      const obj = await env.ESPN_DATA.get(k);
      if (obj) { try { return JSON.parse(await obj.text()); } catch {} }
    }
    throw e;
  }
  const body = JSON.stringify(trades);
  if (live) await env.FF_CACHE.put(kvKey, body, { expirationTtl: getTTL() });
  await env.ESPN_DATA.put(r2Key, body, { httpMetadata: { contentType: "application/json" } }).catch(() => {});
  return trades;
}

async function buildEspnTrades(env, league, season) {
  // mTransactions2 only returns the scoring period asked for, so walk them all.
  // Period 0 is the preseason (draft-day / offseason trades).
  const base = `${ESPN_BASE}/seasons/${season}/segments/0/leagues/${league.id}?view=mTransactions2&scoringPeriodId=`;
  const periods = await Promise.all(Array.from({ length: 19 }, (_, p) =>
    espnFetch(env, base + p).then(d => d.transactions || []).catch(e => {
      if (p === 0) throw e; // first call failing = auth problem, surface it
      return [];
    })
  ));
  const byId = new Map();
  periods.flat().forEach(tx => byId.set(tx.id, tx));
  const txs = [...byId.values()];

  // A trade is a chain sharing relatedTransactionId (PROPOSAL → ACCEPT → UPHOLD | VETO).
  const vetoed = new Set(txs.filter(t => t.type === "TRADE_VETO").map(t => t.relatedTransactionId));
  const upheld = new Set(txs.filter(t => t.type === "TRADE_UPHOLD").map(t => t.relatedTransactionId));
  const proposals = new Map(txs.filter(t => t.type === "TRADE_PROPOSAL").map(t => [t.id, t]));

  const out = new Map(); // relatedTransactionId → trade
  for (const t of txs) {
    if (t.type !== "TRADE_ACCEPT" || t.status !== "EXECUTED" || !(t.items || []).length) continue;
    const rel = t.relatedTransactionId || t.id;
    if (vetoed.has(rel)) continue;
    out.set(rel, t);
  }
  // Upheld trades whose executed ACCEPT ESPN didn't return — fall back to the proposal's items
  for (const rel of upheld) {
    if (out.has(rel) || vetoed.has(rel)) continue;
    const p = proposals.get(rel);
    if (p && (p.items || []).length) out.set(rel, p);
  }

  const trades = [...out.entries()].map(([rel, t]) => {
    const items = (t.items || [])
      .filter(i => i.type === "TRADE" || i.type === "DROP")
      .map(i => ({ playerId: i.playerId, from: i.fromTeamId, to: i.toTeamId, type: i.type }));
    const teams = [...new Set(items.filter(i => i.type === "TRADE").flatMap(i => [i.from, i.to]))];
    return {
      id: rel, season,
      week: t.scoringPeriodId || 0,
      date: t.processDate || t.acceptedDate || t.proposedDate || null,
      teams, items,
    };
  }).filter(t => t.teams.length >= 2);

  trades.push(...await rosterTrades(env, league, season, txs, trades).catch(e => {
    console.warn(`roster trades ${season}:`, e.message);
    return [];
  }));

  // Names — the public players endpoint, no cookies needed
  const ids = [...new Set(trades.flatMap(t => t.items.map(i => i.playerId)))];
  if (ids.length) {
    try {
      const res = await fetch(`${ESPN_BASE}/seasons/${season}/players?view=players_wl`, {
        headers: { "X-Fantasy-Filter": JSON.stringify({ filterIds: { value: ids } }), Accept: "application/json" },
      });
      const players = res.ok ? await res.json() : [];
      const byPid = new Map(players.map(p => [p.id, p]));
      trades.forEach(t => t.items.forEach(i => {
        const p = byPid.get(i.playerId);
        i.name = p?.fullName || `Player #${i.playerId}`;
        i.pos  = ESPN_POS[p?.defaultPositionId] || "";
      }));
    } catch { /* names optional */ }
  }
  return trades.sort((a, b) => a.week - b.week || (a.date || 0) - (b.date || 0));
}

// mTransactions2 only returns trades the cookie's owner was part of, so every other
// trade in the league is invisible there. They're rebuilt instead from where each player
// sat week to week (draft → week 1 → … → latest): a player who changes teams with no
// free-agent / waiver add by the new team in that window moved by trade. Moves in the
// same week are grouped into one trade per connected set of teams. These carry no date
// (just the week the new rosters first show, the same week ESPN stamps its own trades
// with) and no roster-space drops. Trades already found in `known` are skipped.
// Pre-draft trades (keeper deals) leave no roster trace, so only the owner's own show.
async function rosterTrades(env, league, season, txs, known) {
  const base = `${ESPN_BASE}/seasons/${season}/segments/0/leagues/${league.id}`;
  const meta = await espnFetch(env, `${base}?view=mDraftDetail&view=mStatus`);
  const st   = meta.status || {};
  const last = season >= currentSeason()
    ? (st.latestScoringPeriod || st.currentMatchupPeriod || 1)
    : (st.finalScoringPeriod || 17);
  const weeks = await Promise.all(Array.from({ length: last }, (_, i) =>
    espnFetch(env, `${base}?view=mRoster&scoringPeriodId=${i + 1}`).catch(() => null)));

  const added = new Set(); // `${pid}:${toTeam}:${period}`
  txs.forEach(t => {
    if (t.status !== "EXECUTED" || !["FREEAGENT", "WAIVER"].includes(t.type)) return;
    (t.items || []).forEach(i => { if (i.type === "ADD") added.add(`${i.playerId}:${i.toTeamId}:${t.scoringPeriodId || 0}`); });
  });
  const knownMove = new Set(known.flatMap(t => t.items.map(i => `${i.playerId}:${i.from}:${i.to}`)));

  let prev = new Map((meta.draftDetail?.picks || []).map(p => [p.playerId, p.teamId]));
  const out = [];
  weeks.forEach((wk, i) => {
    if (!wk) return;
    const p = i + 1;
    const now = new Map();
    (wk.teams || []).forEach(t => (t.roster?.entries || []).forEach(e => now.set(e.playerId, t.id)));
    const moves = [];
    now.forEach((to, pid) => {
      const from = prev.get(pid);
      if (from == null || from === to) return;
      if (added.has(`${pid}:${to}:${p}`) || added.has(`${pid}:${to}:${p - 1}`)) return;
      if (knownMove.has(`${pid}:${from}:${to}`)) return;
      moves.push({ playerId: pid, from, to, type: "TRADE" });
    });
    prev = now;
    // Group by connected teams: A⇄B and C⇄D in the same week are two trades.
    const groups = [];
    moves.forEach(m => {
      const hit = groups.filter(g => g.teams.has(m.from) || g.teams.has(m.to));
      const g = { teams: new Set([m.from, m.to]), items: [m] };
      hit.forEach(h => { h.teams.forEach(x => g.teams.add(x)); g.items.push(...h.items); groups.splice(groups.indexOf(h), 1); });
      groups.push(g);
    });
    groups.forEach((g, k) => out.push({
      id: `r${season}-${p}-${k}`, season, week: p, date: null, rebuilt: true,
      teams: [...g.teams], items: g.items,
    }));
  });
  return out;
}

// ── ESPN → SLEEPER ADAPTER ───────────────────────────────────────────────────
// Lets an ESPN league run on the standard (Sleeper) page template unchanged: the page's
// league id is `espn_{espnLeagueId}_{season}`, and every /api/league/:id/:resource it
// calls comes back in Sleeper's shape. Owners are keyed by ESPN member id (stable across
// seasons), rosters by ESPN team id, players by `e{espnPlayerId}`.
//
// Consolation games (WINNERS_/LOSERS_CONSOLATION_LADDER) are never emitted as matchups —
// they don't count toward records, H2H, all-play or league records. Only the 3rd-place
// award reads one, via the winners bracket.
const ESPN_COUNTED_TIERS = new Set(["NONE", "WINNERS_BRACKET"]);

function espnLeagueById(id) {
  const e = Object.entries(ESPN_LEAGUES).find(([, l]) => String(l.id) === String(id));
  return e ? { key: e[0], league: e[1] } : null;
}

// Season core: settings, teams, members, schedule — trimmed. Past seasons are kept in R2
// for good; the current one refreshes on the KV ttl. Seasons the cookie owner wasn't a
// member of are only readable through leagueHistory (no per-player box scores there).
async function espnCore(env, key, league, season) {
  const live  = season >= currentSeason();
  const r2Key = `espn/${key}/core-${season}.json`;
  const kvKey = `espncore:${key}:${season}`;
  if (live) {
    const c = await env.FF_CACHE.get(kvKey);
    if (c) { try { return JSON.parse(c); } catch { /* refetch */ } }
  } else {
    const obj = await env.ESPN_DATA.get(r2Key);
    if (obj) { try { return JSON.parse(await obj.text()); } catch { /* refetch */ } }
  }

  const views = "view=mSettings&view=mTeam&view=mMatchupScore&view=mStatus";
  let d = null, history = false;
  try {
    d = await espnFetch(env, `${ESPN_BASE}/seasons/${season}/segments/0/leagues/${league.id}?${views}`);
  } catch {
    const arr = await espnFetch(env, `${ESPN_BASE}/leagueHistory/${league.id}?seasonId=${season}&${views}`);
    d = Array.isArray(arr) ? arr[0] : null;
    history = true;
  }
  if (!d || !Array.isArray(d.teams) || !d.teams.length) throw new Error(`ESPN season ${season} unavailable`);

  const ss   = d.settings?.scheduleSettings || {};
  const side = s => s ? { teamId: s.teamId, pts: s.totalPoints || 0 } : null;
  const core = {
    season, history,
    name: d.settings?.name || "",
    regWeeks: ss.matchupPeriodCount || 14,
    playoffTeams: ss.playoffTeamCount || 4,
    matchupPeriods: ss.matchupPeriods || {},
    members: (d.members || []).map(m => ({ id: m.id, displayName: m.displayName, firstName: m.firstName, lastName: m.lastName })),
    teams: d.teams.map(t => ({
      id: t.id, name: t.name || [t.location, t.nickname].filter(Boolean).join(" "),
      primaryOwner: t.primaryOwner || null, divisionId: t.divisionId ?? 0,
      record: t.record?.overall || {}, rankFinal: t.rankCalculatedFinal || 0,
    })),
    schedule: (d.schedule || []).map(m => ({
      id: m.id, mp: m.matchupPeriodId, tier: m.playoffTierType || "NONE",
      winner: m.winner || "UNDECIDED", home: side(m.home), away: side(m.away),
    })),
  };
  const body = JSON.stringify(core);
  if (live) await env.FF_CACHE.put(kvKey, body, { expirationTtl: getTTL() });
  else await env.ESPN_DATA.put(r2Key, body, { httpMetadata: { contentType: "application/json" } }).catch(() => {});
  return core;
}

const espnCap = s => String(s || "").trim().toLowerCase().replace(/(^|[\s'-])\w/g, c => c.toUpperCase());
const espnUid = t => t.primaryOwner || `team${t.id}`;
const espnDecided = m => m.winner === "HOME" || m.winner === "AWAY" || m.winner === "TIE";

// Last matchup period whose counted games are all final (Sleeper's last_scored_leg)
function espnScored(core) {
  let scored = 0;
  const maxMp = Math.max(0, ...core.schedule.map(m => m.mp));
  for (let mp = 1; mp <= maxMp; mp++) {
    const g = core.schedule.filter(m => m.mp === mp && ESPN_COUNTED_TIERS.has(m.tier));
    if (!g.length || !g.every(espnDecided)) break;
    scored = mp;
  }
  return scored;
}

function espnUsers(core) {
  return core.teams.map(t => {
    const m = core.members.find(x => x.id === t.primaryOwner);
    const full = m ? `${espnCap(m.firstName)} ${espnCap(m.lastName)}`.trim() : "";
    return {
      user_id: espnUid(t),
      display_name: full || m?.displayName || t.name || `Team ${t.id}`,
      metadata: { team_name: t.name },
      avatar: null,
    };
  });
}

function espnRosters(core) {
  const divs = new Set(core.teams.map(t => t.divisionId)).size > 1;
  // Regular-season PF/PA from the schedule — ESPN's record totals are sometimes 0 on old seasons
  const pf = {}, pa = {};
  core.schedule.forEach(m => {
    if (m.tier !== "NONE" || !m.home || !m.away || !espnDecided(m)) return;
    pf[m.home.teamId] = (pf[m.home.teamId] || 0) + m.home.pts;
    pa[m.home.teamId] = (pa[m.home.teamId] || 0) + m.away.pts;
    pf[m.away.teamId] = (pf[m.away.teamId] || 0) + m.away.pts;
    pa[m.away.teamId] = (pa[m.away.teamId] || 0) + m.home.pts;
  });
  const split = v => { const c = Math.round((v || 0) * 100); return [Math.floor(c / 100), c % 100]; };
  return core.teams.map(t => {
    const [f, fd] = split(t.record.pointsFor || pf[t.id]);
    const [a, ad] = split(t.record.pointsAgainst || pa[t.id]);
    return {
      roster_id: t.id, owner_id: espnUid(t),
      settings: {
        wins: t.record.wins || 0, losses: t.record.losses || 0, ties: t.record.ties || 0,
        fpts: f, fpts_decimal: fd, fpts_against: a, fpts_against_decimal: ad,
        ...(divs ? { division: t.divisionId + 1 } : {}),
      },
    };
  });
}

// Sleeper-shaped winners bracket: final first in its round (p:1), then the 3rd-place game (p:3).
function espnWinnersBracket(core) {
  const wb  = core.schedule.filter(m => m.tier === "WINNERS_BRACKET" && m.home && m.away)
    .sort((a, b) => a.mp - b.mp || a.id - b.id);
  const mps = [...new Set(wb.map(m => m.mp))];
  let n = 0;
  const out = wb.map(m => {
    const r = mps.indexOf(m.mp) + 1, t1 = m.home.teamId, t2 = m.away.teamId;
    const w = m.winner === "HOME" ? t1 : m.winner === "AWAY" ? t2 : null;
    return { m: ++n, r, t1, t2, w, l: w == null ? null : (w === t1 ? t2 : t1), ...(r === mps.length ? { p: 1 } : {}) };
  });

  // 3rd place — ESPN's final rank, only between two teams that actually made the bracket
  const final = out.find(x => x.p === 1);
  const inBracket = new Set(out.flatMap(x => [x.t1, x.t2]));
  const third  = core.teams.find(t => t.rankFinal === 3)?.id;
  const fourth = core.teams.find(t => t.rankFinal === 4)?.id;
  if (final?.w != null && third != null && fourth != null && inBracket.has(third) && inBracket.has(fourth)) {
    out.push({ m: ++n, r: final.r, t1: third, t2: fourth, w: third, l: fourth, p: 3 });
  }
  return out;
}

function espnInfo(core, lid) {
  const final = espnWinnersBracket(core).find(x => x.p === 1);
  const done  = core.season < currentSeason() || (final && final.w != null);
  return {
    league_id: lid, name: core.name, season: String(core.season),
    status: done ? "complete" : "in_season",
    total_rosters: core.teams.length,
    settings: {
      type: 0, num_teams: core.teams.length,
      last_scored_leg: espnScored(core),
      playoff_week_start: core.regWeeks + 1,
      playoff_teams: core.playoffTeams,
    },
  };
}

// Per-player points for one matchup period ({teamId: {e{pid}: pts}}), summed over its scoring
// periods (old 2-week playoff rounds). Feeds the Trade History PPG chips only.
async function espnPlayerPoints(env, key, league, core, mp) {
  if (core.history) return {};
  const live  = core.season >= currentSeason();
  if (live && mp > espnScored(core) + 1) return {};   // not played yet
  const r2Key = `espn/${key}/pp-${core.season}-${mp}.json`;
  const kvKey = `espnpp:${key}:${core.season}:${mp}`;
  if (live) {
    const c = await env.FF_CACHE.get(kvKey);
    if (c) { try { return JSON.parse(c); } catch {} }
  } else {
    const obj = await env.ESPN_DATA.get(r2Key);
    if (obj) { try { return JSON.parse(await obj.text()); } catch {} }
  }

  const sps = core.matchupPeriods[mp] || [mp];
  const out = {};
  for (const sp of sps) {
    const d = await espnFetch(env,
      `${ESPN_BASE}/seasons/${core.season}/segments/0/leagues/${league.id}?view=mBoxscore&scoringPeriodId=${sp}`);
    (d.schedule || []).forEach(m => {
      if (m.matchupPeriodId !== mp) return;
      [m.home, m.away].forEach(s => {
        (s?.rosterForCurrentScoringPeriod?.entries || []).forEach(e => {
          const stats = e.playerPoolEntry?.player?.stats || [];
          const line  = stats.find(x => x.statSourceId === 0 && x.scoringPeriodId === sp);
          if (!line) return;
          const team = (out[s.teamId] ||= {});
          const pid  = `e${e.playerId}`;
          team[pid] = Math.round(((team[pid] || 0) + (line.appliedTotal || 0)) * 100) / 100;
        });
      });
    });
  }
  const body = JSON.stringify(out);
  if (live) await env.FF_CACHE.put(kvKey, body, { expirationTtl: getTTL() });
  else await env.ESPN_DATA.put(r2Key, body, { httpMetadata: { contentType: "application/json" } }).catch(() => {});
  return out;
}

async function espnMatchups(env, key, league, core, mp) {
  const games = core.schedule.filter(m => m.mp === mp && ESPN_COUNTED_TIERS.has(m.tier) && m.home);
  if (!games.length) return [];
  const pp = await espnPlayerPoints(env, key, league, core, mp).catch(e => {
    console.warn(`ESPN player points ${key} ${core.season} mp${mp}:`, e.message);
    return {};
  });
  // Old two-week playoff rounds: one game, but its score is two weeks' worth — flagged so
  // the page keeps it out of single-game score records.
  const weeks = (core.matchupPeriods[mp] || [mp]).length;
  return games.flatMap((m, i) => [m.home, m.away].filter(Boolean).map(s => ({
    roster_id: s.teamId,
    matchup_id: m.away ? i + 1 : null,   // a bye has no opponent
    points: s.pts,
    players_points: pp[s.teamId] || {},
    ...(weeks > 1 ? { weeks } : {}),
  })));
}

// ESPN trades → Sleeper transactions. `_players` carries names for the `e{pid}` ids,
// which the page merges into its player map.
async function espnSleeperTrades(env, key, league, season) {
  const trades = await getEspnTrades(env, key, league, season);
  return trades.map(t => {
    const adds = {}, drops = {}, players = {};
    t.items.forEach(i => {
      const pid = `e${i.playerId}`;
      if (i.type === "TRADE") adds[pid] = i.to; else drops[pid] = i.from;
      players[pid] = { full_name: i.name || `Player #${i.playerId}`, position: i.pos || "" };
    });
    return {
      transaction_id: String(t.id), type: "trade", status: "complete",
      roster_ids: t.teams, adds, drops, draft_picks: [],
      status_updated: t.date || null, leg: t.week, _players: players,
    };
  });
}

async function handleEspnLeague(env, lid, espnId, season, resource, param) {
  const hit = espnLeagueById(espnId);
  if (!hit) return espnJson({ error: "Unknown ESPN league" }, 404);
  const { key, league } = hit;
  const maxAge = season >= currentSeason() ? 300 : 3600;
  try {
    if (resource === "draft")          return espnJson({ draft_order: {}, picks: [] }, 200, maxAge);
    if (resource === "traded_picks"
     || resource === "losers_bracket") return espnJson([], 200, maxAge);
    if (resource === "trade-values")   return espnJson({}, 200, maxAge);
    if (resource === "trades" || resource === "transactions") {
      if (season < league.tradesFrom) return espnJson([], 200, maxAge);
      return espnJson(await espnSleeperTrades(env, key, league, season), 200, maxAge);
    }

    const core = await espnCore(env, key, league, season);
    if (resource === "rosters")         return espnJson(espnRosters(core), 200, maxAge);
    if (resource === "users")           return espnJson(espnUsers(core), 200, maxAge);
    if (resource === "winners_bracket") return espnJson(espnWinnersBracket(core), 200, maxAge);
    if (resource === "info")            return espnJson(espnInfo(core, lid), 200, maxAge);
    if (resource === "matchups" && param) {
      const mp = parseInt(param, 10);
      if (isNaN(mp) || mp < 1 || mp > 18) return espnJson({ error: "Invalid week" }, 400);
      return espnJson(await espnMatchups(env, key, league, core, mp), 200, maxAge);
    }
    return espnJson({ error: "Unknown resource" }, 404);
  } catch (e) {
    return espnJson({ error: e.message }, 502);
  }
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname; // e.g. /api/league/123/rosters

    // CORS preflight
    if (request.method === "OPTIONS") {
      return new Response(null, {
        headers: {
          "Access-Control-Allow-Origin": "*",
          "Access-Control-Allow-Methods": "GET, OPTIONS",
          "Access-Control-Allow-Headers": "Content-Type",
        },
      });
    }

    // Only handle /api/league/..., /api/players, /api/projections/..., or /api/espn/...
    if (!path.startsWith("/api/league/") && path !== "/api/players"
        && !path.startsWith("/api/espn/") && !path.startsWith("/api/projections/")) {
      return new Response("Not found", { status: 404 });
    }

    // ── SLEEPER WEEKLY PROJECTIONS (recap playoff odds) ──
    // /api/projections/:season/:week → {player_id: projected stat line}, ~570 KB.
    if (path.startsWith("/api/projections/")) {
      const [season, week] = path.replace("/api/projections/", "").split("/");
      if (!/^\d{4}$/.test(season || "") || !(Number(week) >= 1 && Number(week) <= 18)) {
        return espnJson({ error: "Invalid projections route" }, 400);
      }
      return fetchWithCache(env, `proj:${season}:${Number(week)}`,
        `${SLEEPER_BASE}/projections/nfl/regular/${season}/${Number(week)}`, getTTL());
    }

    // ── ESPN ROUTES ───────────────────────────────────────
    // /api/espn/:leagueKey/:season         → season JSON. Past seasons: R2 archive.
    //                                         Current season: live from ESPN (KV, ttl),
    //                                         snapshotted to R2 as a fallback.
    // /api/espn/:leagueKey/trades/:season  → completed trades for that season
    // /api/espn/:leagueKey/:other          → any other R2 file (legacy)
    if (path.startsWith("/api/espn/")) {
      const espnSegments = path.replace("/api/espn/", "").split("/");
      const leagueKey   = espnSegments[0]; // e.g. "eliteffl"
      const seasonOrKey = espnSegments[1]; // e.g. "2025" or "trades"

      if (!leagueKey || !seasonOrKey) return espnJson({ error: "Invalid ESPN route" }, 400);

      try {
        const league = ESPN_LEAGUES[leagueKey];

        if (league && seasonOrKey === "trades" && /^\d{4}$/.test(espnSegments[2] || "")) {
          return espnJson(await getEspnTrades(env, leagueKey, league, Number(espnSegments[2])),
            200, Number(espnSegments[2]) >= currentSeason() ? 300 : 3600);
        }

        if (league && seasonOrKey === "recap" && /^\d{4}$/.test(espnSegments[2] || "")) {
          const data = await getEspnRecap(env, leagueKey, league, Number(espnSegments[2]));
          return data ? espnJson(data, 200, 300) : espnJson({ error: "ESPN recap unavailable" }, 502);
        }

        if (league && /^\d{4}$/.test(seasonOrKey) && Number(seasonOrKey) >= currentSeason()) {
          const data = await getEspnLiveSeason(env, leagueKey, league, Number(seasonOrKey));
          if (data) return espnJson(data, 200, 300);
          // live fetch failed (no cookies / expired / pre-season) — fall through to R2
        }

        const r2Key = `espn/${leagueKey}/${seasonOrKey}.json`;
        const obj = await env.ESPN_DATA.get(r2Key);
        if (!obj) return espnJson({ error: "Not found", key: r2Key }, 404);
        return new Response(await obj.text(), {
          headers: {
            "Content-Type": "application/json",
            "Access-Control-Allow-Origin": "*",
            "Cache-Control": "public, max-age=3600",
          },
        });
      } catch (e) {
        return espnJson({ error: e.message }, 500);
      }
    }

    // ── NFL PLAYERS LOOKUP ────────────────────────────────
    if (path === "/api/players") {
      return fetchWithCache(
        env,
        `players:nfl`,
        `${SLEEPER_BASE}/players/nfl`,
        TTL_OFFSEASON
      );
    }

    // Parse path segments — must happen before any resource checks
    // /api/league/:leagueId/:resource[/:param]
    const segments = path.replace("/api/league/", "").split("/");
    const leagueId = segments[0];
    const resource = segments[1];
    const param    = segments[2]; // week number etc.

    if (!leagueId || !resource) {
      return new Response(JSON.stringify({ error: "Invalid route" }), {
        status: 400,
        headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" },
      });
    }

    // ── ESPN league on the standard template (espn_{id}_{season}) ──
    const espnLid = /^espn_(\d+)_(\d{4})$/.exec(leagueId);
    if (espnLid) return handleEspnLeague(env, leagueId, espnLid[1], Number(espnLid[2]), resource, param);

    const ttl = getTTL();

    // ── ROSTERS ──────────────────────────────────────────
    if (resource === "rosters") {
      return fetchWithCache(
        env,
        `rosters:${leagueId}`,
        `${SLEEPER_BASE}/league/${leagueId}/rosters`,
        ttl
      );
    }

    // ── USERS ─────────────────────────────────────────────
    if (resource === "users") {
      return fetchWithCache(
        env,
        `users:${leagueId}`,
        `${SLEEPER_BASE}/league/${leagueId}/users`,
        ttl
      );
    }

    // ── WINNERS BRACKET ───────────────────────────────────
    if (resource === "winners_bracket") {
      return fetchWithCache(
        env,
        `bracket:${leagueId}`,
        `${SLEEPER_BASE}/league/${leagueId}/winners_bracket`,
        ttl
      );
    }

    // ── MATCHUPS (by week) ────────────────────────────────
    if (resource === "matchups" && param) {
      const week = parseInt(param, 10);
      if (isNaN(week) || week < 1 || week > 18) {
        return new Response(JSON.stringify({ error: "Invalid week" }), {
          status: 400,
          headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" },
        });
      }
      return fetchWithCache(
        env,
        `matchups:${leagueId}:${week}`,
        `${SLEEPER_BASE}/league/${leagueId}/matchups/${week}`,
        ttl
      );
    }

    // ── TRANSACTIONS (by week) ────────────────────────────
    if (resource === "transactions" && param) {
      const week = parseInt(param, 10);
      if (isNaN(week) || week < 1 || week > 18) {
        return new Response(JSON.stringify({ error: "Invalid week" }), {
          status: 400,
          headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" },
        });
      }
      return fetchWithCache(
        env,
        `transactions:${leagueId}:${week}`,
        `${SLEEPER_BASE}/league/${leagueId}/transactions/${week}`,
        ttl
      );
    }

    // ── LOSERS BRACKET ───────────────────────────────────
    if (resource === "losers_bracket") {
      return fetchWithCache(
        env,
        `losers_bracket:${leagueId}`,
        `${SLEEPER_BASE}/league/${leagueId}/losers_bracket`,
        ttl
      );
    }

    // ── TRADED PICKS (recap draft order) ─────────────────
    if (resource === "traded_picks") {
      return fetchWithCache(
        env,
        `traded_picks:${leagueId}`,
        `${SLEEPER_BASE}/league/${leagueId}/traded_picks`,
        ttl
      );
    }

    // ── LEAGUE INFO (divisions, settings) ────────────────
    if (resource === "info") {
      return fetchWithCache(
        env,
        `info:${leagueId}`,
        `${SLEEPER_BASE}/league/${leagueId}`,
        ttl  // carries last_scored_leg — must refresh as often as matchups
      );
    }

    // ── DRAFT INFO + PICKS FOR A LEAGUE ──────────────────
    // Returns { draft_order: {roster_id: slot}, picks: [...] }
    // draft_order maps each roster_id to their original draft slot
    if (resource === "draft") {
      const cacheKey = `draft:${leagueId}`;
      const cached = await env.FF_CACHE.get(cacheKey);
      if (cached) {
        return new Response(cached, {
          headers: { "Content-Type": "application/json", "X-Cache": "HIT", "Access-Control-Allow-Origin": "*" },
        });
      }
      try {
        // Draft ID passed as query param from the page config (?draftId=xxx)
        // This allows any league to resolve draft picks without hardcoding IDs in the Worker
        const url = new URL(request.url);
        const draftId = url.searchParams.get("draftId");
        if (!draftId) {
          // No draft ID provided — no rookie draft data available
          return new Response(JSON.stringify({ draft_order: {}, picks: [] }), {
            headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" }
          });
        }

        // Fetch draft metadata and picks in parallel
        const [metaRes, picksRes] = await Promise.all([
          fetch(`${SLEEPER_BASE}/draft/${draftId}`),
          fetch(`${SLEEPER_BASE}/draft/${draftId}/picks`),
        ]);
        const [draftMeta, picks] = await Promise.all([metaRes.json(), picksRes.json()]);

        // draft_order maps user_id → original draft slot (stable, never changes)
        const userToSlot = draftMeta.draft_order || {};

        // Build user_id → roster_id from ALL picks across all rounds
        // (using all rounds ensures we catch users who traded away their R1 pick)
        const userToRoster = {};
        picks.forEach(p => {
          if (p.picked_by && p.roster_id !== undefined && !userToRoster[p.picked_by]) {
            userToRoster[p.picked_by] = p.roster_id;
          }
        });

        // Also fetch league rosters to catch any user who didn't pick at all
        // (traded away all their picks) — map owner_id → roster_id directly
        let rosterOwners = {};
        try {
          const rostersRes = await fetch(`${SLEEPER_BASE}/league/${leagueId}/rosters`);
          const rosters = await rostersRes.json();
          rosters.forEach(r => { if (r.owner_id) rosterOwners[r.owner_id] = r.roster_id; });
        } catch(e) { /* non-fatal */ }

        // Final map: roster_id → original draft slot
        // Prefer picks-based mapping, fall back to roster owner mapping
        const rosterToSlot = {};
        Object.entries(userToSlot).forEach(([userId, slot]) => {
          const rosterId = userToRoster[userId] ?? rosterOwners[userId];
          if (rosterId !== undefined) rosterToSlot[rosterId] = slot;
        });

        const body = JSON.stringify({ draft_order: rosterToSlot, picks });
        await env.FF_CACHE.put(cacheKey, body, { expirationTtl: TTL_OFFSEASON });
        return new Response(body, {
          headers: { "Content-Type": "application/json", "X-Cache": "MISS", "Access-Control-Allow-Origin": "*" },
        });
      } catch(e) {
        return new Response(JSON.stringify({ error: e.message }), {
          status: 500, headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" },
        });
      }
    }

    // ── TRADES (aggregated — all weeks, filtered to trades only) ──
    if (resource === "trades") {
      const cacheKey = `trades:${leagueId}`;
      const cached = await env.FF_CACHE.get(cacheKey);
      if (cached) {
        return new Response(cached, {
          headers: {
            "Content-Type": "application/json",
            "X-Cache": "HIT",
            "Access-Control-Allow-Origin": "*",
          },
        });
      }

      const trades = await fetchAllTrades(env, leagueId, ttl);
      return new Response(JSON.stringify(trades), {
        headers: {
          "Content-Type": "application/json",
          "X-Cache": "MISS",
          "Access-Control-Allow-Origin": "*",
        },
      });
    }

    // ── TRADE MARKET VALUES (frozen "day-of" values per trade) ────────────
    // Returns { [transaction_id]: { source, asOf, players:{pid:val}, picks:{"season:round:roster_id":val} } }
    // Lazily freezes live FantasyCalc values for post-cutoff trades on read.
    if (resource === "trade-values") {
      const r2Key = `trade-values/${leagueId}.json`;
      let frozen = {};
      try {
        const obj = await env.ESPN_DATA.get(r2Key);
        if (obj) frozen = JSON.parse(await obj.text());
      } catch { frozen = {}; }

      const trades = await fetchAllTrades(env, leagueId, ttl);
      const toFreeze = trades.filter(tx =>
        (tx.status_updated || 0) >= FC_CUTOFF_MS && !frozen[tx.transaction_id]
      );

      if (toFreeze.length) {
        const fc = await getFcMaps(env);
        if (fc) {
          const asOf = new Date().toISOString().slice(0, 10);
          for (const tx of toFreeze) {
            const rec = { source: "FC", asOf, frozenAt: Date.now(), players: {}, picks: {} };
            for (const pid of Object.keys(tx.adds || {})) {
              rec.players[pid] = fc.players[pid] || 0;
            }
            for (const p of (tx.draft_picks || [])) {
              rec.picks[`${p.season}:${p.round}:${p.roster_id}`] =
                genericPickValue(p.season, p.round, fc.picks);
            }
            frozen[tx.transaction_id] = rec;
          }
          try {
            await env.ESPN_DATA.put(r2Key, JSON.stringify(frozen), {
              httpMetadata: { contentType: "application/json" },
            });
          } catch { /* non-fatal — return what we have */ }
        }
      }

      return new Response(JSON.stringify(frozen), {
        headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" },
      });
    }

    return new Response(JSON.stringify({ error: "Unknown resource" }), {
      status: 404,
      headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" },
    });
  },
};