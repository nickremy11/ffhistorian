/**
 * FF Historian — Cloudflare Worker
 * Caches Sleeper API responses in KV to avoid rate limits.
 * Routes:  /api/league/:leagueId/rosters
 *          /api/league/:leagueId/users
 *          /api/league/:leagueId/winners_bracket
 *          /api/league/:leagueId/matchups/:week
 *          /api/league/:leagueId/transactions/:week
 *          /api/league/:leagueId/trades   ← aggregates all trade transactions
 */

const SLEEPER_BASE = "https://api.sleeper.app/v1";

// Cache TTL in seconds
const TTL_ACTIVE_SEASON = 60 * 60;        // 1 hour  (in-season)
const TTL_OFFSEASON     = 60 * 60 * 24;   // 24 hours (off-season)
const ACTIVE_SEASON_YEAR = 2025;          // Update each year

function getTTL(leagueId) {
  // 2026 league is future/empty — cache aggressively
  if (leagueId === "1312218053051678720") return TTL_OFFSEASON;
  return ACTIVE_SEASON_YEAR === new Date().getFullYear()
    ? TTL_ACTIVE_SEASON
    : TTL_OFFSEASON;
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

    // Only handle /api/league/..., /api/players, or /api/espn/...
    if (!path.startsWith("/api/league/") && path !== "/api/players" && !path.startsWith("/api/espn/")) {
      return new Response("Not found", { status: 404 });
    }

    // ── ESPN R2 ROUTES ────────────────────────────────────
    // /api/espn/:leagueKey/:season  → serves season JSON from R2
    // /api/espn/:leagueKey/trades   → serves trades JSON from R2
    if (path.startsWith("/api/espn/")) {
      const espnSegments = path.replace("/api/espn/", "").split("/");
      const leagueKey   = espnSegments[0]; // e.g. "eliteffl"
      const seasonOrKey = espnSegments[1]; // e.g. "2025" or "trades"

      if (!leagueKey || !seasonOrKey) {
        return new Response(JSON.stringify({ error: "Invalid ESPN route" }), {
          status: 400,
          headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" },
        });
      }

      const r2Key = `espn/${leagueKey}/${seasonOrKey}.json`;

      try {
        const obj = await env.ESPN_DATA.get(r2Key);
        if (!obj) {
          return new Response(JSON.stringify({ error: "Not found", key: r2Key }), {
            status: 404,
            headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" },
          });
        }
        const body = await obj.text();
        return new Response(body, {
          headers: {
            "Content-Type": "application/json",
            "Access-Control-Allow-Origin": "*",
            "Cache-Control": "public, max-age=3600",
          },
        });
      } catch (e) {
        return new Response(JSON.stringify({ error: e.message }), {
          status: 500,
          headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" },
        });
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

    const ttl = getTTL(leagueId);

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

    // ── LEAGUE INFO (divisions, settings) ────────────────
    if (resource === "info") {
      return fetchWithCache(
        env,
        `info:${leagueId}`,
        `${SLEEPER_BASE}/league/${leagueId}`,
        TTL_OFFSEASON
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