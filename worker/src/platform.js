// ════════════════════════════════════════════════════════════════════════════
// MFL and Yahoo leagues — /l/mfl_{id} and /l/yh_{id}
//
// Same idea as the generic ESPN leagues (history.js): the first open needs a
// signed-in account, which becomes the league's `owner`; after that the link works
// for anyone — unless a member switches the league to "members only".
//
// Nothing here talks to MFL or Yahoo. Helper already serves both in Sleeper's
// shapes (players in Sleeper ids) and holds everything a read needs: the adapters,
// the player-id crosswalk, the opener's MFL cookie / Yahoo token, MFL's registered
// user agent. So every read goes to helper's private PlatformLeagues entrypoint
// over the PLATFORMS service binding, as the owner:
//   https://helper/{mfl|yahoo}/{league|draft|trades|seasons}/{key}[/{res}[/{arg}]]?user=
//
// Season ids are helper's: mfl_{year}_{mflId} (MFL's id can change between years —
// the league export's history list names each one), yh_{season}_{yahooId}.
// Owners are rewritten to stay the same across seasons: MFL → mfl:{franchiseId}
// (MFL hides owner names; franchise ids carry over), Yahoo → yh:{managerGuid}
// (else yh:t{teamId}).
//
// Storage
//   KV  hist:plat:{rootId}   → { builtAt, owner, membersOnly, config }   (no ttl)
//   KV  hist:alias:{seasonKey | shareId} → rootId
//   R2  plat/{seasonKey}/{resource}[-{arg}].json — a past season, read once, kept
//   KV  plat:{seasonKey}:{resource}:{arg}         — the current season, short ttl
// ════════════════════════════════════════════════════════════════════════════

const CONFIG_ID_RE = /^(mfl|yh)_(?:(\d{4})_)?(\d{1,12})$/;
export const PLAT_LID_RE = /^(mfl|yh)_(\d{4})_(\d{1,12})$/;
const FRESH_MS_IN_SEASON = 6 * 60 * 60 * 1000;
const FRESH_MS_OFFSEASON = 24 * 60 * 60 * 1000;
const LIVE_TTL = 600;
const PLAT_NAME = { mfl: "mfl", yh: "yahoo" };

function json(obj, status = 200, extra = {}) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store", ...extra },
  });
}
const nflSeason = (d = new Date()) => (d.getUTCMonth() < 7 ? d.getUTCFullYear() - 1 : d.getUTCFullYear());
const inSeason = (d = new Date()) => { const m = d.getUTCMonth(); return m >= 8 || m === 0; };

function splitTitle(name) {
  const words = String(name || "League").trim().split(/\s+/);
  return words.length > 1 ? [words.slice(0, -1).join(" "), words.at(-1)] : [words[0], ""];
}

// ── helper's PlatformLeagues entrypoint ──────────────────────────────────────
export async function helperRead(env, plat, op, key, { res, arg, user } = {}) {
  if (!env.PLATFORMS) return { status: 503, body: { error: "League reader not configured" } };
  const path = [PLAT_NAME[plat], op, key, res, arg].filter(x => x != null && x !== "").join("/");
  const q = user ? `?user=${encodeURIComponent(user)}` : "";
  try {
    const r = await env.PLATFORMS.fetch(`https://helper/${path}${q}`);
    const body = await r.json().catch(() => ({ error: "Bad response from the league reader" }));
    return { status: r.status, body };
  } catch (e) {
    return { status: 502, body: { error: e.message } };
  }
}

// ── Registry ─────────────────────────────────────────────────────────────────
async function getRec(env, rootId) {
  const raw = rootId && await env.FF_CACHE.get(`hist:plat:${rootId}`);
  try { return raw ? JSON.parse(raw) : null; } catch { return null; }
}
async function recFor(env, anyId) {
  const root = await env.FF_CACHE.get(`hist:alias:${anyId}`);
  return root ? getRec(env, root) : null;
}
async function putRec(env, rec) {
  await env.FF_CACHE.put(`hist:plat:${rec.config.id}`, JSON.stringify(rec));
  const ids = [...Object.values(rec.config.seasons), rec.config.shareId, rec.config.id];
  await Promise.all([...new Set(ids)].map(k => env.FF_CACHE.put(`hist:alias:${k}`, rec.config.id)));
}

