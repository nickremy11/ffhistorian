// ════════════════════════════════════════════════════════════════════════════
// ESPN reads, and whose cookies they use.
//
//   Curated leagues (ESPN_LEAGUES in index.js: eliteffl, wolfpack, standrews) use
//   this worker's own ESPN_S2 / ESPN_SWID secrets, exactly as before.
//   Generic leagues (any ESPN league opened at /l/espn_{id}) use the cookies of the
//   account that opened it, fetched from helper's private EspnCookies entrypoint
//   (the HELPER service binding). With none, the read goes out cookie-less, which
//   is enough for a public ESPN league.
// ════════════════════════════════════════════════════════════════════════════
export const ESPN_BASE = "https://lm-api-reads.fantasy.espn.com/apis/v3/games/ffl";

// One account's cookie header, or null. Never throws.
export async function userEspnCookie(env, userId) {
  if (!userId || !env.HELPER) return null;
  try {
    const r = await env.HELPER.fetch(`https://helper/cookie?user=${encodeURIComponent(userId)}`);
    if (!r.ok) return null;
    const d = await r.json();
    return d.espn_s2 && d.swid ? `espn_s2=${d.espn_s2}; SWID=${d.swid}` : null;
  } catch (e) {
    console.warn("helper cookie lookup:", e.message);
    return null;
  }
}

async function cookieFor(env, league) {
  if (!league?.generic) {
    if (!env.ESPN_S2 || !env.ESPN_SWID) throw new Error("ESPN cookies not configured");
    return `espn_s2=${env.ESPN_S2}; SWID=${env.ESPN_SWID}`;
  }
  if (league._cookie === undefined) league._cookie = await userEspnCookie(env, league.owner);
  return league._cookie;
}

// `league` decides the cookies; a call without one is a curated read (old behaviour).
export async function espnFetch(env, url, league, extraHeaders = {}) {
  const cookie = league?.cookie !== undefined ? league.cookie : await cookieFor(env, league);
  const headers = { Accept: "application/json", "User-Agent": "Mozilla/5.0", ...extraHeaders };
  if (cookie) headers.Cookie = cookie;
  const res = await fetch(url, { headers });
  if (!res.ok) throw new Error(`ESPN ${res.status}`);
  return res.json();
}
