// ════════════════════════════════════════════════════════════════════════════
// League Recap — one copy for every league page (Sleeper and ESPN).
//
//   • Playoff picture  — teams currently holding a playoff seed
//   • In the hunt      — outside the seeds, not mathematically eliminated
//   • Eliminated       — can't reach a playoff seed even winning out
//   • Projected draft order (dynasty only)
//
// Playoff % is sleeper-helper's simulation, not a copy of it: the engine files
// (shared-utils.js + league-engine.js) are loaded from helper.ffhistorian.com
// on first use, so the odds here are the same numbers League Summaries and the
// League Analyzer show. Inputs are fed exactly as the analyzer feeds them —
// simulate from BANKED weeks (games already in the W/L record), weekly Sleeper
// projections scored with the league's own scoring, median leagues play two
// games a week.
//
// Everything that decides a number is pure (rcBuild*) and runs in Node for
// testing; rcOpen() is the only entry point a page calls.
//
// Page hook:  switchTab(...) { if (tab === "recap") rcOpen({...}); }
//   Sleeper:  rcOpen({ seasons: LEAGUE_CONFIG.seasons, players: () => playerMap })
//   ESPN:     rcOpen({ espnKey: "eliteffl", season: 2026, ownerName: id => nickname(id) })
// ════════════════════════════════════════════════════════════════════════════

const RC_HELPER   = "https://helper.ffhistorian.com";
const RC_ENGINE_V = "20261111"; // bump with helper's ?v= stamp when the engine changes
const RC_SIMS     = 10000;

const RC = { opts: null, model: null, loading: false, round: 1, error: null };

// ── Small helpers ───────────────────────────────────────────────────────────

function rcEsc(s) {
  return String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}