// A seasons answer from helper → the LEAGUES-shaped config the page reads.
function buildPlatConfig(plat, ans, rootId) {
  const lg = ans.league || {};
  const newestKey = Object.values(ans.seasons).at(-1) || ans.key;
  const lid = PLAT_LID_RE.exec(newestKey)?.[3];
  const shareId = `${plat}_${lid}`;
  const name = lg.name || (plat === "mfl" ? `MFL league ${lid}` : `Yahoo league ${lid}`);
  const dynasty = Number(lg.settings?.type) === 2;
  return {
    slug: `l/${shareId}`,
    id: rootId || shareId,
    shareId,
    name, title: name, cardName: name, h1: splitTitle(name),
    logo: "", emoji: "🏈",
    platform: PLAT_NAME[plat],
    format: dynasty ? "dynasty" : "redraft",
    seasons: ans.seasons,
    // Every season may have a draft; the /draft resource says when one doesn't.
    draftIds: Object.fromEntries(Object.entries(ans.seasons).map(([y, k]) => [y, k])),
    hasDivisions: Number(lg.settings?.divisions) > 1,
    ownershipMerges: [],
    franchiseLinks: [],
    generated: true,
  };
}

// ── Membership ───────────────────────────────────────────────────────────────
// A member is the account that opened the league, or one whose connected MFL /
// Yahoo account lists any season of it (helper's mfl_settings / yahoo_settings,
// the shared D1 — only the non-secret `leagues` column is read).
export async function isMember(env, user, rec) {
  if (!user) return false;
  if (rec.owner && user.user_id === rec.owner) return true;
  const plat = rec.config.platform;
  const table = plat === "mfl" ? "mfl_settings" : "yahoo_settings";
  const row = await env.DB.prepare(`SELECT leagues FROM ${table} WHERE user_id = ?`).bind(user.user_id).first().catch(() => null);
  let list = [];
  try { list = JSON.parse(row?.leagues || "[]"); } catch { list = []; }
  const keys = new Set(Object.values(rec.config.seasons));
  return list.some(l => keys.has(plat === "mfl" ? `mfl_${l.year}_${l.id}` : `yh_${l.season}_${l.id}`));
}

// ── GET /api/history/config/{mfl_|yh_…} ──────────────────────────────────────
export function isPlatConfigId(id) { return CONFIG_ID_RE.test(id); }

export async function handlePlatConfig(request, env, id, getAuthUser) {
  const [, plat] = CONFIG_ID_RE.exec(id);
  let rec = await recFor(env, id);
  const user = await getAuthUser(request, env);

  if (!rec) {
    if (!user) return json({ error: "Sign in to open a league for the first time.", needsSignIn: true }, 401);
    const { status, body } = await helperRead(env, plat, "seasons", id, { user: user.user_id });
    if (status !== 200 || !body?.seasons || !Object.keys(body.seasons).length) {
      const hint = plat === "mfl"
        ? " If it's a private league, connect your MFL account on your profile (ffhistorian.com/profile/#connections) and try again."
        : " Connect Yahoo on your profile (ffhistorian.com/profile/#connections) and find your leagues, then try again.";
      if (status === 503) return json({ error: plat === "yh" ? "Yahoo leagues aren't available here yet." : (body?.error || "Try again later.") }, 503);
      return json({ error: (body?.error || "That league couldn't be read.") + (status === 429 ? "" : hint) }, status === 200 ? 404 : status);
    }
    // Someone else may have opened the same league under another of its ids.
    const existing = await recFor(env, Object.values(body.seasons).at(-1));
    if (existing) {
      rec = existing;
      await env.FF_CACHE.put(`hist:alias:${id}`, rec.config.id);
    } else {
      rec = { builtAt: Date.now(), owner: user.user_id, membersOnly: false, config: buildPlatConfig(plat, body) };
      await putRec(env, rec);
    }
  } else {
    const maxAge = inSeason() ? FRESH_MS_IN_SEASON : FRESH_MS_OFFSEASON;
    if (Date.now() - rec.builtAt > maxAge) {
      const newest = Object.values(rec.config.seasons).at(-1);
      const { status, body } = await helperRead(env, plat, "seasons", newest, { user: rec.owner });
      if (status === 200 && body?.seasons) {
        rec = { ...rec, builtAt: Date.now(), config: buildPlatConfig(plat, body, rec.config.id) };
      } else {
        rec = { ...rec, builtAt: Date.now() };     // stale is fine; try again later
      }
      await putRec(env, rec).catch(() => {});
    }
  }

  const member = await isMember(env, user, rec);
  if (rec.membersOnly && !member) {
    return json({ error: user ? "This league's record book is for its members only."
                              : "This league's record book is for its members only — sign in to open it.",
                  membersOnly: true, needsSignIn: !user }, user ? 403 : 401);
  }
  return json({ ...rec.config, membersOnly: !!rec.membersOnly, canManage: member });
}

