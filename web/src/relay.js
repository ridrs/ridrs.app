// Bounce pages: the OAuth redirect of intervals.icu and the activity link
// template hand over to the app through its custom scheme. The targets are
// fixed (ridrs://oauth/intervals, ridrs://activity/<id>); only validated values
// are put into them. Nothing here is logged.
import { sha256, sha256Hex, b64uEncode } from "./crypto.js";
import { readBody } from "./signing.js";

const CODE_RE = /^[A-Za-z0-9._~-]{1,512}$/;
const STATE_RE = /^[A-Za-z0-9._~-]{8,256}$/;
const ERROR_RE = /^[A-Za-z0-9._ -]{1,64}$/;
const EXTERNAL_ID_RE = /^[A-Za-z0-9._-]{1,128}$/;
const MAX_ERROR_DESCRIPTION = 512;
// The result of a sign-in, reported by the app (POST /intervals/oauth/result) and polled by the bounce page.
const RESULT_STATE_RE = /^[A-Za-z0-9._~-]{16,128}$/;
const MAX_RESULT_BODY = 512;
const RESULT_PER_HOUR = 1200;
export const OAUTH_RESULT_TTL_SECONDS = 10 * 60;
const now = () => Math.floor(Date.now() / 1000);

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function jsString(s) {
  return JSON.stringify(s).replace(/</g, "\\u003c").replace(/\u2028/g, "\\u2028").replace(/\u2029/g, "\\u2029");
}

// The page of the OAuth target also shows what became of the sign-in: the script bounces to the
// app, then asks POST /intervals/oauth/status (same origin, the state in the body, never in a URL)
// until the app reported a result, for at most three minutes.
function oauthScript(target) {
  return `(function(){var t=${jsString(target)},s=document.getElementById("s"),m=/[?&]state=([A-Za-z0-9._~-]{16,128})(?:&|$)/.exec(t),n=0;function say(x){s.textContent=x}say("Opening ridrs ...");location.replace(t);if(!m)return;var b=JSON.stringify({state:m[1]}),end=Date.now()+180000;function again(){if(Date.now()>end){say("Nothing heard from the app. Is ridrs open?");return}setTimeout(poll,1500)}function poll(){fetch("/intervals/oauth/status",{method:"POST",cache:"no-store",credentials:"omit",referrerPolicy:"no-referrer",headers:{"content-type":"application/json"},body:b}).then(function(r){return r.ok?r.json():null}).then(function(d){var v=d&&d.status;if(v==="ok")say("Connected. You can close this page.");else if(v==="failed")say("The connection failed. Go back to ridrs and try again.");else{if(v==="pending"&&n++===0)say("Finishing in the app ...");again()}},again)}again()})();`;
}

