export async function onRequest({ request }) {
  const bm = request.cf?.botManagement ?? {};
  
  const url = new URL(request.url);
  
  // Inject bot score as GA4 Measurement Protocol event parameters
  if (bm.score !== undefined && bm.score !== null) {
    url.epn.cf_bot_score = bm.score;        // numeric parameter
    url.searchParams.set('epn.cf_bot_score', bm.score);
    url.searchParams.set('ep.cf_verified_bot', String(bm.verifiedBot ?? false));
  }
  
  // Forward to real GA4 collect endpoint
  url.hostname = 'www.google-analytics.com';
  url.pathname = url.pathname.replace('/analytics', '');
  
  return fetch(new Request(url.toString(), {
    method: request.method,
    headers: request.headers,
    body: request.body
  }));
}
