// ════════════════════════════════════════════════════════════════════════════
// FF Historian — the shared league page.
//
// Every standard league page (/{slug}/index.html, all identical) loads
// /league/leagues.js + this file. The slug comes from the URL; everything the
// league needs — IDs, branding, dynasty vs redraft, Sleeper vs ESPN, ownership
// merges — comes from its LEAGUES entry. Edit behaviour here once; it changes
// every league.
//
// ESPN leagues need nothing special on this side: the worker serves their seasons
// Sleeper-shaped under /api/league/espn_{id}_{season}/… (worker/src/index.js,
// "ESPN → SLEEPER ADAPTER").
// ════════════════════════════════════════════════════════════════════════════

const LEAGUE_SLUG = location.pathname.split("/").filter(Boolean)[0] || "";
const LEAGUE = (typeof LEAGUES !== "undefined" ? LEAGUES : []).find(l => l.slug === LEAGUE_SLUG);

const LEAGUE_CONFIG = LEAGUE ? {
  name: LEAGUE.name,
  espnKey: LEAGUE.espnKey,
  seasons: LEAGUE.seasons,
  draftIds: LEAGUE.draftIds || {},
  hasDivisions: !!LEAGUE.hasDivisions,
} : { name: "", seasons: {}, draftIds: {}, hasDivisions: false };

const IS_DYNASTY = LEAGUE?.format !== "redraft";
const IS_ESPN    = LEAGUE?.platform === "espn";
// What names an owner: dynasty leagues keep a team name for years; redraft team
// names churn every season, so those key off the stable username.
const OWNER_LABEL = LEAGUE?.ownerName || (IS_DYNASTY ? "team" : "user");

// All Worker API calls go through your own domain — no direct Sleeper calls from the browser
const API_BASE = "/api/league";

// ═══════════════════════════════════════════════════
// FRANCHISE CONTINUITY (per league, from LEAGUES)
//
// ownershipMerges: one owner under two ids — took over another's roster, or
// moved to a new account. Stats merge under canonicalUserId; seasonTeamNames
// optionally names each season.
// teamNameAliases: simple renames (same user_id, different team name).
// ═══════════════════════════════════════════════════
const OWNERSHIP_MERGES  = LEAGUE?.ownershipMerges || [];
const TEAM_NAME_ALIASES = LEAGUE?.teamNameAliases || {};

// Returns the canonical user_id for any user (merges legacy owners)
function canonicalUserId(uid) {
  const merge = OWNERSHIP_MERGES.find(m => m.legacyUserId === uid);
  return merge ? merge.canonicalUserId : uid;
}

// Returns the display name for a user in a given season
function displayNameForSeason(uid, year) {
  // Check if this uid is a legacy owner with a season-specific name
  const merge = OWNERSHIP_MERGES.find(m => m.legacyUserId === uid || m.canonicalUserId === uid);
  if (merge?.seasonTeamNames?.[year]) return merge.seasonTeamNames[year];
  // Fall back to ownerMap display name with alias applied
  const raw = ownerMap[canonicalUserId(uid)]?.display_name || ownerMap[uid]?.display_name || uid;
  return TEAM_NAME_ALIASES[raw] || raw;
}

function canonicalName(name) {
  return TEAM_NAME_ALIASES[name] || name;
}

// ═══════════════════════════════════════════════════
// DYNASTY TRADE MARKET (format: "dynasty")
// Trade History values each side by FantasyCalc: day-of ("then", frozen by the
// worker / DynastyProcess backfill) vs today ("now").
// ═══════════════════════════════════════════════════
// ── Trade Market state ───────────────────────────────────
const FC_TODAY_URL = "https://helper.ffhistorian.com/api/fantasycalc"; // live FantasyCalc (CORS allows ffhistorian.com)
let fcToday = null;             // { players: {sleeperId: value}, picks: {year_round[_q]: value} } | "error"
let tradeValueCache = {};       // { leagueId: { [txId]: frozenRecord } }

// Fetch + parse live FantasyCalc once → "today" values for the market
async function loadFcToday() {
  if (fcToday) return fcToday;
  try {
    const arr = await fetch(FC_TODAY_URL).then(r => r.json());
    const players = {}, picks = {};
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
    fcToday = { players, picks };
  } catch (e) {
    console.warn("FantasyCalc (today) load failed:", e.message);
    fcToday = "error";
  }
  return fcToday;
}

// Frozen day-of values for a league (DP backfill + FC freeze-on-read), cached per league
async function loadTradeValues(leagueId) {
  if (tradeValueCache[leagueId]) return tradeValueCache[leagueId];
  try {
    tradeValueCache[leagueId] = await apiFetch(`/${leagueId}/trade-values`);
  } catch (e) {
    console.warn(`Trade values fetch failed for ${leagueId}:`, e.message);
    tradeValueCache[leagueId] = {};
  }
  return tradeValueCache[leagueId];
}

// Generic (slot-unknown / future) pick value from a FantasyCalc pick map
function fcGenericPick(season, round, picks) {
  if (!picks || round > 6) return 0;
  return picks[`${season}_${round}_mid`]
      || picks[`${season}_${round}`]
      || picks[`${season}_${round}_early`]
      || 0;
}

// ── Trade Market helpers ─────────────────────────────────
// Sum the day-of ("then") and current ("now") value of everything one roster received
function computeSideValue(tx, sideRid, frozenRec) {
  const fc = (fcToday && fcToday !== "error") ? fcToday : null;
  let then = 0, now = 0;
  for (const [pid, rid] of Object.entries(tx.adds || {})) {
    if (rid !== sideRid) continue;
    if (frozenRec) then += (frozenRec.players?.[pid] || 0);
    if (fc) now += (fc.players[pid] || 0);
  }
  for (const p of (tx.draft_picks || [])) {
    if (p.owner_id !== sideRid) continue;
    if (frozenRec) then += (frozenRec.picks?.[`${p.season}:${p.round}:${p.roster_id}`] || 0);
    if (fc) {
      const pid = resolvePickPid(p); // converted pick → drafted player's current value
      now += pid ? (fc.players[pid] || 0) : fcGenericPick(p.season, p.round, fc.picks);
    }
  }
  return { then: Math.round(then), now: Math.round(now), hasThen: !!frozenRec, hasNow: !!fc };
}

// Consolidation premium: boost the side receiving FEWER pieces, by the piece-count
// gap — 1→10%, 2→15%, 3+→20% (cap 20). Feeds the winner call only.
function consolidationBoost(n1, n2) {
  const diff = Math.abs(n1 - n2);
  if (diff === 0 || n1 === 0 || n2 === 0) return { p1: 0, p2: 0 };
  const pct = Math.min(20, 5 + 5 * diff);
  return n1 < n2 ? { p1: pct, p2: 0 } : { p1: 0, p2: pct };
}

// showDelta: only when "then" and "now" are the same scale (both FantasyCalc).
// DP→FC comparisons are apples-to-oranges, so we omit the % for historical trades.
// boostPct: consolidation premium chip shown on the side receiving fewer pieces.
function valueBarHtml(v, showDelta, boostPct) {
  if (!v.hasThen && !v.hasNow) return "";
  const mult = 1 + (boostPct || 0) / 100;   // bake the consolidation premium into shown values
  const thenV = Math.round(v.then * mult);
  const nowV  = Math.round(v.now * mult);
  const fmt = n => n.toLocaleString("en-US");
  const thenStr = v.hasThen ? `<span class="tv-then">Then ${fmt(thenV)}</span>` : "";
  const nowStr  = v.hasNow  ? `<span class="tv-now">Now ${fmt(nowV)}</span>`   : "";
  let delta = "";
  if (showDelta && v.hasThen && v.hasNow && thenV > 0) {
    const pct = Math.round(((nowV - thenV) / thenV) * 100);  // same factor both ends → unchanged %
    const cls = pct > 0 ? "up" : pct < 0 ? "down" : "flat";
    const sign = pct > 0 ? "+" : "";
    delta = `<span class="tv-delta ${cls}">${sign}${pct}%</span>`;
  }
  const boost = boostPct
    ? `<span class="tv-boost" title="Consolidation premium for receiving fewer pieces — already included in the values">incl. +${boostPct}%</span>`
    : "";
  const sep = (thenStr && nowStr) ? `<span class="tv-arrow">→</span>` : "";
  return `<div class="trade-value">${thenStr}${sep}${nowStr}${delta}${boost}</div>`;
}