async function bouncePage(target, { watch = false, note = "Returning to ridrs ..." } = {}) {
  const script = watch ? oauthScript(target) : `location.replace(${jsString(target)});`;
  const hash = btoa(String.fromCharCode(...(await sha256(script))));
  const connect = watch ? "connect-src 'self'; " : "";
  const html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<meta name="referrer" content="no-referrer">
<meta name="robots" content="noindex">
<title>Open ridrs</title>
<style>body{background:#07090e;color:#f1f5f9;font-family:-apple-system,BlinkMacSystemFont,sans-serif;display:flex;min-height:100vh;align-items:center;justify-content:center;margin:0;text-align:center}a{display:inline-block;margin-top:1rem;padding:.8rem 1.6rem;background:#00f0ff;color:#07090e;border-radius:.5rem;font-weight:700;text-decoration:none}</style>
</head>
<body>
<main>
<p id="s">${escapeHtml(note)}</p>
<a href="${escapeHtml(target)}">Open ridrs</a>
</main>
<script>${script}</script>
</body>
</html>`;
  return new Response(html, {
    status: 200,
    headers: {
      "content-type": "text/html;charset=UTF-8",
      "cache-control": "no-store",
      "referrer-policy": "no-referrer",
      "x-content-type-options": "nosniff",
      "content-security-policy": `default-src 'none'; ${connect}style-src 'unsafe-inline'; script-src 'sha256-${hash}'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`,
    },
  });
}

function badRequest() {
  return new Response(JSON.stringify({ error: "bad_request" }), {
    status: 400,
    headers: { "content-type": "application/json", "cache-control": "no-store" },
  });
}

export async function handleOAuthCallback(request) {
  if (request.method !== "GET" && request.method !== "HEAD") return methodNotAllowed("GET");
  const params = new URL(request.url).searchParams;
  const seen = new Set();
  for (const key of params.keys()) {
    if (!["code", "state", "error", "error_description"].includes(key) || seen.has(key)) return badRequest();
    seen.add(key);
  }
  const code = params.get("code");
  const state = params.get("state");
  const error = params.get("error");
  const description = params.get("error_description");
  if (state !== null && !STATE_RE.test(state)) return badRequest();
  const q = [];
  if (error !== null) {
    if (code !== null || !ERROR_RE.test(error)) return badRequest();
    if (description !== null && description.length > MAX_ERROR_DESCRIPTION) return badRequest();
    q.push(`error=${encodeURIComponent(error)}`);
    if (description !== null) q.push(`error_description=${encodeURIComponent(description)}`);
    if (state !== null) q.push(`state=${encodeURIComponent(state)}`);
  } else {
    if (description !== null || code === null || state === null || !CODE_RE.test(code)) return badRequest();
    q.push(`code=${encodeURIComponent(code)}`, `state=${encodeURIComponent(state)}`);
  }
  const target = `ridrs://oauth/intervals?${q.join("&")}`;
  // A denied sign-in is still handed to the app (it shows it), but there is nothing to wait for.
  if (error !== null) return bouncePage(target, { note: "Sign-in was cancelled. You can close this page." });
  return bouncePage(target, { watch: true, note: "Opening ridrs ..." });
}

export async function handleActivity(request, externalId) {
  if (request.method !== "GET" && request.method !== "HEAD") return methodNotAllowed("GET");
  if (!EXTERNAL_ID_RE.test(externalId)) return notFound();
  return bouncePage(`ridrs://activity/${externalId}`);
}

export function notFound() {
  return new Response("Not found", { status: 404, headers: { "cache-control": "no-store" } });
}

export function methodNotAllowed(allow) {
  return new Response(JSON.stringify({ error: "method_not_allowed" }), {
    status: 405,
    headers: { "content-type": "application/json", allow },
  });
}

// ---- the result of a sign-in ---------------------------------------------------

function plain(status, body) {
  return new Response(body === undefined ? null : JSON.stringify(body), {
    status,
    headers: { "cache-control": "no-store", ...(body === undefined ? {} : { "content-type": "application/json" }) },
  });
}

async function rateLimited(env, request) {
  const ip = request.headers.get("cf-connecting-ip") ?? "unknown";
  const key = await sha256Hex(`oauth|${ip}`);
  const row = await env.DB.prepare(
    "INSERT INTO rate_limits (key, window, count) VALUES (?, ?, 1) ON CONFLICT (key, window) DO UPDATE SET count = count + 1 RETURNING count",
  )
    .bind(key, Math.floor(now() / 3600))
    .first();
  return row.count > RESULT_PER_HOUR;
}

// Reads {"state", ...} strictly: JSON content type, at most 512 bytes. Returns the parsed object or a Response.
async function readResultBody(request) {
  if (!/^application\/json\s*(;|$)/i.test(request.headers.get("content-type") ?? "")) return plain(415, { error: "bad_request" });
  const bytes = await readBody(request, MAX_RESULT_BODY);
  if (!bytes) return plain(413, { error: "too_large" });
  let data;
  try {
    data = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    return plain(400, { error: "bad_request" });
  }
  if (data === null || typeof data !== "object" || Array.isArray(data) || typeof data.state !== "string" || !RESULT_STATE_RE.test(data.state)) {
    return plain(400, { error: "bad_request" });
  }
  return data;
}

const stateHash = async (state) => b64uEncode(await sha256(state));

export async function purgeOAuthResults(env, t = now()) {
  await env.DB.prepare("DELETE FROM oauth_results WHERE created_at < ?").bind(t - OAUTH_RESULT_TTL_SECONDS).run();
}

// POST /intervals/oauth/result {"state","ok"}: the app reports how the sign-in ended. Not signed: the
// app has no device key yet; the random state, known only to the browser and the app, is the secret.
// Only a hash of it is kept, the first report wins, and nothing is logged.
export async function handleOAuthResult(request, env) {
  if (request.method !== "POST") return methodNotAllowed("POST");
  if (await rateLimited(env, request)) return plain(429, { error: "rate_limited" });
  const data = await readResultBody(request);
  if (data instanceof Response) return data;
  if (typeof data.ok !== "boolean") return plain(400, { error: "bad_request" });
  const t = now();
  await purgeOAuthResults(env, t);
  await env.DB.prepare("INSERT OR IGNORE INTO oauth_results (state_hash, ok, created_at) VALUES (?, ?, ?)")
    .bind(await stateHash(data.state), data.ok ? 1 : 0, t)
    .run();
  return plain(204);
}

// POST /intervals/oauth/status {"state"} -> {"status":"pending"|"ok"|"failed"}. POST, so the state is never in a URL.
// Same origin only: no CORS headers are ever sent.
export async function handleOAuthStatus(request, env) {
  if (request.method !== "POST") return methodNotAllowed("POST");
  if (await rateLimited(env, request)) return plain(429, { error: "rate_limited" });
  const data = await readResultBody(request);
  if (data instanceof Response) return data;
  const row = await env.DB.prepare("SELECT ok FROM oauth_results WHERE state_hash = ? AND created_at >= ?")
    .bind(await stateHash(data.state), now() - OAUTH_RESULT_TTL_SECONDS)
    .first();
  return plain(200, { status: row ? (row.ok ? "ok" : "failed") : "pending" });
}