// ── POST /api/history/members-only/{id}  {on: bool} ──────────────────────────
export async function handleMembersOnly(request, env, id, getAuthUser) {
  const rec = await recFor(env, id);
  if (!rec) return json({ error: "That league hasn't been opened yet." }, 404);
  const user = await getAuthUser(request, env);
  if (!user) return json({ error: "Sign in first.", needsSignIn: true }, 401);
  if (!(await isMember(env, user, rec))) return json({ error: "Only the league's members can change this." }, 403);
  const b = await request.json().catch(() => ({}));
  rec.membersOnly = !!b.on;
  await env.FF_CACHE.put(`hist:plat:${rec.config.id}`, JSON.stringify(rec));
  return json({ membersOnly: rec.membersOnly });
}

// ── Owner ids that hold across seasons ───────────────────────────────────────
function stableOwner(plat, uid, meta, rosterId) {
  if (plat === "mfl") {
    const m = /^mfl:\d+:(\d+)$/.exec(String(uid || ""));
    return m ? `mfl:${m[1]}` : uid;
  }
  if (meta?.yahoo_guid) return `yh:${meta.yahoo_guid}`;
  const m = /^yh:\d+:(\d+)$/.exec(String(uid || ""));
  return m ? `yh:t${m[1]}` : (uid || `yh:t${rosterId}`);
}
function rewriteOwners(plat, resource, body) {
  if (!Array.isArray(body)) return body;
  if (resource === "users") return body.map(u => ({ ...u, user_id: stableOwner(plat, u.user_id, u.metadata) }));
  if (resource === "rosters") return body.map(r => ({ ...r, owner_id: stableOwner(plat, r.owner_id, r.metadata, r.roster_id) }));
  return body;
}

// ── /api/league/{mfl_|yh_…}/{resource}[/{param}] ─────────────────────────────
// opts.tradeValues(lid, trades) → Response — the dynasty day-of value freeze (index.js).
export async function handlePlatLeague(request, env, lid, resource, param, { getAuthUser, tradeValues }) {
  const [, plat, yearStr] = PLAT_LID_RE.exec(lid);
  const year = Number(yearStr);
  const rec = await recFor(env, lid);
  if (!rec) return json({ error: "That league hasn't been opened yet." }, 404, { "Access-Control-Allow-Origin": "*" });
  if (rec.membersOnly) {
    const user = await getAuthUser(request, env);
    if (!(await isMember(env, user, rec))) return json({ error: "Members only" }, user ? 403 : 401);
  }
  const past = year < nflSeason();
  const cacheHdr = rec.membersOnly
    ? { "Cache-Control": "private, max-age=60" }
    : { "Cache-Control": `public, max-age=${past ? 3600 : 120}`, "Access-Control-Allow-Origin": "*" };
  // Only a good answer may be cached — a cached 429 would keep a season out for an hour.
  const out = (body, status = 200) => new Response(JSON.stringify(body), {
    status, headers: { "Content-Type": "application/json", ...cacheHdr,
                       ...(status === 200 ? {} : { "Cache-Control": "no-store" }) },
  });

  if (resource === "trade-values") {
    const trades = await platResource(env, plat, rec, lid, "trades", null, past);
    return tradeValues(lid, Array.isArray(trades.body) ? trades.body : []);
  }
  const names = { trades: "trades", transactions: "trades", info: "info", draft: "draft", rosters: "rosters", users: "users",
                  winners_bracket: "winners_bracket", losers_bracket: "losers_bracket", traded_picks: "traded_picks", matchups: "matchups" };
  const res = names[resource];
  if (!res) return out({ error: "Unknown resource" }, 404);
  if (res === "matchups") {
    const w = parseInt(param, 10);
    if (!(w >= 1 && w <= 18)) return out({ error: "Invalid week" }, 400);
  }
  const r = await platResource(env, plat, rec, lid, res, res === "matchups" ? String(parseInt(param, 10)) : null, past);
  return out(r.body, r.status);
}