function marketSourceCaption(frozenRec) {
  if (!frozenRec) {
    return (fcToday && fcToday !== "error")
      ? `<em>Day-of value unavailable — showing current FantasyCalc only</em>`
      : "";
  }
  const label = frozenRec.source === "DP"
    ? "DynastyProcess (historical, pre Jul 2026)"
    : "FantasyCalc";
  return `Day-of values: ${label} · “Now” from live FantasyCalc`;
}

// ═══════════════════════════════════════════════════
// PAGE MARKUP — the same for every league
// ═══════════════════════════════════════════════════
function escHtml(s) {
  return String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

function renderShell() {
  const L = LEAGUE;
  document.title = `${L.title} — FF Historian`;
  const years = Object.keys(L.seasons).sort();
  const dataVia = IS_ESPN
    ? `<a href="https://fantasy.espn.com">ESPN Fantasy</a>`
    : `<a href="https://sleeper.com">Sleeper API</a>`;
  document.getElementById("app").innerHTML = `
<div class="page-wrap">

  <header class="banner">
    <div class="banner-inner">
      <img class="banner-logo" src="${escHtml(L.logo)}" alt="${escHtml(L.name)} Logo"
           onerror="this.replaceWith(document.createTextNode(${escHtml(JSON.stringify(L.emoji || "🏈"))}))"/>
      <div class="banner-text">
        <a class="banner-back" href="/">← All Leagues</a>
        <h1>${escHtml(L.h1[0])} <span>${escHtml(L.h1[1])}</span></h1>
        <p class="banner-sub">The Official Record &amp; Archive</p>
        <p class="banner-seasons">${years.join(" · ")}</p>
        <div class="banner-divider"></div>
      </div>
    </div>
  </header>

  <nav class="tab-bar">
    <div class="tab-bar-inner">
      <button class="tab-btn active" onclick="switchTab('standings', this)">📜 Standings</button>
      <button class="tab-btn" onclick="switchTab('recap', this)">📰 Recap</button>
      <button class="tab-btn" onclick="switchTab('h2h', this)">⚔️ Head to Head</button>
      <button class="tab-btn" onclick="switchTab('trades', this)">🔄 Trade History</button>
      <button class="tab-btn" onclick="switchTab('records', this)">🏅 League Records</button>
    </div>
  </nav>

  <main class="main">

    <!-- STANDINGS -->
    <section class="panel active" id="panel-standings">
      <div class="section-head">
        <h2>League Standings</h2>
        <div class="section-head-line"></div>
      </div>
      <div class="year-pills" id="standingsYearPills">
        <button class="year-pill active" onclick="loadStandings('alltime', this)">All Time</button>
      </div>
      <div id="standingsContent">
        <div class="loading"><div class="spinner"></div><br/>Loading records from the archive…</div>
      </div>
    </section>

    <!-- RECAP -->
    <section class="panel" id="panel-recap">
      <div class="section-head">
        <h2>League Recap</h2>
        <div class="section-head-line"></div>
      </div>
      <div id="recapContent"></div>
    </section>

    <!-- LEAGUE RECORDS -->
    <section class="panel" id="panel-records">
      <div class="section-head">
        <h2>League Records</h2>
        <div class="section-head-line"></div>
      </div>
      <div id="recordsContent">
        <div class="loading"><div class="spinner"></div><br/>Crunching the numbers…</div>
      </div>
    </section>

    <!-- HEAD TO HEAD -->
    <section class="panel" id="panel-h2h">
      <div class="section-head">
        <h2>Head to Head Records</h2>
        <div class="section-head-line"></div>
      </div>
      <div class="owner-selectors">
        <div class="owner-select-wrap">
          <label>Owner One</label>
          <select class="owner-select" id="h2hOwner1"><option value="">— Select Owner —</option></select>
        </div>
        <div class="vs-label">VS</div>
        <div class="owner-select-wrap">
          <label>Owner Two</label>
          <select class="owner-select" id="h2hOwner2"><option value="">— Select Owner —</option></select>
        </div>
        <button class="lookup-btn" onclick="loadH2H()">View Record</button>
      </div>
      <div id="h2hContent">
        <div class="placeholder-state">
          <div class="icon">⚔️</div>
          <p>Select two owners above to reveal their all-time head-to-head record.</p>
        </div>
      </div>
    </section>

    <!-- TRADE HISTORY -->
    <section class="panel" id="panel-trades">
      <div class="section-head">
        <h2>Trade History</h2>
        <div class="section-head-line"></div>
      </div>
      <div class="owner-selectors">
        <div class="owner-select-wrap">
          <label>Owner One</label>
          <select class="owner-select" id="tradeOwner1"><option value="">— Select Owner —</option></select>
        </div>
        <div class="vs-label">+</div>
        <div class="owner-select-wrap">
          <label>Owner Two <span style="font-size:0.8em;opacity:0.6">(optional)</span></label>
          <select class="owner-select" id="tradeOwner2"><option value="">— All Owners —</option></select>
        </div>
        <button class="lookup-btn" onclick="loadTrades()">View Trades</button>
      </div>
      <div id="tradesContent">
        <div class="placeholder-state">
          <div class="icon">🔄</div>
          <p>Select two owners above to view all trades between them.</p>
        </div>
      </div>
    </section>

  </main>

  <footer>
    <p>ffhistorian.com &nbsp;·&nbsp; Data via ${dataVia} &nbsp;·&nbsp; Powered by Cloudflare Pages &amp; Workers</p>
  </footer>
</div>

<div class="toast" id="toast"></div>`;
}

// ═══════════════════════════════════════════════════
// STATE
// ═══════════════════════════════════════════════════
let allSeasonData = {};   // { year: { rosters, users, matchupWeeks, bracketData, rosterUserMap } }
let ownerMap = {};        // { user_id: { display_name, avatar } }
let allOwnerIds = [];
let playerMap = {};       // { player_id: { full_name, position, team } }
let draftPickMap = {};    // { "leagueId:season:round:rosterId": "1.06 — Patrick Mahomes (QB)" }

// ── In-league PPG (redraft trade context) ────────────────
// Redraft leagues: dynasty market values (FantasyCalc) don't apply. Instead the
// Trade History tab shows each traded player's points-per-game IN
// THIS LEAGUE for the season the trade happened — computed from the matchup
// weeks already loaded in allSeasonData (no extra API calls).
let _ppgByYear = {};   // year → { pid: { pts, gp } }

function ppgIndexForYear(year) {
  if (_ppgByYear[year]) return _ppgByYear[year];
  const idx = {};
  const sd = allSeasonData[year];
  (sd?.matchupWeeks || []).forEach(week => {
    if (!Array.isArray(week)) return;
    week.forEach(m => {
      const pp = m.players_points || {};
      for (const [pid, pts] of Object.entries(pp)) {
        if (!idx[pid]) idx[pid] = { pts: 0, gp: 0 };
        idx[pid].pts += pts;
        if (pts > 0) idx[pid].gp += 1;   // gp = weeks the player actually scored
      }
    });
  });
  _ppgByYear[year] = idx;
  return idx;
}

// { ppg, pts, gp } for a player's season in this league, or null if they never scored
function playerPpg(year, pid) {
  if (!pid) return null;
  const rec = ppgIndexForYear(year)[pid];
  if (!rec || rec.gp === 0) return null;
  return { ppg: rec.pts / rec.gp, pts: rec.pts, gp: rec.gp };
}

// PPG chip HTML for one traded asset (player id known), or "" when no data
function ppgChip(year, pid) {
  const p = playerPpg(year, pid);
  if (!p) return "";
  return `<span class="ppg-chip" title="${p.pts.toFixed(1)} pts over ${p.gp} scoring weeks in ${year}">`
       + `${p.ppg.toFixed(1)} PPG</span>`;
}

// ═══════════════════════════════════════════════════
// INIT
// ═══════════════════════════════════════════════════
document.addEventListener("DOMContentLoaded", async () => {
  if (!LEAGUE) {
    document.getElementById("app").innerHTML =
      `<div class="error-msg">No league is set up at “/${escHtml(LEAGUE_SLUG)}/”. <a href="/">All leagues →</a></div>`;
    return;
  }
  renderShell();
  buildYearPills();
  // Fetch player map and season data in parallel
  await Promise.all([
    fetchAllSeasons(),
    fetchPlayerMap(),
  ]);
  // Build draft pick map after seasons are loaded (needs league IDs + roster maps)
  await buildDraftPickMap();
  buildOwnerDropdowns();
  loadStandings("alltime");
});

function buildYearPills() {
  const wrap = document.getElementById("standingsYearPills");
  Object.keys(LEAGUE_CONFIG.seasons).sort().forEach(yr => {
    const btn = document.createElement("button");
    btn.className = "year-pill";
    btn.textContent = yr;
    btn.onclick = () => loadStandings(yr, btn);
    wrap.appendChild(btn);
  });
}

async function apiFetch(path) {
  const res = await fetch(API_BASE + path);
  if (!res.ok) throw new Error(`API error ${res.status}: ${path}`);
  return res.json();
}

async function fetchPlayerMap() {
  try {
    const data = await fetch("/api/players").then(r => r.json());
    playerMap = data;
  } catch (e) {
    console.warn("Could not load player map:", e.message);
  }
}

async function buildDraftPickMap() {
  // Fetch rookie drafts (2023+) — startup draft (2022) uses different structure
  // 
  // The challenge: a traded pick's roster_id = original owner at time of trade,
  // but by draft day the pick may have changed hands again. Sleeper records the
  // FINAL owner's roster_id in the draft result, not the original.
  //
  // Solution: use draft_slot (stable, assigned at season start) as the bridge.
  // draft_order maps roster_id → their original draft slot for that season.
  // We build two maps:
  //   draftPickMap["season:round:slot"]   → resolved pick string (for traded picks)
  //   draftSlotMap["season:roster_id"]    → that roster's original draft slot
  // Every season with a draft id: dynasty rookie drafts (a startup season has none)
  // or each redraft season's full draft.
  const rookieDraftYears = Object.keys(LEAGUE_CONFIG.draftIds)
    .filter(y => LEAGUE_CONFIG.seasons[y]);

  for (const year of rookieDraftYears) {
    const lid = LEAGUE_CONFIG.seasons[year];
    try {
      const draftId = LEAGUE_CONFIG.draftIds?.[year];
      const draftUrl = draftId
        ? `/api/league/${lid}/draft?draftId=${draftId}`
        : `/api/league/${lid}/draft`;
      const data = await fetch(draftUrl).then(r => r.json());
      if (!data || !Array.isArray(data.picks)) continue;

      const { picks, draft_order } = data;
      // draft_order: { roster_id → original_slot }
      // Store so resolveDraftPick can look up a roster's slot
      if (draft_order) {
        Object.entries(draft_order).forEach(([rosterId, slot]) => {
          draftPickMap[`slot:${year}:${rosterId}`] = slot;
        });
      }

      // Group picks by round
      const picksByRound = {};
      picks.forEach(p => {
        if (!picksByRound[p.round]) picksByRound[p.round] = [];
        picksByRound[p.round].push(p);
      });
      Object.values(picksByRound).forEach(rnd => rnd.sort((a, b) => a.pick_no - b.pick_no));

      // Key each pick by season:round:draft_slot
      // draft_slot on the pick = the slot position used (may differ from original owner's slot if traded)
      picks.forEach(pick => {
        const slotInRound = pick.draft_slot; // 1-based position within round
        const slot = `${pick.round}.${String(slotInRound).padStart(2, '0')}`;
        const drafted = pick.player_id ? playerName(pick.player_id) : null;
        const key = `${year}:${pick.round}:${slotInRound}`;
        draftPickMap[key] = drafted ? `${year} ${slot} — ${drafted}` : `${year} ${slot}`;
        if (pick.player_id) draftPickMap[`pid:${key}`] = String(pick.player_id);
      });

    } catch(e) {
      console.warn(`Draft picks fetch failed for ${year}:`, e.message);
    }
  }
}

// Whose pick this originally was (pick.roster_id = original owner at time of trade),
// resolved to a display name via that season's (or the trade's season's) roster→owner map.
// Lets you judge a future pick's real value — a bad team's 1st is worth more than a good team's.
function resolvePickOwnerName(pick, tradeYear) {
  const tryYears = [pick.season, tradeYear].filter((y, i, arr) => y && arr.indexOf(y) === i);
  for (const yr of tryYears) {
    const sd = allSeasonData[yr];
    if (!sd) continue;
    const uid = sd.rosterUserMap[pick.roster_id];
    if (!uid) continue;
    const name = ownerMap[canonicalUserId(uid)]?.display_name;
    if (name) return name;
  }
  return null;
}

function resolveDraftPick(pick, tradeYear) {
  // Trade pick shape: { season, round, roster_id (original owner), owner_id, previous_owner_id }
  //
  // Step 1: look up the original owner's draft slot for that season
  // (stored as draftPickMap["slot:season:roster_id"])
  const originalSlot = draftPickMap[`slot:${pick.season}:${pick.roster_id}`];
  const ownerName = resolvePickOwnerName(pick, tradeYear);
  const ownerSuffix = ownerName ? ` (orig. ${ownerName})` : "";

  if (originalSlot !== undefined) {
    // Step 2: look up the pick at that slot in the actual draft
    const key = `${pick.season}:${pick.round}:${originalSlot}`;
    if (draftPickMap[key]) return draftPickMap[key]; // already drafted — the player name says it all
    // Draft hasn't happened yet — show slot-based label + whose original slot it is
    const slotStr = `${pick.round}.${String(originalSlot).padStart(2, '0')}`;
    return `${pick.season} ${slotStr}${ownerSuffix}`;
  }

  // Draft order not known yet (pick too far in the future) — round + whose original pick
  return `${pick.season} Round ${pick.round} Pick${ownerSuffix}`;
}

// Returns the sleeper player_id a traded pick converted into (drafted), or null if not yet drafted
function resolvePickPid(pick) {
  const originalSlot = draftPickMap[`slot:${pick.season}:${pick.roster_id}`];
  if (originalSlot === undefined) return null;
  return draftPickMap[`pid:${pick.season}:${pick.round}:${originalSlot}`] || null;
}

function playerName(playerId) {
  const p = playerMap[playerId];
  if (!p) return `Player #${playerId}`;
  const pos = p.position ? ` (${p.position})` : "";
  return `${p.full_name || playerId}${pos}`;
}

async function fetchAllSeasons() {
  const years = Object.keys(LEAGUE_CONFIG.seasons).sort();
  const usersSeen = {};

  for (const year of years) {
    const lid = LEAGUE_CONFIG.seasons[year];
    try {
      const [rosters, users, bracketData, loserBracket, leagueInfo] = await Promise.all([
        apiFetch(`/${lid}/rosters`),
        apiFetch(`/${lid}/users`),
        apiFetch(`/${lid}/winners_bracket`),
        apiFetch(`/${lid}/losers_bracket`).catch(() => []),
        apiFetch(`/${lid}/info`).catch(() => ({})),
      ]);

      // Fetch all 18 weeks of matchups in parallel
      const matchupWeeks = await Promise.all(
        Array.from({ length: 18 }, (_, i) =>
          apiFetch(`/${lid}/matchups/${i + 1}`).catch(() => [])
        )
      );

      users.forEach(u => {
        // OWNER_LABEL: "team" (dynasty — a team name sticks for years) or "user"
        // (redraft — team names churn every season; ESPN's display_name is the
        // owner's first + last name, from the worker).
        const rawName = OWNER_LABEL === "team"
          ? (u.metadata?.team_name || u.display_name || u.user_id)
          : (u.display_name || u.metadata?.team_name || u.user_id);
        const cuid = canonicalUserId(u.user_id);
        // Always store under the canonical user_id so legacy owners merge in
        if (!usersSeen[cuid]) {
          usersSeen[cuid] = {
            display_name: canonicalName(rawName),
            avatar: u.avatar,
          };
        } else {
          // For the canonical owner, always keep their own name (not the legacy name)
          if (cuid === u.user_id) {
            usersSeen[cuid].display_name = canonicalName(rawName);
          }
        }
      });

      const rosterUserMap = {};
      rosters.forEach(r => { rosterUserMap[r.roster_id] = r.owner_id; });

      // In-progress season: keep only weeks Sleeper has finished scoring, so a
      // half-played week can't land in records / all-play / H2H. Division titles
      // wait until the regular season is over (otherwise the current leader gets one).
      const st   = leagueInfo.settings || {};
      const live = !!leagueInfo.status && leagueInfo.status !== "complete";
      const scored = st.last_scored_leg || 0;
      if (live) matchupWeeks.forEach((_, i) => { if (i + 1 > scored) matchupWeeks[i] = []; });

      // Consolation games don't count for anything. In playoff weeks only championship-path
      // games (winners bracket, no placement tag or p=1 — not 3rd/5th place, not the losers
      // bracket) keep their matchup_id. The rest keep their row (player points still feed PPG)
      // with matchup_id null, which H2H, all-play and League Records all skip.
      const poStart = st.playoff_week_start || 15;
      const pairKey = (a, b) => [a, b].sort((x, y) => x - y).join("-");
      const champPairs = new Set((Array.isArray(bracketData) ? bracketData : [])
        .filter(m => m.t1 && m.t2 && (m.p == null || m.p === 1))
        .map(m => pairKey(m.t1, m.t2)));
      matchupWeeks.forEach((week, i) => {
        if (i + 1 < poStart || !Array.isArray(week)) return;
        const byMid = {};
        week.forEach(m => { if (m.matchup_id != null) (byMid[m.matchup_id] ||= []).push(m.roster_id); });
        week.forEach(m => {
          if (m.matchup_id == null) return;
          const pair = byMid[m.matchup_id];
          if (pair.length !== 2 || !champPairs.has(pairKey(pair[0], pair[1]))) m.matchup_id = null;
        });
      });
      const regSeasonDone = !live || scored >= (st.playoff_week_start || 15) - 1;

      allSeasonData[year] = { rosters, users, matchupWeeks, bracketData, loserBracket, leagueInfo, rosterUserMap, regSeasonDone };
    } catch (e) {
      console.warn(`Could not load season ${year}:`, e.message);
    }
  }

  ownerMap = usersSeen;
  allOwnerIds = Object.keys(usersSeen);
}

// ═══════════════════════════════════════════════════
// TABS
// ═══════════════════════════════════════════════════
function switchTab(tab, btn) {
  document.querySelectorAll(".panel").forEach(p => p.classList.remove("active"));
  document.querySelectorAll(".tab-btn").forEach(b => b.classList.remove("active"));
  document.getElementById("panel-" + tab).classList.add("active");
  btn.classList.add("active");
  if (tab === "records" && !recordsLoaded) { loadRecords(); recordsLoaded = true; }
  if (tab === "recap") rcOpen(IS_ESPN ? {
    espnKey: LEAGUE_CONFIG.espnKey,
    season: Math.max(...Object.keys(LEAGUE_CONFIG.seasons).map(Number)),
    leagueName: LEAGUE_CONFIG.name,
    ownerName: id => ownerMap[canonicalUserId(id)]?.display_name || id,
  } : { seasons: LEAGUE_CONFIG.seasons, players: () => playerMap });
}
let recordsLoaded = false;

// ═══════════════════════════════════════════════════
// STANDINGS
// ═══════════════════════════════════════════════════
// Compute all-play record for a set of years
// All-play = how you'd do if you played every other team each week
function computeAllPlay(years) {
  const ap = {}; // uid → { w, l }
  years.forEach(yr => {
    const sd = allSeasonData[yr];
    if (!sd) return;
    sd.matchupWeeks.forEach(weekMatchups => {
      if (!Array.isArray(weekMatchups) || weekMatchups.length < 2) return;
      // Only regular season weeks with real scores
      const entries = weekMatchups
        .filter(m => m.points > 0 && m.matchup_id !== null)
        .map(m => ({ uid: canonicalUserId(sd.rosterUserMap[m.roster_id]), pts: m.points }))
        .filter(e => e.uid);
      if (entries.length < 2) return;
      entries.forEach(e => {
        if (!ap[e.uid]) ap[e.uid] = { w: 0, l: 0 };
        entries.forEach(o => {
          if (o.uid === e.uid) return;
          if (e.pts > o.pts) ap[e.uid].w++;
          else if (e.pts < o.pts) ap[e.uid].l++;
        });
      });
    });
  });
  return ap;
}

let standingsSortCol = null;
let standingsSortDir = 1; // 1 = desc, -1 = asc

function loadStandings(year, btn) {
  document.querySelectorAll(".year-pill").forEach(p => p.classList.remove("active"));
  if (btn) btn.classList.add("active");
  standingsSortCol = null;
  renderStandings(year);
}

function renderStandings(year, sortCol, sortDir) {
  const container = document.getElementById("standingsContent");
  const years = year === "alltime"
    ? Object.keys(allSeasonData).sort()
    : (allSeasonData[year] ? [year] : []);

  if (years.length === 0) {
    container.innerHTML = `<div class="error-msg">No data available for this season yet.</div>`;
    return;
  }

  const records = {};
  // Track which years each uid was division champ, runner-up, 3rd place
  const yearDivChamps = {}; // yr → Set of uids
  const yearRunnerUp  = {}; // yr → uid
  const yearThird     = {}; // yr → uid

  years.forEach(yr => {
    const sd = allSeasonData[yr];
    if (!sd) return;

    // ── Division titles ──────────────────────────────────
    // Sleeper stores division as roster.settings.division (1-indexed)
    // Division winner = best record in each division group
    const divGroups = {};
    sd.rosters.forEach(r => {
      const div = r.settings?.division;
      if (!div) return;
      if (!divGroups[div]) divGroups[div] = [];
      divGroups[div].push(r);
    });
    const divChampRosters = new Set();
    if (sd.regSeasonDone) Object.values(divGroups).forEach(group => {
      if (group.length === 0) return;
      const winner = group.reduce((best, r) => {
        const bW = best.settings?.wins || 0, bPF = (best.settings?.fpts || 0) + (best.settings?.fpts_decimal || 0) / 100;
        const rW = r.settings?.wins || 0, rPF = (r.settings?.fpts || 0) + (r.settings?.fpts_decimal || 0) / 100;
        return (rW > bW || (rW === bW && rPF > bPF)) ? r : best;
      });
      divChampRosters.add(winner.roster_id);
    });
    yearDivChamps[yr] = new Set([...divChampRosters].map(rid => canonicalUserId(sd.rosterUserMap[rid])).filter(Boolean));

    // ── Playoff results from winners bracket ─────────────
    if (Array.isArray(sd.bracketData) && sd.bracketData.length > 0) {
      const maxRound = Math.max(...sd.bracketData.map(m => m.r || 0));
      const champMatch = sd.bracketData.find(m => m.r === maxRound && m.w);
      if (champMatch) {
        // Runner-up = loser of championship game
        const ruRid = champMatch.l;
        if (ruRid) yearRunnerUp[yr] = canonicalUserId(sd.rosterUserMap[ruRid]);
      }
    }

    // ── 3rd place from winners bracket ──────────────────
    // In Sleeper, the 3rd place game lives in the winners bracket, not the loser bracket
    // It's the match tagged with p=3, or alternatively the semi-final loser playoff
    // The winners bracket contains the championship game AND the 3rd place game
    if (Array.isArray(sd.bracketData) && sd.bracketData.length > 0) {
      const thirdMatch = sd.bracketData.find(m => m.p === 3 && m.w);
      if (thirdMatch?.w) yearThird[yr] = canonicalUserId(sd.rosterUserMap[thirdMatch.w]);
    }

    sd.rosters.forEach(r => {
      const rawUid = r.owner_id;
      if (!rawUid) return;
      const uid = canonicalUserId(rawUid);
      if (!records[uid]) records[uid] = {
        wins: 0, losses: 0, ties: 0, pf: 0, pa: 0,
        championships: 0, runnerUps: 0, thirdPlaces: 0,
        divTitles: 0, finalsApps: 0,
        playoffApps: 0,
        seasonNames: {}, seasonAwards: {}
      };
      records[uid].wins   += (r.settings?.wins || 0);
      records[uid].losses += (r.settings?.losses || 0);
      records[uid].ties   += (r.settings?.ties || 0);
      const pf = (r.settings?.fpts || 0) + (r.settings?.fpts_decimal || 0) / 100;
      const pa = (r.settings?.fpts_against || 0) + (r.settings?.fpts_against_decimal || 0) / 100;
      records[uid].pf += pf;
      records[uid].pa += pa;
      records[uid].seasonNames[yr] = displayNameForSeason(rawUid, yr);
      records[uid].seasonAwards[yr] = [];
    });

    // ── Assign awards ─────────────────────────────────────
    if (Array.isArray(sd.bracketData) && sd.bracketData.length > 0) {
      const maxRound = Math.max(...sd.bracketData.map(m => m.r || 0));
      const champMatch = sd.bracketData.find(m => m.r === maxRound && m.w);
      if (champMatch?.w) {
        const champUid = canonicalUserId(sd.rosterUserMap[champMatch.w]);
        if (champUid && records[champUid]) {
          records[champUid].championships += 1;
          records[champUid].finalsApps    += 1;
          records[champUid].seasonAwards[yr]?.push("champ");
        }
        const ruUid = yearRunnerUp[yr];
        if (ruUid && records[ruUid]) {
          records[ruUid].runnerUps  += 1;
          records[ruUid].finalsApps += 1;
          records[ruUid].seasonAwards[yr]?.push("runnerup");
        }
      }

      // Playoff appearances — any roster that appears in the winners bracket,
      // but only once the bracket has actually been played. Sleeper pre-seeds
      // future brackets (t1/t2 set, w/l null) — those must not count.
      const bracketPlayed = sd.bracketData.some(m => m.w);
      if (bracketPlayed) {
        const playoffRosterIds = new Set();
        sd.bracketData.forEach(m => {
          if (m.t1) playoffRosterIds.add(m.t1);
          if (m.t2) playoffRosterIds.add(m.t2);
          if (m.w)  playoffRosterIds.add(m.w);
          if (m.l)  playoffRosterIds.add(m.l);
        });
        playoffRosterIds.forEach(rid => {
          const pUid = canonicalUserId(sd.rosterUserMap[rid]);
          if (pUid && records[pUid]) records[pUid].playoffApps += 1;
        });
      }
    }

    const thirdUid = yearThird[yr];
    if (thirdUid && records[thirdUid]) {
      records[thirdUid].thirdPlaces += 1;
      records[thirdUid].seasonAwards[yr]?.push("third");
    }

    yearDivChamps[yr]?.forEach(uid => {
      if (records[uid]) {
        records[uid].divTitles += 1;
        records[uid].seasonAwards[yr]?.push("div");
      }
    });
  });

  // Compute all-play and attach to records
  const ap = computeAllPlay(years);
  Object.entries(records).forEach(([uid, rec]) => {
    const a = ap[uid] || { w: 0, l: 0 };
    rec.apW = a.w; rec.apL = a.l;
    const apTotal = (a.w + a.l) || 1;
    const total = (rec.wins + rec.losses + rec.ties) || 1;
    rec.apPct = a.w / apTotal;
    rec.wpPct = (rec.wins + rec.ties / 2) / total;   // a tie is half a win
    rec.diff  = rec.wpPct - rec.apPct; // positive = overachiever
    const gp = rec.wins + rec.losses + rec.ties; // regular-season games — what PF/PA cover
    rec.pfpg = gp ? rec.pf / gp : 0;
    rec.papg = gp ? rec.pa / gp : 0;
  });

  // Default sort: win%
  const col = sortCol || "wpPct";
  const dir = sortDir ?? -1;
  const sorted = Object.entries(records).sort((a, b) => {
    const va = a[1][col] ?? 0, vb = b[1][col] ?? 0;
    return (vb - va) * dir * -1;
  });

  const showAllTime = year === "alltime";
  // T column only for a league that has ever had a tie (same columns in every view)
  const anyTies = Object.values(allSeasonData).some(sd => (sd.rosters || []).some(r => (r.settings?.ties || 0) > 0));
  // One list drives the header AND every row, so they can't drift apart.
  // tier: "sec" drops out under 900px, "ter" under 560px — narrow screens keep the
  // essentials instead of scrolling sideways.
  const dash = v => v || "—";
  const pct  = v => `${(v * 100).toFixed(1)}%`;
  const cols = [
    { key: "name",   label: "Owner" },
    { key: "wins",   label: "W",       cell: r => r.wins },
    { key: "losses", label: "L",       cell: r => r.losses },
    ...(anyTies ? [{ key: "ties", label: "T", cell: r => r.ties }] : []),
    { key: "wpPct",  label: "Win%",    cell: r => pct(r.wpPct), cls: "win-pct" },
    { key: "pf",     label: "PF",      cell: r => r.pf.toFixed(2),   tier: "ter" },
    { key: "pa",     label: "PA",      cell: r => r.pa.toFixed(2),   tier: "sec" },
    { key: "pfpg",   label: "PF/G",    cell: r => r.pfpg.toFixed(2) },
    { key: "papg",   label: "PA/G",    cell: r => r.papg.toFixed(2), tier: "sec" },
    { key: "apW",    label: "AP W",    cell: r => r.apW, tier: "sec" },
    { key: "apL",    label: "AP L",    cell: r => r.apL, tier: "sec" },
    { key: "apPct",  label: "AP Win%", cell: r => pct(r.apPct), cls: "win-pct" },
    { key: "diff",   label: "+/−",     tier: "ter", cell: r => r.diff >= 0
        ? `<span style="color:var(--green-light)">+${(r.diff * 100).toFixed(1)}%</span>`
        : `<span style="color:var(--red)">${(r.diff * 100).toFixed(1)}%</span>` },
    ...(showAllTime ? [
      { key: "championships", label: "Titles",   cell: r => dash(r.championships) },
      { key: "playoffApps",   label: "Playoffs", cell: r => dash(r.playoffApps) },
      ...(LEAGUE_CONFIG.hasDivisions ? [{ key: "divTitles", label: "Div", cell: r => dash(r.divTitles), tier: "ter" }] : []),
      { key: "finalsApps",    label: "Finals",   cell: r => dash(r.finalsApps), tier: "ter" },
    ] : []),
  ];
  const tierCls = c => c.tier ? `col-${c.tier}` : "";

  const thHTML = cols.map(c => {
    if (!c.cell) return `<th>${c.label}</th>`;
    const active = col === c.key;
    const cls = [tierCls(c), active ? (dir === -1 ? "sort-desc" : "sort-asc") : ""].filter(Boolean).join(" ");
    return `<th class="${cls}" onclick="sortStandings('${year}','${c.key}',${active ? dir * -1 : -1})">${c.label}</th>`;
  }).join("");

  let html = `<div class="standings-wrap"><table class="standings-table"><thead><tr>${thHTML}</tr></thead><tbody>`;

  sorted.forEach(([uid, rec], i) => {
    const name = year !== "alltime" && rec.seasonNames?.[year]
      ? rec.seasonNames[year]
      : (ownerMap[uid]?.display_name || uid);
    let badge = `<span class="rank-badge">${i + 1}</span>`;
    if (i === 0) badge = `<span class="rank-badge gold">1</span>`;
    if (i === 1) badge = `<span class="rank-badge silver">2</span>`;
    if (i === 2) badge = `<span class="rank-badge bronze">3</span>`;

    // Awards shown next to name
    let awards = "";
    if (showAllTime) {
      if (rec.championships > 0) awards += `<span class="champ-tag" title="League Champion">🏆${rec.championships > 1 ? "×"+rec.championships : ""}</span>`;
      if (rec.runnerUps > 0)     awards += `<span class="champ-tag" title="Runner-up" style="filter:grayscale(0.3)">🥈${rec.runnerUps > 1 ? "×"+rec.runnerUps : ""}</span>`;
      if (rec.thirdPlaces > 0)   awards += `<span class="champ-tag" title="3rd Place" style="filter:grayscale(0.5)">🥉${rec.thirdPlaces > 1 ? "×"+rec.thirdPlaces : ""}</span>`;
    } else {
      // Individual year — show award icons inline with name
      const awards_yr = rec.seasonAwards?.[year] || [];
      if (awards_yr.includes("champ"))    awards += `<span class="champ-tag" title="League Champion">🏆</span>`;
      if (awards_yr.includes("runnerup")) awards += `<span class="champ-tag" title="Runner-up">🥈</span>`;
      if (awards_yr.includes("third"))    awards += `<span class="champ-tag" title="3rd Place">🥉</span>`;
      if (awards_yr.includes("div"))      awards += `<span class="champ-tag" title="Division Champion" style="background:var(--brown-mid)">🏅</span>`;
    }

    html += `<tr><td>${badge}${name}${awards}</td>`
      + cols.slice(1).map(c => `<td class="${[c.cls, tierCls(c)].filter(Boolean).join(" ")}">${c.cell(rec)}</td>`).join("")
      + `</tr>`;
  });

  html += `</tbody></table></div>`;
  container.innerHTML = html;
  // Store current year for re-sort
  container.dataset.year = year;
}

function sortStandings(year, col, dir) {
  standingsSortCol = col;
  standingsSortDir = dir;
  renderStandings(year, col, dir);
}

// ═══════════════════════════════════════════════════
// OWNER DROPDOWNS
// ═══════════════════════════════════════════════════
function buildOwnerDropdowns() {
  const selects = ["h2hOwner1", "h2hOwner2", "tradeOwner1", "tradeOwner2"];
  const owners = allOwnerIds
    .map(id => ({ id, name: ownerMap[id]?.display_name || id }))
    .sort((a, b) => a.name.localeCompare(b.name));

  selects.forEach(sid => {
    const el = document.getElementById(sid);
    owners.forEach(o => {
      const opt = document.createElement("option");
      opt.value = o.id;
      opt.textContent = o.name;
      el.appendChild(opt);
    });
  });
}

// ═══════════════════════════════════════════════════
// HEAD TO HEAD
// ═══════════════════════════════════════════════════
function loadH2H() {
  const uid1 = document.getElementById("h2hOwner1").value;
  const uid2 = document.getElementById("h2hOwner2").value;
  const container = document.getElementById("h2hContent");

  if (!uid1 || !uid2)    { showToast("Please select two owners"); return; }
  if (uid1 === uid2)     { showToast("Select two different owners"); return; }

  const name1 = ownerMap[uid1]?.display_name || uid1;
  const name2 = ownerMap[uid2]?.display_name || uid2;

  const matchups = [];
  let w1 = 0, w2 = 0, ties = 0, totalPF1 = 0, totalPF2 = 0;

  Object.entries(allSeasonData).sort().forEach(([year, sd]) => {
    // Find rosters accounting for ownership merges (legacy user_id may own roster in early seasons)
    const uid1Ids = [uid1, ...OWNERSHIP_MERGES.filter(m => m.canonicalUserId === uid1).map(m => m.legacyUserId)];
    const uid2Ids = [uid2, ...OWNERSHIP_MERGES.filter(m => m.canonicalUserId === uid2).map(m => m.legacyUserId)];
    const r1 = sd.rosters.find(r => uid1Ids.includes(r.owner_id));
    const r2 = sd.rosters.find(r => uid2Ids.includes(r.owner_id));
    if (!r1 || !r2) return;

    sd.matchupWeeks.forEach((weekMatchups, weekIdx) => {
      if (!Array.isArray(weekMatchups)) return;
      const m1 = weekMatchups.find(m => m.roster_id === r1.roster_id);
      const m2 = weekMatchups.find(m => m.roster_id === r2.roster_id);
      // Must be in same matchup_id (i.e. they actually faced each other)
      if (!m1 || !m2 || m1.matchup_id !== m2.matchup_id || m1.matchup_id === null) return;

      const pts1 = m1.points || 0;
      const pts2 = m2.points || 0;
      totalPF1 += pts1; totalPF2 += pts2;
      const won1 = pts1 > pts2, tie = pts1 === pts2;   // a tie is nobody's win
      if (tie) ties++; else if (won1) w1++; else w2++;
      matchups.push({ year, week: weekIdx + 1, pts1, pts2, won1, tie });
    });
  });

  const total = w1 + w2 + ties;
  const rec = (a, b) => `${a}–${b}${ties ? `–${ties}` : ""}`;
  const winPct = w => total > 0 ? ((w + ties / 2) / total * 100).toFixed(1) : "—";   // tie = half a win

  let html = `
    <div class="h2h-scoreboard">
      <div class="h2h-banner">
        <div class="h2h-owner">
          <div class="h2h-owner-name">${name1}</div>
          <div class="h2h-owner-record">${rec(w1, w2)}</div>
        </div>
        <div class="h2h-divider">ALL TIME<br/>RECORD</div>
        <div class="h2h-owner">
          <div class="h2h-owner-name">${name2}</div>
          <div class="h2h-owner-record">${rec(w2, w1)}</div>
        </div>
      </div>
      <div class="h2h-stats-grid">
        <div class="h2h-stat">
          <div class="h2h-stat-label">Total Matchups</div>
          <div class="h2h-stat-val highlight">${total}</div>
        </div>
        <div class="h2h-stat">
          <div class="h2h-stat-label">${name1} Win%</div>
          <div class="h2h-stat-val">${winPct(w1)}%</div>
        </div>
        <div class="h2h-stat">
          <div class="h2h-stat-label">${name2} Win%</div>
          <div class="h2h-stat-val">${winPct(w2)}%</div>
        </div>
        <div class="h2h-stat">
          <div class="h2h-stat-label">${name1} Avg PF</div>
          <div class="h2h-stat-val">${total > 0 ? (totalPF1/total).toFixed(2) : "—"}</div>
        </div>
        <div class="h2h-stat">
          <div class="h2h-stat-label">${name2} Avg PF</div>
          <div class="h2h-stat-val">${total > 0 ? (totalPF2/total).toFixed(2) : "—"}</div>
        </div>
        <div class="h2h-stat">
          <div class="h2h-stat-label">Series Leader</div>
          <div class="h2h-stat-val highlight">${w1 > w2 ? name1 : w2 > w1 ? name2 : "Tied"}</div>
        </div>
      </div>
    </div>
    <div class="section-head" style="margin-top:24px">
      <h2 style="font-size:1rem">Matchup Log</h2>
      <div class="section-head-line"></div>
    </div>
    <div class="matchup-list">`;

  if (matchups.length === 0) {
    html += `</div><div class="placeholder-state"><p>These two owners have never faced each other.</p></div>`;
  } else {
    [...matchups].reverse().forEach(m => {
      html += `
        <div class="matchup-item ${m.tie ? "tie" : m.won1 ? "win" : "loss"}">
          <span class="matchup-week">${m.year} · Wk ${m.week}</span>
          <span class="matchup-score">${name1} <strong>${m.pts1.toFixed(2)}</strong> — <strong>${m.pts2.toFixed(2)}</strong> ${name2}</span>
          <span class="matchup-result ${m.tie ? "T" : m.won1 ? "W" : "L"}">${m.tie ? "TIE" : `${m.won1 ? name1 : name2} WIN`}</span>
        </div>`;
    });
    html += `</div>`;
  }

  container.innerHTML = html;
}

// ═══════════════════════════════════════════════════
// TRADES
// ═══════════════════════════════════════════════════
// ── Trade helpers ────────────────────────────────────────
// One traded asset → { label, pid }. pid is the sleeper player id when known
// (direct player adds, or a traded pick that has since been drafted), so the
// renderer can attach that player's in-league PPG for the trade's season.
function tradeAssetsForSide(tx, sideRid, tradeYear) {
  const players = Object.entries(tx.adds || {})
    .filter(([, rid]) => rid === sideRid)
    .map(([pid]) => ({ label: playerName(pid), pid }));
  const picks = (tx.draft_picks || [])
    .filter(p => p.owner_id === sideRid)
    .map(p => ({ label: resolveDraftPick(p, tradeYear), pid: resolvePickPid(p) }));
  return [...players, ...picks];
}

// Total in-league fantasy points a side received in the trade's season — a rough
// "who won" proxy for a redraft trade (picks count via the player they became).
function sideSeasonPoints(assets, year) {
  return assets.reduce((sum, a) => {
    const p = playerPpg(year, a.pid);
    return sum + (p ? p.pts : 0);
  }, 0);
}

// ── Per-format trade card views ──────────────────────────
// Both return { cls1, cls2 (" win" | " lose" | " even" | ""), list1, list2 (<li>s),
// foot1, foot2 (value line under each side), caption }.
const NO_ASSETS = "<li><em>No players or picks</em></li>";

// Dynasty: FantasyCalc then → now, consolidation premium, winner by current value
function tradeMarketView(t, assets1, assets2) {
  const tx = t.tx;
  const frozenRec = tradeValueCache[t.lid]?.[tx.transaction_id];
  const v1 = computeSideValue(tx, t.r1id, frozenRec);
  const v2 = computeSideValue(tx, t.r2id, frozenRec);
  // % only when both ends are FantasyCalc (same scale); DP→FC has no meaningful %.
  const showDelta = frozenRec?.source === "FC";
  // Consolidation premium boosts the side getting fewer pieces, then we pick a winner
  // by current (hindsight) value. Both sides' "now" are FC, so comparable.
  const { p1, p2 } = consolidationBoost(assets1.length, assets2.length);
  let cls1 = "", cls2 = "";
  if (v1.hasNow && v2.hasNow) {
    const adj1 = v1.now * (1 + p1 / 100), adj2 = v2.now * (1 + p2 / 100);
    const hi = Math.max(adj1, adj2), lo = Math.min(adj1, adj2);
    if (hi > 0 && (hi - lo) / hi <= 0.10) {
      cls1 = cls2 = " even";          // within 10% → no real winner, both green
    } else if (adj1 !== adj2) {
      cls1 = adj1 > adj2 ? " win" : " lose";
      cls2 = adj2 > adj1 ? " win" : " lose";
    }
  }
  const list = a => a.length ? a.map(x => `<li>${x.label}</li>`).join("") : NO_ASSETS;
  return {
    cls1, cls2, list1: list(assets1), list2: list(assets2),
    foot1: valueBarHtml(v1, showDelta, p1), foot2: valueBarHtml(v2, showDelta, p2),
    caption: marketSourceCaption(frozenRec),
  };
}

// Redraft: in-league PPG per player, winner by total points that season (picks
// via the player they became). Only called when both sides scored and the gap > 10%.
function tradePpgView(t, assets1, assets2) {
  const pts1 = sideSeasonPoints(assets1, t.year);
  const pts2 = sideSeasonPoints(assets2, t.year);
  let cls1 = "", cls2 = "";
  if (pts1 > 0 && pts2 > 0) {
    const hi = Math.max(pts1, pts2), lo = Math.min(pts1, pts2);
    if ((hi - lo) / hi <= 0.10) cls1 = cls2 = " even";
    else { cls1 = pts1 > pts2 ? " win" : " lose"; cls2 = pts2 > pts1 ? " win" : " lose"; }
  }
  const list = a => a.length ? a.map(x => `<li>${x.label}${ppgChip(t.year, x.pid)}</li>`).join("") : NO_ASSETS;
  const total = pts => pts > 0
    ? `<div class="trade-value"><span class="tv-now">${pts.toFixed(1)} total pts in ${t.year}</span></div>` : "";
  return {
    cls1, cls2, list1: list(assets1), list2: list(assets2), foot1: total(pts1), foot2: total(pts2),
    caption: `PPG = that player's points per scoring week in this league, ${t.year} season`,
  };
}

async function loadTrades() {
  const uid1 = document.getElementById("tradeOwner1").value;
  const uid2 = document.getElementById("tradeOwner2").value;
  const container = document.getElementById("tradesContent");
  const singleMode = !uid2; // no second owner = show all trades for owner 1

  if (!uid1) { showToast("Please select at least one owner"); return; }
  if (!singleMode && uid1 === uid2) { showToast("Select two different owners"); return; }

  const name1 = ownerMap[uid1]?.display_name || uid1;
  const name2 = uid2 ? (ownerMap[uid2]?.display_name || uid2) : null;

  container.innerHTML = `<div class="loading"><div class="spinner"></div><br/>Searching the trade ledger…</div>`;

  const foundTrades = [];

  for (const [year, sd] of Object.entries(allSeasonData)) {
    const uid1Ids = [uid1, ...OWNERSHIP_MERGES.filter(m => m.canonicalUserId === uid1).map(m => m.legacyUserId)];
    const r1 = sd.rosters.find(r => uid1Ids.includes(r.owner_id));
    if (!r1) continue;

    let r2 = null;
    if (!singleMode) {
      const uid2Ids = [uid2, ...OWNERSHIP_MERGES.filter(m => m.canonicalUserId === uid2).map(m => m.legacyUserId)];
      r2 = sd.rosters.find(r => uid2Ids.includes(r.owner_id));
      if (!r2) continue;
    }

    const lid = LEAGUE_CONFIG.seasons[year];
    try {
      const trades = await apiFetch(`/${lid}/trades`);
      trades.forEach(tx => Object.assign(playerMap, tx._players || {}));   // ESPN player names
      trades.forEach(tx => {
        const rids = tx.roster_ids || [];
        if (!rids.includes(r1.roster_id)) return;
        if (!singleMode && !rids.includes(r2.roster_id)) return;

        if (singleMode) {
          // Find the "other" roster(s) in this trade
          const otherRids = rids.filter(id => id !== r1.roster_id);
          otherRids.forEach(otherRid => {
            // Look up which owner this roster belongs to
            const otherRawUid = sd.rosterUserMap[otherRid];
            const otherUid = otherRawUid ? canonicalUserId(otherRawUid) : null;
            const otherName = otherUid ? (ownerMap[otherUid]?.display_name || otherUid) : `Roster ${otherRid}`;
            foundTrades.push({ year, lid, tx, r1id: r1.roster_id, r2id: otherRid, name2: otherName });
          });
        } else {
          foundTrades.push({ year, lid, tx, r1id: r1.roster_id, r2id: r2.roster_id, name2 });
        }
      });
    } catch (e) {
      console.warn(`Trade fetch failed for ${year}:`, e.message);
    }
  }

  if (foundTrades.length === 0) {
    const msg = singleMode
      ? `${name1} has no trades on record.`
      : `${name1} and ${name2} have never traded with each other.`;
    container.innerHTML = `<div class="placeholder-state"><div class="icon">🤝</div><p>${msg}</p></div>`;
    return;
  }

  foundTrades.sort((a, b) => (b.tx.status_updated || 0) - (a.tx.status_updated || 0));

  if (IS_DYNASTY) {
    // Market data: live FC ("now") once + frozen day-of values per involved league
    await loadFcToday();
    const lids = [...new Set(foundTrades.map(t => t.lid))];
    await Promise.all(lids.map(loadTradeValues));
  }

  let html = `<div class="trade-timeline">`;

  foundTrades.forEach((t, idx) => {
    const tx = t.tx;
    const tName2 = t.name2;
    const date = tx.status_updated
      ? new Date(tx.status_updated).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" })
      : t.year;

    const assets1 = tradeAssetsForSide(tx, t.r1id, t.year);
    const assets2 = tradeAssetsForSide(tx, t.r2id, t.year);
    const v = IS_DYNASTY ? tradeMarketView(t, assets1, assets2) : tradePpgView(t, assets1, assets2);
    const { cls1, cls2 } = v;

    html += `
      <div class="trade-item">
        <div class="trade-timeline-line">
          <div class="trade-dot"></div>
          ${idx < foundTrades.length - 1 ? '<div class="trade-line-seg"></div>' : ""}
        </div>
        <div class="trade-card">
          <div class="trade-date">Trade · ${date}</div>
          <div class="trade-row">
            <div class="trade-side${cls1}">
              <span class="trade-side-label gets">${name1} receives</span>
              <div class="trade-owner">${name1}</div>
              <ul class="trade-assets">${v.list1}</ul>
              ${v.foot1}
            </div>
            <div class="trade-arrow">⇄</div>
            <div class="trade-side${cls2}">
              <span class="trade-side-label gets">${tName2} receives</span>
              <div class="trade-owner">${tName2}</div>
              <ul class="trade-assets">${v.list2}</ul>
              ${v.foot2}
            </div>
          </div>
          ${v.caption ? `<div class="trade-market-src">${v.caption}</div>` : ""}
        </div>
      </div>`;
  });

  html += `</div>`;
  container.innerHTML = html;
}

// ═══════════════════════════════════════════════════
// LEAGUE RECORDS
// ═══════════════════════════════════════════════════
function loadRecords() {
  const container = document.getElementById("recordsContent");

  // Gather all individual game scores and streaks
  const allGames = [];       // { uid, name, year, week, pts, oppPts, win }
  const streaks = {};        // uid → { cur, curType, maxWin, maxLoss, curStart, maxWinStart, maxLossStart }

  Object.entries(allSeasonData).sort().forEach(([year, sd]) => {
    // Build a week-by-week chronological list of results per owner
    sd.matchupWeeks.forEach((weekMatchups, weekIdx) => {
      if (!Array.isArray(weekMatchups)) return;
      const week = weekIdx + 1;

      // Group by matchup_id to find opponents
      const byMatchup = {};
      weekMatchups.forEach(m => {
        if (!m.matchup_id || m.points === 0) return;
        if (!byMatchup[m.matchup_id]) byMatchup[m.matchup_id] = [];
        byMatchup[m.matchup_id].push(m);
      });

      Object.values(byMatchup).forEach(pair => {
        if (pair.length !== 2) return;
        const [a, b] = pair;
        const uidA = canonicalUserId(sd.rosterUserMap[a.roster_id]);
        const uidB = canonicalUserId(sd.rosterUserMap[b.roster_id]);
        if (!uidA || !uidB) return;
        const nameA = ownerMap[uidA]?.display_name || uidA;
        const nameB = ownerMap[uidB]?.display_name || uidB;

        const multi = (a.weeks || 1) > 1;   // ESPN two-week playoff round — counts as a game, not a single-week score
        allGames.push({ uid: uidA, name: nameA, year, week, pts: a.points, oppPts: b.points, win: a.points > b.points, opp: nameB, multi });
        allGames.push({ uid: uidB, name: nameB, year, week, pts: b.points, oppPts: a.points, win: b.points > a.points, opp: nameA, multi });
      });
    });
  });

  // Compute streaks per owner in chronological order
  const gamesByOwner = {};
  allGames.forEach(g => {
    if (!gamesByOwner[g.uid]) gamesByOwner[g.uid] = [];
    gamesByOwner[g.uid].push(g);
  });

  const streakData = {}; // uid → { maxWin, maxLoss, maxWinCtx, maxLossCtx }
  Object.entries(gamesByOwner).forEach(([uid, games]) => {
    let curWin = 0, curLoss = 0;
    let maxWin = 0, maxLoss = 0;
    let maxWinCtx = "", maxLossCtx = "";
    games.forEach(g => {
      if (g.pts === g.oppPts) { curWin = 0; curLoss = 0; return; }   // a tie ends both streaks
      if (g.win) {
        curWin++; curLoss = 0;
        if (curWin > maxWin) { maxWin = curWin; maxWinCtx = `${g.year} Wk ${g.week}`; }
      } else {
        curLoss++; curWin = 0;
        if (curLoss > maxLoss) { maxLoss = curLoss; maxLossCtx = `${g.year} Wk ${g.week}`; }
      }
    });
    streakData[uid] = { maxWin, maxLoss, maxWinCtx, maxLossCtx, name: ownerMap[uid]?.display_name || uid };
  });

  // Top 10 win streaks
  const topWinStreaks = Object.values(streakData)
    .sort((a, b) => b.maxWin - a.maxWin).slice(0, 10);

  // Top 10 loss streaks
  const topLossStreaks = Object.values(streakData)
    .sort((a, b) => b.maxLoss - a.maxLoss).slice(0, 10);

  // Unique games (dedupe — each matchup appears twice in allGames)
  const uniqueGames = allGames.filter(g => g.pts >= g.oppPts); // keep higher scorer's entry

  // Top 10 scoring seasons (total PF per owner per year)
  const seasonPF = {}; // "uid:year" → { name, year, totalPF }
  Object.entries(allSeasonData).forEach(([year, sd]) => {
    sd.rosters.forEach(r => {
      const rawUid = r.owner_id;
      if (!rawUid) return;
      const uid = canonicalUserId(rawUid);
      const pf = (r.settings?.fpts || 0) + (r.settings?.fpts_decimal || 0) / 100;
      if (pf === 0) return;
      const key = `${uid}:${year}`;
      seasonPF[key] = { name: ownerMap[uid]?.display_name || uid, year, totalPF: pf };
    });
  });
  const topScoringSeasons = Object.values(seasonPF)
    .sort((a, b) => b.totalPF - a.totalPF).slice(0, 10);

  // Top 10 highest scores
  const scoreGames = allGames.filter(g => !g.multi);   // single-week scores only
  const topScores = [...scoreGames]
    .sort((a, b) => b.pts - a.pts).slice(0, 10);

  // Top 10 lowest scores (> 0)
  const lowScores = [...scoreGames]
    .filter(g => g.pts > 0)
    .sort((a, b) => a.pts - b.pts).slice(0, 10);

  // Top 10 blowouts (biggest margin)
  const blowouts = [...scoreGames]
    .filter(g => g.win)
    .sort((a, b) => (b.pts - b.oppPts) - (a.pts - a.oppPts)).slice(0, 10);

  // Top 10 closest games (smallest margin, winner's perspective)
  const closest = [...scoreGames]
    .filter(g => g.win)
    .sort((a, b) => (a.pts - a.oppPts) - (b.pts - b.oppPts)).slice(0, 10);

  function rankIcon(i) {
    return i === 0 ? "🥇" : i === 1 ? "🥈" : i === 2 ? "🥉" : `${i+1}.`;
  }

  function streakList(items, key, ctx) {
    return items.map((s, i) => `
      <li>
        <span class="records-rank">${rankIcon(i)}</span>
        <span class="records-name">${s.name}</span>
        <span class="records-meta">ended ${s[ctx]}</span>
        <span class="records-val">${s[key]} in a row</span>
      </li>`).join("");
  }

  function scoreList(items) {
    return items.map((g, i) => `
      <li>
        <span class="records-rank">${rankIcon(i)}</span>
        <span class="records-name">${g.name}</span>
        <span class="records-meta">${g.year} Wk ${g.week} vs ${g.opp}</span>
        <span class="records-val">${g.pts.toFixed(2)}</span>
      </li>`).join("");
  }

  function marginList(items, label) {
    return items.map((g, i) => {
      const margin = Math.abs(g.pts - g.oppPts).toFixed(2);
      const score = `${g.pts.toFixed(2)}–${g.oppPts.toFixed(2)}`;
      return `
      <li>
        <span class="records-rank">${rankIcon(i)}</span>
        <span class="records-name">${g.name} def. ${g.opp}</span>
        <span class="records-meta">${g.year} Wk ${g.week} · ${score}</span>
        <span class="records-val">${label === "blowout" ? `+${margin}` : margin}</span>
      </li>`;
    }).join("");
  }

  function seasonList(items) {
    return items.map((s, i) => `
      <li>
        <span class="records-rank">${rankIcon(i)}</span>
        <span class="records-name">${s.name}</span>
        <span class="records-meta">${s.year} season</span>
        <span class="records-val">${s.totalPF.toFixed(2)}</span>
      </li>`).join("");
  }

  container.innerHTML = `
    <div class="records-grid">
      <div class="records-card">
        <div class="records-card-head">🔥 Longest Win Streaks</div>
        <ul class="records-list">${streakList(topWinStreaks, "maxWin", "maxWinCtx")}</ul>
      </div>
      <div class="records-card">
        <div class="records-card-head">❄️ Longest Losing Streaks</div>
        <ul class="records-list">${streakList(topLossStreaks, "maxLoss", "maxLossCtx")}</ul>
      </div>
      <div class="records-card">
        <div class="records-card-head">💥 Top 10 Highest Scores</div>
        <ul class="records-list">${scoreList(topScores)}</ul>
      </div>
      <div class="records-card">
        <div class="records-card-head">😬 Top 10 Lowest Scores</div>
        <ul class="records-list">${scoreList(lowScores)}</ul>
      </div>
      <div class="records-card">
        <div class="records-card-head">💣 Top 10 Blowouts</div>
        <ul class="records-list">${marginList(blowouts, "blowout")}</ul>
      </div>
      <div class="records-card">
        <div class="records-card-head">🤏 Top 10 Closest Games</div>
        <ul class="records-list">${marginList(closest, "close")}</ul>
      </div>
      <div class="records-card">
        <div class="records-card-head">📈 Top 10 Scoring Seasons</div>
        <ul class="records-list">${seasonList(topScoringSeasons)}</ul>
      </div>
    </div>`;
}

// ═══════════════════════════════════════════════════
// TOAST
// ═══════════════════════════════════════════════════
function showToast(msg) {
  const t = document.getElementById("toast");
  t.textContent = msg;
  t.classList.add("show");
  setTimeout(() => t.classList.remove("show"), 3000);
}
