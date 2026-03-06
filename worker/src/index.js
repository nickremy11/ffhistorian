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

    // Only handle /api/league/... or /api/players
    if (!path.startsWith("/api/league/") && path !== "/api/players") {
      return new Response("Not found", { status: 404 });
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

      // Fetch all 18 weeks of transactions in parallel
      const weekFetches = Array.from({ length: 18 }, (_, i) =>
        fetch(`${SLEEPER_BASE}/league/${leagueId}/transactions/${i + 1}`)
          .then(r => r.ok ? r.json() : [])
          .catch(() => [])
      );
      const allWeeks = await Promise.all(weekFetches);
      const trades = allWeeks
        .flat()
        .filter(tx => tx.type === "trade" && tx.status === "complete");

      const body = JSON.stringify(trades);
      await env.FF_CACHE.put(cacheKey, body, { expirationTtl: ttl });

      return new Response(body, {
        headers: {
          "Content-Type": "application/json",
          "X-Cache": "MISS",
          "Access-Control-Allow-Origin": "*",
        },
      });
    }

    return new Response(JSON.stringify({ error: "Unknown resource" }), {
      status: 404,
      headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" },
    });
  },
};