// One resource: R2 archive for a past season, short KV cache for the current one.
async function platResource(env, plat, rec, lid, res, arg, past) {
  // Rosters are stored rebuilt (see regularSeason) under their own name.
  const name = res === "rosters" ? "rosters-reg" : res;
  const r2Key = `plat/${lid}/${name}${arg ? "-" + arg : ""}.json`;
  const kvKey = `plat:${lid}:${name}:${arg || ""}`;
  if (past) {
    const obj = await env.ESPN_DATA.get(r2Key).catch(() => null);
    if (obj) { try { return { status: 200, body: JSON.parse(await obj.text()) }; } catch { /* re-read */ } }
  } else {
    const hit = await env.FF_CACHE.get(kvKey);
    if (hit) { try { return { status: 200, body: JSON.parse(hit) }; } catch { /* re-read */ } }
  }

  const r = await readFromHelper(env, plat, rec.owner, lid, res, arg);
  if (res === "rosters" && r.status === 200) {
    const fixed = await regularSeason(env, plat, rec, lid, past, r.body);
    if (fixed.status !== 200) return fixed;
    r.body = fixed.body;
  }
  if (r.status !== 200) {
    // A week or resource the platform simply doesn't have (week 18 of a 17-week
    // season, no draft) reads as empty, and is kept like any other answer.
    if (r.status === 400 || r.status === 404) r.body = res === "info" ? {} : res === "draft" ? { draft_order: {}, picks: [] } : [];
    else return r;     // 401/403/429/5xx: never stored — the next visit tries again
  }
  const body = JSON.stringify(r.body);
  if (past) await env.ESPN_DATA.put(r2Key, body, { httpMetadata: { contentType: "application/json" } }).catch(() => {});
  else await env.FF_CACHE.put(kvKey, body, { expirationTtl: LIVE_TTL }).catch(() => {});
  return { status: 200, body: r.body };
}

// The page reads a roster's W/L/T and PF/PA as the REGULAR SEASON's. MFL's
// standings don't say that: its pf counts every week to the end (playoff weeks,
// and teams out of the playoffs too), its pa only H2H games, and older seasons'
// h2hw include playoff wins. So both platforms' records are rebuilt here from the
// regular-season weeks (before playoff_week_start, and only scored weeks while a
// season is live) — the same matchups the page reads, archived the same way.
async function regularSeason(env, plat, rec, lid, past, rosters) {
  const info = await platResource(env, plat, rec, lid, "info", null, past);
  if (info.status !== 200) return info;
  const st = info.body?.settings || {};
  const last = Math.min((Number(st.playoff_week_start) || 15) - 1, past ? 18 : (Number(st.last_scored_leg) || 0));
  const tot = {};
  for (let w = 1; w <= last; w++) {
    const m = await platResource(env, plat, rec, lid, "matchups", String(w), past);
    if (m.status !== 200) return m;
    const week = Array.isArray(m.body) ? m.body : [];
    const byMid = {};
    week.forEach(x => { if (x.matchup_id != null) (byMid[x.matchup_id] ||= []).push(x); });
    week.forEach(x => {
      const t = (tot[x.roster_id] ||= { w: 0, l: 0, t: 0, pf: 0, pa: 0, games: 0 });
      t.pf += x.points || 0;
      const pair = x.matchup_id != null ? byMid[x.matchup_id] : null;
      const opp = pair && pair.length === 2 ? pair.find(y => y !== x) : null;
      if (!opp) return;
      t.pa += opp.points || 0; t.games++;
      if (x.points > opp.points) t.w++; else if (x.points < opp.points) t.l++; else t.t++;
    });
  }
  if (!Object.keys(tot).length) return { status: 200, body: rosters };   // nothing played yet
  const split = v => { const c = Math.round(v * 100); return [Math.floor(c / 100), c % 100]; };
  return { status: 200, body: rosters.map(r => {
    const t = tot[r.roster_id];
    if (!t) return r;
    const [f, fd] = split(t.pf), [a, ad] = split(t.pa);
    return { ...r, settings: { ...r.settings, wins: t.w, losses: t.l, ties: t.t,
      fpts: f, fpts_decimal: fd, fpts_against: a, fpts_against_decimal: ad } };
  }) };
}

