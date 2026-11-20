// SPDX-License-Identifier: AGPL-3.0-or-later
// Admin access (CLOUDFLARE-KONZEPT.md 3.5): Cloudflare Access sits in front of /admin and /api/admin/*,
// and the worker checks the Access JWT itself (Cf-Access-Jwt-Assertion, RS256 against the team's JWKS,
// aud and exp), so a wrong Access rule alone never opens the admin.
//
// Env: ACCESS_TEAM_DOMAIN (e.g. "myteam" or "myteam.cloudflareaccess.com"), ACCESS_AUD (the application's AUD tag).
// Local development only: ADMIN_DEV_EMAIL in .dev.vars stands in for the JWT, but only for plain-http
// requests to localhost / 127.0.0.1 / [::1] (wrangler dev). Production requests are https on the real
// hostname, so the bypass can never apply there, even if the variable were set by mistake.

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]', '::1']);
const b64url = (s) => Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((s.length + 3) % 4)), (c) => c.charCodeAt(0));
const decodeJson = (s) => JSON.parse(new TextDecoder().decode(b64url(s)));

export const teamOrigin = (team) => {
  const host = String(team || '').replace(/^https?:\/\//, '').replace(/\/.*$/, '');
  return host ? `https://${host.includes('.') ? host : `${host}.cloudflareaccess.com`}` : null;
};

/** True only for the local dev server: plain http on a loopback hostname. */
export function isLocalDevRequest(url) {
  const u = typeof url === 'string' ? new URL(url) : url;
  return u.protocol === 'http:' && LOCAL_HOSTS.has(u.hostname);
}

/**
 * CSRF guard for admin writes: the Access cookie travels with any cross-site request, so a POST/PUT/DELETE
 * must come from this site's own pages (Origin header, or Sec-Fetch-Site when a browser omits Origin).
 * Reads (GET/HEAD, e.g. pull_manual.mjs with a service token) need no origin.
 */
export function sameOriginWrite(request) {
  if (request.method === 'GET' || request.method === 'HEAD') return true;
  const origin = request.headers.get('Origin');
  if (origin) return origin === new URL(request.url).origin;
  return request.headers.get('Sec-Fetch-Site') === 'same-origin';
}

let jwksCache = { origin: null, at: 0, keys: null };
async function fetchKeys(origin, { fresh = false } = {}) {
  if (!fresh && jwksCache.origin === origin && Date.now() - jwksCache.at < 3600_000 && jwksCache.keys) return jwksCache.keys;
  const res = await fetch(`${origin}/cdn-cgi/access/certs`);
  if (!res.ok) throw new Error(`JWKS ${res.status}`);
  const { keys } = await res.json();
  jwksCache = { origin, at: Date.now(), keys };
  return keys;
}

/**
 * Verifies a Cloudflare Access JWT. Returns the payload, or throws with a short reason.
 * @param {string} token
 * @param {{origin: string, aud: string, now?: number, getKeys?: (origin: string) => Promise<JsonWebKey[]>}} o
 */
export async function verifyAccessJwt(token, { origin, aud, now = Date.now() / 1000, getKeys = fetchKeys }) {
  if (!origin || !aud) throw new Error('access not configured');
  const parts = String(token || '').split('.');
  if (parts.length !== 3) throw new Error('malformed token');
  const header = decodeJson(parts[0]), payload = decodeJson(parts[1]);
  if (header.alg !== 'RS256') throw new Error('unexpected alg');
  let jwk = (await getKeys(origin)).find((k) => k.kid === header.kid);
  // Access rotates its signing keys: an unknown kid may be newer than the cached key set, so ask once more.
  if (!jwk) jwk = (await getKeys(origin, { fresh: true })).find((k) => k.kid === header.kid);
  if (!jwk) throw new Error('unknown key');
  const key = await crypto.subtle.importKey('jwk', { kty: jwk.kty, n: jwk.n, e: jwk.e, alg: 'RS256', ext: true },
    { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['verify']);
  const ok = await crypto.subtle.verify('RSASSA-PKCS1-v1_5', key, b64url(parts[2]), new TextEncoder().encode(`${parts[0]}.${parts[1]}`));
  if (!ok) throw new Error('bad signature');
  const auds = Array.isArray(payload.aud) ? payload.aud : [payload.aud];
  if (!auds.includes(aud)) throw new Error('wrong aud');
  if (!(payload.exp > now)) throw new Error('expired');
  if (payload.nbf && payload.nbf > now + 60) throw new Error('not yet valid');
  if (payload.iss && payload.iss !== origin) throw new Error('wrong issuer');
  return payload;
}

/**
 * The admin identity of a request: {email, via: 'access' | 'dev'} or null (→ 403).
 * Service tokens (pull_manual.mjs in CI) carry no e-mail; their common_name (client id) is used instead.
 */
export async function adminIdentity(request, env, { getKeys } = {}) {
  const url = new URL(request.url);
  if (env.ADMIN_DEV_EMAIL && isLocalDevRequest(url)) return { email: env.ADMIN_DEV_EMAIL, via: 'dev' };
  const token = request.headers.get('Cf-Access-Jwt-Assertion');
  if (!token) return null;
  try {
    const p = await verifyAccessJwt(token, { origin: teamOrigin(env.ACCESS_TEAM_DOMAIN), aud: env.ACCESS_AUD, getKeys });
    const email = p.email || (p.common_name ? `service:${p.common_name}` : null);
    return email ? { email, via: 'access' } : null;
  } catch (err) {
    console.warn('admin auth:', err.message);
    return null;
  }
}