const rcRec  = r => r ? `${r.w}-${r.l}${r.t ? `-${r.t}` : ""}` : "—";
const rcPts  = v => v == null ? "—" : Number(v).toLocaleString(undefined, { minimumFractionDigits: 1, maximumFractionDigits: 1 });
// 100% / 0% are reserved for a mathematical clinch / elimination — a team the
// simulation simply never saw miss (or make) it reads >99% / <1%.
function rcPct(f, t) {
  if (t?.playoff) return "100%";
  if (t?.eliminated) return "0%";
  if (f == null) return "—";
  if (f > 0.995) return ">99%";
  if (f < 0.005) return "<1%";
  return `${Math.round(f * 100)}%`;
}
// Name key shared by ESPN roster names and Sleeper's player map.
function rcNameKey(s) {
  return String(s || "").toLowerCase()
    .replace(/[.'’]/g, "").replace(/[^a-z0-9 ]/g, " ")
    .replace(/\b(jr|sr|ii|iii|iv|v)\b/g, "").replace(/\s+/g, " ").trim();
}

// Load helper's engine once. Classic scripts, in order — league-engine.js
// reads SLOT_ELIG / FLEX_ORDER / crNormPos from shared-utils.js.
let rcEnginePromise = null;
function rcLoadEngine() {
  if (typeof runSimulation === "function" && typeof crParseEspnScoring === "function") return Promise.resolve();
  if (rcEnginePromise) return rcEnginePromise;
  const load = src => new Promise((res, rej) => {
    const s = document.createElement("script");
    s.src = `${RC_HELPER}/${src}?v=${RC_ENGINE_V}`;
    s.onload = res;
    s.onerror = () => rej(new Error(`Couldn't load the odds engine (${src})`));
    document.head.appendChild(s);
  });
  rcEnginePromise = load("shared-utils.js").then(() => load("league-engine.js"))
    .catch(e => { rcEnginePromise = null; throw e; });
  return rcEnginePromise;
}

async function rcJson(url) {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`${r.status} ${url}`);
  return r.json();
}

// ── Records (pure) ──────────────────────────────────────────────────────────

// weekRows: {week: [{rid, pts, mid}]} — banked weeks only. Returns per-rid
// {h2h, med, ap} records. Median game: the top half of the week's scores win,
// a tie straddling the cut is a tie (same rule as the engine's median sim).
function rcRecords(rids, weekRows) {
  const z = () => ({ w: 0, l: 0, t: 0 });
  const out = {};
  for (const rid of rids) out[rid] = { h2h: z(), med: z(), ap: z() };
  const add = (rec, a, b) => { if (a > b) rec.w++; else if (a < b) rec.l++; else rec.t++; };

  for (const rows of Object.values(weekRows)) {
    const live = rows.filter(r => out[r.rid]);
    if (live.length < 2) continue;
    const groups = {};
    for (const r of live) if (r.mid != null) (groups[r.mid] = groups[r.mid] || []).push(r);
    for (const g of Object.values(groups)) {
      if (g.length !== 2) continue;
      add(out[g[0].rid].h2h, g[0].pts, g[1].pts);
      add(out[g[1].rid].h2h, g[1].pts, g[0].pts);
    }
    const sorted = live.map(r => r.pts).sort((a, b) => b - a);
    const half = Math.floor(sorted.length / 2);
    const hi = sorted[half - 1], lo = sorted[half];   // lowest winning / highest losing score
    for (const r of live) {
      const m = out[r.rid].med;
      if (hi > lo) { if (r.pts >= hi) m.w++; else m.l++; }
      else if (r.pts > hi) m.w++; else if (r.pts < hi) m.l++; else m.t++;
      for (const o of live) if (o !== r) add(out[r.rid].ap, r.pts, o.pts);
    }
  }
  for (const rid of rids) {
    const o = out[rid];
    o.withMed = { w: o.h2h.w + o.med.w, l: o.h2h.l + o.med.l, t: o.h2h.t + o.med.t };
  }
  return out;
}

// ── Clinch / elimination (pure, deterministic) ──────────────────────────────

// teams: [{rid, w, t, standing}] in standings order (standing is 1-based).
// gamesLeft: regular-season games each team still plays (2 a week in a median league).
// Conservative both ways — a team that could TIE someone on record counts as
// able to pass them, since the points tiebreaker isn't decided yet. So a clinch
// is never claimed early, and nobody is called eliminated who isn't.
//
// divisions: {rid: divisionId} when division winners are GUARANTEED a playoff
// seed (ESPN — Elite FFL seeds a 5-4 division leader above a 6-3 wildcard), else
// null. Sleeper's divisions don't affect qualification: NCFL and Dynasty 1.0
// took the top 6 by record in every season 2021–2025, so they pass null.
// With guarantees, each rule stays conservative:
//   clinched   = clinched the division, or catchers + every other division's
//                winner (who could get in with a worse record) still < seeds
//   bye        = clinched the division and fewer than byeSlots teams can catch you
//   eliminated = can't win the division AND seeds-many teams are out of reach
function rcClinchStatus(teams, gamesLeft, playoffTeams, byeSlots, divisions = null) {
  const v = t => t.w + t.t / 2;
  const numDivs = divisions ? new Set(Object.values(divisions)).size : 0;
  const res = {};
  for (const x of teams) {
    if (gamesLeft <= 0) {   // regular season over — the table is final
      res[x.rid] = {
        playoff: x.standing <= playoffTeams,
        bye: byeSlots > 0 && x.standing <= byeSlots,
        eliminated: x.standing > playoffTeams,
      };
      continue;
    }
    const others = teams.filter(o => o.rid !== x.rid);
    const catchers   = others.filter(o => v(o) + gamesLeft >= v(x)).length;
    const unreachable = others.filter(o => v(o) > v(x) + gamesLeft).length;
    if (!divisions) {
      res[x.rid] = {
        playoff: catchers < playoffTeams,
        bye: byeSlots > 0 && catchers < byeSlots,
        eliminated: unreachable >= playoffTeams,
      };
      continue;
    }
    const rivals = others.filter(o => divisions[o.rid] === divisions[x.rid]);
    const divClinched = !rivals.some(o => v(o) + gamesLeft >= v(x));
    const divDead     =  rivals.some(o => v(o) > v(x) + gamesLeft);
    res[x.rid] = {
      playoff: divClinched || catchers + (numDivs - 1) < playoffTeams,
      bye: byeSlots > 0 && divClinched && catchers < byeSlots,
      eliminated: divDead && unreachable >= playoffTeams,
    };
  }
  return res;
}

// ── Playoff odds (pure apart from the engine globals) ───────────────────────

// simTeams: [{rosterId, wins, fpts, maxPf?}]. pidsByRid: {rid: [sleeperPid]}.
// projByWeek: {week: projection map}. Mirrors analyzer.html's sim inputs; when the
// projections are empty (avg < 20 pts) every team plays at its banked weekly
// average instead, and `fallback` says so.
function rcSimulate({ simTeams, pidsByRid, projByWeek, futureWeeks, matchupsByWeek, scoring,
                      rosterPositions, players, playoffTeams, median, avgPts, sims = RC_SIMS }) {
  const muMap = {}, sigmaMap = {};
  for (const t of simTeams) {
    muMap[t.rosterId] = {}; sigmaMap[t.rosterId] = {};
    for (const w of futureWeeks) {
      const { mu, sigma } = optimalLineupAndSigma(pidsByRid[t.rosterId] || [], projByWeek[w] || {},
        scoring, rosterPositions, players);
      muMap[t.rosterId][w] = mu; sigmaMap[t.rosterId][w] = sigma;
    }
  }
  const avgMu = simTeams.reduce((s, t) => s + futureWeeks.reduce((a, w) => a + muMap[t.rosterId][w], 0), 0)
    / Math.max(1, simTeams.length * futureWeeks.length);
  const fallback = avgMu < 20;
  if (fallback) {
    for (const t of simTeams) {
      const mu = Math.max(60, Math.min(200, avgPts[t.rosterId] || 110));
      for (const w of futureWeeks) { muMap[t.rosterId][w] = mu; sigmaMap[t.rosterId][w] = Math.max(12, mu * 0.2); }
    }
  }
  const res = runSimulation(simTeams, matchupsByWeek, muMap, sigmaMap, futureWeeks, playoffTeams, { median }, sims);
  return { ...res, fallback };
}

// ── Draft order (pure) ──────────────────────────────────────────────────────

// Playoff teams pick last, in reverse of their finish (champion last). Before the
// bracket is decided, finish = seed. Everyone else picks by Max PF, lowest first.
// finishOrder: rids of the playoff teams, best first. Returns [{slot, orig}].
function rcDraftSlots(teams, finishOrder) {
  const n = teams.length;
  const inPlayoffs = new Set(finishOrder);
  const rest = teams.filter(t => !inPlayoffs.has(t.rid))
    .sort((a, b) => (a.maxPf ?? a.pf) - (b.maxPf ?? b.pf) || a.pf - b.pf);
  const slots = rest.map((t, i) => ({ slot: i + 1, orig: t.rid }));
  finishOrder.forEach((rid, i) => slots.push({ slot: n - i, orig: rid }));
  return slots.sort((a, b) => a.slot - b.slot);
}

// Final placements out of Sleeper's winners_bracket ({p} games: winner takes p,
// loser p+1). Returns rids best first for the placements decided so far, then the
// remaining playoff teams by seed. Undecided bracket → seed order.
function rcPlayoffFinish(seedOrder, bracket) {
  const place = {};
  for (const g of bracket || []) {
    if (!g.p || g.w == null || g.l == null) continue;
    place[g.w] = g.p; place[g.l] = g.p + 1;
  }
  const seedIdx = Object.fromEntries(seedOrder.map((rid, i) => [rid, i]));
  return [...seedOrder].sort((a, b) =>
    (place[a] ?? 100 + seedIdx[a]) - (place[b] ?? 100 + seedIdx[b]));
}

// Who holds each pick of `season`: traded_picks rows (roster_id = original slot
// owner, owner_id = current holder) override "everyone holds their own".
function rcPickHolder(tradedPicks, season, round, origRid) {
  const tp = (tradedPicks || []).find(p => String(p.season) === String(season)
    && Number(p.round) === round && Number(p.roster_id) === Number(origRid));
  return tp ? Number(tp.owner_id) : Number(origRid);
}

// ── Model assembly (pure) ───────────────────────────────────────────────────

// Shared tail for both sources: records → statuses → odds → groups.
// base.teams: [{rid, owner, team, w, l, t, pf, maxPf, avgPts, standing}] in standings order.
function rcFinishModel(base, weekRows, sim) {
  const recs = rcRecords(base.teams.map(t => t.rid), weekRows);
  const gamesLeft = base.futureWeeks.length * (base.median ? 2 : 1);
  const status = rcClinchStatus(base.teams, gamesLeft, base.playoffTeams, base.byeSlots, base.divisions || null);
  for (const t of base.teams) {
    Object.assign(t, recs[t.rid], status[t.rid]);
    t.odds = sim?.odds?.[t.rid] ?? null;
    t.byeOdds = sim?.bye?.[t.rid] ?? null;
    // The sim can't see a clinch/elimination it happened not to draw — the
    // deterministic answer wins where it exists.
    if (t.playoff) t.odds = 1;
    if (t.eliminated) t.odds = 0;
  }
  const seeded = base.teams.filter(t => t.standing <= base.playoffTeams);
  return {
    ...base,
    gamesLeft,
    oddsFallback: !!sim?.fallback,
    groups: {
      playoff: seeded,
      hunt: base.teams.filter(t => t.standing > base.playoffTeams && !t.eliminated),
      out: base.teams.filter(t => t.standing > base.playoffTeams && t.eliminated),
    },
  };
}

// raw: {league, rosters, users, matchups:{week: rows}, projByWeek, tradedPicks, bracket, players}
function rcBuildSleeper(raw) {
  const { league, rosters, users } = raw;
  const st = league.settings || {};
  const median = st.league_average_match === 1;
  const regWeeks = Math.max(1, (st.playoff_week_start || 15) - 1);
  const playoffTeams = st.playoff_teams || Math.floor(rosters.length / 2);
  const userById = Object.fromEntries((users || []).map(u => [u.user_id, u]));
  const dec = (s, k) => (s?.[k] || 0) + (s?.[`${k}_decimal`] || 0) / 100;

  // Banked weeks = games inside the records (÷2 in a median league), never more
  // than Sleeper has scored — the analyzer's rule, so the odds match it.
  const banked = Math.min(regWeeks, Math.round(
    Math.max(0, ...rosters.map(r => (r.settings?.wins || 0) + (r.settings?.losses || 0) + (r.settings?.ties || 0)))
    / (median ? 2 : 1)));
  const weekRows = {}, futureWeeks = [];
  for (let w = 1; w <= regWeeks; w++) {
    const rows = raw.matchups[w] || [];
    const scored = rows.some(m => (m.points || 0) > 0);
    if (scored && w <= banked) weekRows[w] = rows.filter(m => m.roster_id != null)
      .map(m => ({ rid: m.roster_id, pts: m.points || 0, mid: m.matchup_id }));
    else futureWeeks.push(w);
  }

  const teams = rosters.map(r => {
    const s = r.settings || {}, u = userById[r.owner_id];
    const pf = dec(s, "fpts");
    const weeks = Object.values(weekRows).map(rows => rows.find(x => x.rid === r.roster_id)?.pts).filter(p => p != null);
    return {
      rid: r.roster_id,
      owner: u?.display_name || (r.owner_id ? `User ${r.owner_id}` : `Roster ${r.roster_id} (no owner)`),
      team: u?.metadata?.team_name || "",
      w: s.wins || 0, l: s.losses || 0, t: s.ties || 0,
      pf, maxPf: s.ppts ? dec(s, "ppts") : null,
      avgPts: weeks.length ? weeks.reduce((a, b) => a + b, 0) / weeks.length : null,
    };
  }).sort((a, b) => (b.w + b.t / 2) - (a.w + a.t / 2) || b.pf - a.pf);
  teams.forEach((t, i) => { t.standing = i + 1; });

  const base = {
    source: "sleeper", teams, leagueName: league.name, season: league.season, status: league.status,
    lastWeek: banked, regWeeks, futureWeeks, playoffTeams, median,
    byeSlots: bracketByeSlots(playoffTeams), numTeams: rosters.length,
    dynasty: st.type === 2, bestBall: st.best_ball === 1,
  };

  let sim = null;
  if (futureWeeks.length && raw.projByWeek) {
    sim = rcSimulate({
      simTeams: teams.map(t => ({ rosterId: t.rid, wins: t.w, fpts: t.pf, maxPf: t.maxPf })),
      pidsByRid: Object.fromEntries(rosters.map(r => [r.roster_id, r.players || []])),
      projByWeek: raw.projByWeek, futureWeeks,
      matchupsByWeek: Object.fromEntries(futureWeeks.map(w => [w, raw.matchups[w] || []])),
      scoring: league.scoring_settings || {}, rosterPositions: league.roster_positions || [],
      players: raw.players || {}, playoffTeams, median,
      avgPts: Object.fromEntries(teams.map(t => [t.rid, t.avgPts])),
      sims: raw.sims,
    });
  }
  const model = rcFinishModel(base, weekRows, sim);

  if (model.dynasty) {
    const seedOrder = model.groups.playoff.map(t => t.rid);
    const nextSeason = String(Number(league.season) + 1);
    const rounds = Math.max(1, st.draft_rounds || 4,
      ...(raw.tradedPicks || []).filter(p => String(p.season) === nextSeason).map(p => Number(p.round)));
    const byRid = Object.fromEntries(teams.map(t => [t.rid, t]));
    const slots = rcDraftSlots(teams, rcPlayoffFinish(seedOrder, raw.bracket));
    model.draft = {
      season: nextSeason, rounds,
      byRound: Array.from({ length: rounds }, (_, i) => slots.map(s => {
        const holder = rcPickHolder(raw.tradedPicks, nextSeason, i + 1, s.orig);
        return { slot: s.slot, orig: byRid[s.orig], holder: byRid[holder] || byRid[s.orig], traded: holder !== s.orig };
      })),
    };
  }
  return model;
}

// raw: {data (worker /api/espn/:key/recap/:season), projByWeek, players, ownerName(id)}
function rcBuildEspn(raw) {
  const d = raw.data;
  const sched = d.settings?.scheduleSettings || {};
  const regWeeks = sched.matchupPeriodCount || 14;
  const playoffTeams = sched.playoffTeamCount || Math.floor(d.teams.length / 2);
  const reg = (d.schedule || []).filter(m => m.matchupPeriodId <= regWeeks
    && (!m.playoffTierType || m.playoffTierType === "NONE"));

  // A week is banked once every one of its games is decided.
  const weekRows = {}, futureWeeks = [];
  for (let w = 1; w <= regWeeks; w++) {
    const games = reg.filter(m => m.matchupPeriodId === w);
    const done = games.length && games.every(m => m.winner && m.winner !== "UNDECIDED");
    if (!done) { futureWeeks.push(w); continue; }
    weekRows[w] = [];
    for (const m of games) {
      for (const side of [m.home, m.away]) {
        if (side) weekRows[w].push({ rid: side.teamId, pts: side.totalPoints || 0, mid: m.away ? m.id ?? `${w}_${m.home.teamId}` : null });
      }
    }
  }

  // Sleeper ids by name, so Sleeper projections can price ESPN rosters.
  const byName = {};
  for (const [pid, p] of Object.entries(raw.players || {})) {
    if (!["QB", "RB", "WR", "TE"].includes(p.position)) continue;
    const k = rcNameKey(p.full_name || `${p.first_name} ${p.last_name}`);
    if (!byName[k] || (p.team && !raw.players[byName[k]].team)) byName[k] = pid;
  }

  const ownerName = raw.ownerName || (id => id);
  const allSeeded = d.teams.every(t => t.playoffSeed > 0);
  const teams = d.teams.map(t => {
    const o = t.record?.overall || {};
    const weeks = Object.values(weekRows).map(rows => rows.find(x => x.rid === t.id)?.pts).filter(p => p != null);
    return {
      rid: t.id, owner: ownerName(t.primaryOwner), team: t.name || "",
      w: o.wins || 0, l: o.losses || 0, t: o.ties || 0,
      pf: o.pointsFor || weeks.reduce((a, b) => a + b, 0), maxPf: null, seed: t.playoffSeed,
      avgPts: weeks.length ? weeks.reduce((a, b) => a + b, 0) / weeks.length : null,
      pids: (t.roster || []).map(p => byName[rcNameKey(p.name)]).filter(Boolean),
    };
  }).sort((a, b) => allSeeded ? a.seed - b.seed
    : (b.w + b.t / 2) - (a.w + a.t / 2) || b.pf - a.pf);   // ESPN's own seeds when it has them
  teams.forEach((t, i) => { t.standing = i + 1; });

  const base = {
    source: "espn", teams, leagueName: raw.leagueName || "", season: d.seasonId,
    // ESPN seeds division winners first — see rcClinchStatus.
    divisions: new Set(d.teams.map(t => t.divisionId)).size > 1
      ? Object.fromEntries(d.teams.map(t => [t.id, t.divisionId])) : null,
    lastWeek: regWeeks - futureWeeks.length, regWeeks, futureWeeks, playoffTeams, median: false,
    byeSlots: bracketByeSlots(playoffTeams), numTeams: d.teams.length, dynasty: false,
  };

  let sim = null;
  if (futureWeeks.length && raw.projByWeek) {
    sim = rcSimulate({
      simTeams: teams.map(t => ({ rosterId: t.rid, wins: t.w, fpts: t.pf })),
      pidsByRid: Object.fromEntries(teams.map(t => [t.rid, t.pids])),
      projByWeek: raw.projByWeek, futureWeeks,
      matchupsByWeek: crEspnScheduleToMatchupsByWeek(reg, futureWeeks),
      scoring: crParseEspnScoring(d.settings).scoring,
      rosterPositions: espnRosterPositionsFromSlotCounts(d.settings?.rosterSettings?.lineupSlotCounts),
      players: raw.players || {}, playoffTeams, median: false,
      avgPts: Object.fromEntries(teams.map(t => [t.rid, t.avgPts])),
      sims: raw.sims,
    });
  }
  const model = rcFinishModel(base, weekRows, sim);
  model.unmatched = d.teams.reduce((n, t) => n + (t.roster || []).filter(p =>
    [1, 2, 3, 4].includes(p.pos) && !byName[rcNameKey(p.name)]).length, 0);
  return model;
}

// ── Fetching ────────────────────────────────────────────────────────────────

async function rcProjections(season, weeks) {
  const maps = await Promise.all(weeks.map(w => rcJson(`/api/projections/${season}/${w}`).catch(() => ({}))));
  return Object.fromEntries(weeks.map((w, i) => [w, maps[i]]));
}

async function rcPlayers(opts) {
  const have = opts.players?.();
  if (have && Object.keys(have).length) return have;
  return rcJson("/api/players");
}

// The newest season that has actually started.
async function rcCurrentSleeperLeague(seasons) {
  for (const yr of Object.keys(seasons).sort().reverse()) {
    const league = await rcJson(`/api/league/${seasons[yr]}/info`).catch(() => null);
    if (league && !["pre_draft", "drafting"].includes(league.status)) return league;
  }
  return null;
}

async function rcLoadSleeper(opts) {
  const league = await rcCurrentSleeperLeague(opts.seasons);
  if (!league) throw new Error("No season has started yet.");
  const lid = league.league_id;
  const regWeeks = Math.max(1, (league.settings?.playoff_week_start || 15) - 1);
  const [rosters, users, tradedPicks, bracket, players, matchupList] = await Promise.all([
    rcJson(`/api/league/${lid}/rosters`),
    rcJson(`/api/league/${lid}/users`),
    league.settings?.type === 2 ? rcJson(`/api/league/${lid}/traded_picks`).catch(() => []) : [],
    rcJson(`/api/league/${lid}/winners_bracket`).catch(() => []),
    rcPlayers(opts),
    Promise.all(Array.from({ length: regWeeks }, (_, i) => rcJson(`/api/league/${lid}/matchups/${i + 1}`).catch(() => []))),
  ]);
  const matchups = Object.fromEntries(matchupList.map((m, i) => [i + 1, m || []]));
  const raw = { league, rosters, users, matchups, tradedPicks, bracket, players };
  // First pass finds the unplayed weeks; projections are fetched for just those.
  const pre = rcBuildSleeper({ ...raw, projByWeek: null });
  if (!pre.futureWeeks.length) return pre;
  return rcBuildSleeper({ ...raw, projByWeek: await rcProjections(league.season, pre.futureWeeks) });
}

async function rcLoadEspn(opts) {
  const [data, players] = await Promise.all([
    rcJson(`/api/espn/${opts.espnKey}/recap/${opts.season}`),
    rcPlayers(opts),
  ]);
  const raw = { data, players, ownerName: opts.ownerName, leagueName: opts.leagueName };
  const pre = rcBuildEspn({ ...raw, projByWeek: null });
  if (!pre.futureWeeks.length) return pre;
  return rcBuildEspn({ ...raw, projByWeek: await rcProjections(opts.season, pre.futureWeeks) });
}

// ── Rendering ───────────────────────────────────────────────────────────────

function rcTag(t, m) {
  if (m.gamesLeft <= 0) return "";
  if (t.bye) return `<span class="rc-tag rc-tag-bye">Clinched bye</span>`;
  if (t.playoff) return `<span class="rc-tag rc-tag-in">Clinched playoff berth</span>`;
  return "";
}

function rcTeamTable(rows, m) {
  if (!rows.length) return `<p class="rc-empty">Nobody.</p>`;
  const body = rows.map(t => `<tr>
      <td class="rc-pos">${t.standing}</td>
      <td class="rc-owner"><span class="rc-owner-name">${rcEsc(t.owner)}</span>${rcTag(t, m)}
        ${t.team && t.team !== t.owner ? `<span class="rc-team">${rcEsc(t.team)}</span>` : ""}</td>
      ${m.median
        // Median league: the median game counts in the standings, so the record WITH it is
        // the record; head-to-head alone and all-play ride along in parentheses.
        ? `<td class="rc-rec">${rcRec(t.withMed)} <span class="rc-rec-sub">(${rcRec(t.h2h)} w/o median · ${rcRec(t.ap)} all-play)</span></td>`
        : `<td>${rcRec(t.h2h)}</td><td>${rcRec(t.withMed)}</td><td>${rcRec(t.ap)}</td>`}
      <td>${rcPts(t.pf)}</td>
      <td class="rc-odds">${rcPct(t.odds, t)}</td>
    </tr>`).join("");
  return `<div class="standings-wrap"><table class="standings-table rc-table">
    <thead><tr><th>#</th><th>Owner</th>${m.median
      ? `<th title="Head-to-head plus the weekly game against the league median — what the standings count. In parentheses: head-to-head only, and all-play (every team, every week)">Record</th>`
      : `<th>Record</th><th title="Head-to-head plus a game against the league median each week (doesn't count in this league)">w/ Median</th>
      <th title="Record if you played every team every week">All-Play</th>`}<th>PF</th><th>Playoff %</th></tr></thead>
    <tbody>${body}</tbody></table></div>`;
}

function rcDraftHtml(m) {
  const d = m.draft;
  const rnd = Math.min(RC.round, d.rounds);
  const pills = d.rounds > 1 ? `<div class="year-pills rc-round-pills">${Array.from({ length: d.rounds }, (_, i) =>
    `<button class="year-pill${i + 1 === rnd ? " active" : ""}" onclick="rcSetRound(${i + 1})">Round ${i + 1}</button>`).join("")}</div>` : "";
  const rows = d.byRound[rnd - 1].map(p => `<tr>
      <td class="rc-pos">${rnd}.${String(p.slot).padStart(2, "0")}</td>
      <td class="rc-owner"><span class="rc-owner-name">${rcEsc(p.holder.owner)}</span>${p.traded
        ? `<span class="rc-via">via ${rcEsc(p.orig.owner)}</span>` : ""}</td>
      <td>${rcPts(p.orig.maxPf ?? p.orig.pf)}${p.orig.maxPf == null ? "*" : ""}</td>
    </tr>`).join("");
  return `${pills}<div class="standings-wrap"><table class="standings-table rc-table">
    <thead><tr><th>Pick</th><th>Owner</th><th title="Max PF of the team the pick originally belonged to">Max PF (orig. owner)</th></tr></thead>
    <tbody>${rows}</tbody></table></div>
    <p class="rc-note">Playoff teams pick last in reverse order of finish${m.status === "complete" ? "" : " (current seed until the bracket is decided)"};
      everyone else by Max PF, lowest first.${d.byRound.some(r => r.some(p => p.orig.maxPf == null)) ? " * Max PF not available yet — points for shown." : ""}</p>`;
}

function rcHtml(m) {
  const left = m.futureWeeks.length;
  const sub = [
    left ? `Through week ${m.lastWeek} · ${left} week${left === 1 ? "" : "s"} left in the regular season`
         : `Regular season complete (${m.regWeeks} weeks)`,
    `Top ${m.playoffTeams} make the playoffs${m.byeSlots ? ` · top ${m.byeSlots} get a bye` : ""}`,
    m.median ? "Median league — two games a week" : "",
  ].filter(Boolean).join(" · ");
  const section = (title, html) => `<div class="rc-section"><h3 class="rc-h">${title}</h3>${html}</div>`;
  return `
    <div class="rc-head">
      <div>
        <div class="rc-title">${rcEsc(m.season)} Week ${m.lastWeek} Recap</div>
        <div class="rc-sub">${rcEsc(sub)}</div>
      </div>
      <div class="rc-actions">
        <button class="lookup-btn rc-btn" onclick="rcCopy()">⧉ Copy as text</button>
        <button class="lookup-btn rc-btn" onclick="rcGenerate(true)">↻ Regenerate</button>
      </div>
    </div>
    ${section("🏆 Playoff Picture", rcTeamTable(m.groups.playoff, m))}
    ${section("🔥 Still in the Hunt", rcTeamTable(m.groups.hunt, m))}
    ${section("💀 Eliminated", rcTeamTable(m.groups.out, m))}
    ${m.draft ? section(`📋 Projected ${rcEsc(m.draft.season)} Draft Order`, rcDraftHtml(m)) : ""}
    <p class="rc-note">Playoff % — ${RC_SIMS.toLocaleString()} simulations of the remaining schedule from each team's
      current record, using ${m.oddsFallback ? "each team's average score so far (weekly projections weren't available)"
      : "Sleeper's weekly projections for each roster's best lineup, scored with this league's settings"} — the same
      engine as helper.ffhistorian.com. Clinched / eliminated are mathematical: a team that could still tie on record counts as able to pass you.
      ${m.unmatched ? `${m.unmatched} rostered ESPN player${m.unmatched === 1 ? "" : "s"} couldn't be matched to a projection.` : ""}</p>`;
}

function rcText(m) {
  const rec = t => m.median
    ? `${rcRec(t.withMed)} (w/o med ${rcRec(t.h2h)}, AP ${rcRec(t.ap)})`
    : `${rcRec(t.h2h)} (w/ med ${rcRec(t.withMed)}, AP ${rcRec(t.ap)})`;
  const line = t => `${t.standing}. ${t.owner} — ${rec(t)} · ${rcPts(t.pf)} PF · ${rcPct(t.odds, t)}`
    + (m.gamesLeft > 0 && t.bye ? " · CLINCHED BYE" : m.gamesLeft > 0 && t.playoff ? " · CLINCHED" : "");
  const block = (title, rows) => rows.length ? [`${title}`, ...rows.map(line), ""] : [];
  const out = [
    `${m.leagueName ? m.leagueName + " — " : ""}${m.season} Week ${m.lastWeek} Recap`, "",
    ...block("🏆 PLAYOFF PICTURE", m.groups.playoff),
    ...block("🔥 STILL IN THE HUNT", m.groups.hunt),
    ...block("💀 ELIMINATED", m.groups.out),
  ];
  if (m.draft) {
    out.push(`📋 PROJECTED ${m.draft.season} DRAFT ORDER (Round 1)`);
    for (const p of m.draft.byRound[0]) {
      out.push(`1.${String(p.slot).padStart(2, "0")} ${p.holder.owner}${p.traded ? ` (via ${p.orig.owner})` : ""} — ${rcPts(p.orig.maxPf ?? p.orig.pf)} Max PF`);
    }
  }
  return out.join("\n").trim();
}

// ── Page entry points ───────────────────────────────────────────────────────

function rcRoot() { return document.getElementById("recapContent"); }

// The recap's own styles, injected once so every league page shares one copy.
// Everything else (tables, buttons, pills, loading/error states) is the page's own.
const RC_CSS = `
  .rc-head { display: flex; justify-content: space-between; align-items: flex-end; gap: 16px; flex-wrap: wrap; margin-bottom: 24px; }
  .rc-title { font-family: 'Playfair Display', serif; font-weight: 700; font-size: 1.5rem; color: var(--brown-dark); }
  .rc-sub { font-family: 'Crimson Text', serif; font-size: 1rem; color: var(--brown-light); margin-top: 2px; }
  .rc-actions { display: flex; gap: 8px; flex-wrap: wrap; }
  .rc-actions .lookup-btn { margin-top: 0; padding: 8px 14px; }
  .rc-section { margin-bottom: 32px; }
  .rc-h { font-family: 'Rye', serif; font-size: 0.8rem; letter-spacing: 0.15em; text-transform: uppercase; color: var(--brown-dark); margin-bottom: 10px; }
  .rc-table th { cursor: default; }
  .rc-table th:hover { color: var(--gold-light); }
  .rc-table th:nth-child(2), .rc-table td.rc-owner { text-align: left !important; }
  .standings-table td.rc-pos { min-width: 0; width: 52px; font-family: 'Rye', serif; font-size: 0.75rem; color: var(--gold-light); }
  .standings-table td.rc-owner { min-width: 170px; max-width: 280px; white-space: normal; }
  .rc-owner-name { font-family: 'Playfair Display', serif; font-weight: 700; color: var(--cream); }
  .rc-rec-sub { font-size: 0.82em; opacity: 0.65; white-space: nowrap; }
  .rc-team, .rc-via { display: block; font-size: 0.82rem; color: var(--parchment); opacity: 0.6; font-style: italic; }
  .rc-via { opacity: 0.85; color: var(--gold-light); }
  .rc-odds { color: var(--gold-light) !important; font-weight: 600; }
  .rc-tag { display: inline-block; margin-left: 8px; padding: 1px 7px; border-radius: 10px; font-family: 'Crimson Text', serif; font-size: 0.72rem; font-weight: 700; vertical-align: middle; white-space: nowrap; }
  .rc-tag-bye { background: var(--gold); color: var(--brown-dark); }
  .rc-tag-in  { background: var(--green-light); color: var(--cream); }
  .rc-empty { font-family: 'Playfair Display', serif; font-style: italic; color: var(--brown-light); }
  .rc-round-pills { margin-bottom: 12px; }
  .rc-note { margin-top: 10px; font-family: 'Crimson Text', serif; font-size: 0.85rem; font-style: italic; color: var(--brown-light); }
  @media (max-width: 600px) {
    .standings-table td.rc-pos { width: 34px; }
    .standings-table td.rc-rec { white-space: normal; }
    .rc-rec-sub { display: block; white-space: normal; }
    .standings-table td.rc-owner { min-width: 120px; }
    .rc-tag { margin-left: 0; margin-top: 2px; }
  }
`;
function rcInjectCss() {
  if (document.getElementById("rc-css")) return;
  const s = document.createElement("style");
  s.id = "rc-css"; s.textContent = RC_CSS;
  document.head.appendChild(s);
}

function rcOpen(opts) {
  rcInjectCss();
  RC.opts = opts;
  if (!RC.model && !RC.loading) rcGenerate(false);
}

async function rcGenerate(force) {
  if (RC.loading) return;
  if (force) RC.model = null;
  RC.loading = true;
  rcRoot().innerHTML = `<div class="loading"><div class="spinner"></div><br/>Simulating the rest of the season…</div>`;
  try {
    await rcLoadEngine();
    RC.model = RC.opts.espnKey ? await rcLoadEspn(RC.opts) : await rcLoadSleeper(RC.opts);
    rcRoot().innerHTML = rcHtml(RC.model);
  } catch (e) {
    console.error("[Recap]", e);
    rcRoot().innerHTML = `<div class="error-msg">Couldn't build the recap: ${rcEsc(e.message)}</div>`;
  } finally {
    RC.loading = false;
  }
}

function rcSetRound(r) {
  RC.round = r;
  if (RC.model) rcRoot().innerHTML = rcHtml(RC.model);
}

async function rcCopy() {
  if (!RC.model) return;
  const text = rcText(RC.model);
  try {
    await navigator.clipboard.writeText(text);
    if (typeof showToast === "function") showToast("Recap copied");
  } catch {
    window.prompt("Copy the recap:", text);
  }
}

if (typeof module !== "undefined") {
  module.exports = { rcRecords, rcClinchStatus, rcDraftSlots, rcPlayoffFinish, rcPickHolder,
                     rcBuildSleeper, rcBuildEspn, rcText, rcHtml, rcNameKey };
}