async function readFromHelper(env, plat, owner, lid, res, arg) {
  const user = owner;
  if (res === "trades") return helperRead(env, plat, "trades", lid, { user });
  if (res === "info") return helperRead(env, plat, "league", lid, { user });
  if (res === "draft") {
    // The page's draft shape: { draft_order: {roster_id: slot}, picks }, plus names
    // for players Sleeper doesn't carry.
    const [d, p] = await Promise.all([
      helperRead(env, plat, "league", lid, { res: "drafts", user }),
      helperRead(env, plat, "draft", lid, { res: "picks", user }),
    ]);
    if (p.status !== 200) return p;
    const draft = Array.isArray(d.body) ? d.body[0] : null;
    const draft_order = Object.fromEntries(Object.entries(draft?.slot_to_roster_id || {}).map(([s, r]) => [String(r), Number(s)]));
    // The page keys a pick by its draft COLUMN (the round-1 slot it belongs to):
    // MFL gives the position in the round, Yahoo only the overall pick number.
    const n = Number(draft?.settings?.teams) || 0;
    const snake = draft?.type === "snake";
    const picks = (Array.isArray(p.body) ? p.body : []).map(k => {
      const pos = k.draft_slot || (n ? ((k.pick_no - 1) % n) + 1 : null);
      return { ...k, draft_slot: pos && snake && n && k.round % 2 === 0 ? n + 1 - pos : pos };
    });
    const _players = {};
    picks.forEach(k => {
      if (!/^(mfl|yh)_/.test(String(k.player_id)) || !k.metadata?.last_name) return;
      _players[k.player_id] = { full_name: `${k.metadata.first_name || ""} ${k.metadata.last_name}`.trim(), position: k.metadata.position || "" };
    });
    return { status: 200, body: { draft_order, picks, _players } };
  }
  const r = await helperRead(env, plat, "league", lid, { res, arg, user });
  if (r.status === 200) r.body = rewriteOwners(plat, res, r.body);
  return r;
}

// ── The signed-in user's MFL / Yahoo leagues, for the landing page ───────────
export async function minePlatforms(env, user) {
  const read = async (table, plat) => {
    const row = await env.DB.prepare(`SELECT leagues, hidden FROM ${table} WHERE user_id = ?`).bind(user.user_id).first().catch(() => null);
    if (!row) return { leagues: [], connected: false };
    let list = [], hidden = [];
    try { list = JSON.parse(row.leagues || "[]"); hidden = JSON.parse(row.hidden || "[]"); } catch { /* empty */ }
    const hid = new Set(hidden);
    const yearOf = l => Number(plat === "mfl" ? l.year : l.season);
    // Newest season per league id
    const byId = new Map();
    list.forEach(l => {
      if (hid.has(`${yearOf(l)}_${l.id}`)) return;
      const cur = byId.get(String(l.id));
      if (!cur || yearOf(l) > yearOf(cur)) byId.set(String(l.id), l);
    });
    return {
      connected: true,
      leagues: [...byId.values()].map(l => ({ id: `${plat}_${l.id}`, name: l.name || `League ${l.id}`, season: yearOf(l) })),
    };
  };
  const [mfl, yahoo] = await Promise.all([read("mfl_settings", "mfl"), read("yahoo_settings", "yh")]);
  return { mfl, yahoo };
}
