// Bounce pages: the OAuth redirect of intervals.icu and the activity link
// template hand over to the app through its custom scheme. The targets are
// fixed (ridrs://oauth/intervals, ridrs://activity/<id>); only validated values
// are put into them. Nothing here is logged.
import { sha256 } from "./crypto.js";

const CODE_RE = /^[A-Za-z0-9._~-]{1,512}$/;
const STATE_RE = /^[A-Za-z0-9._~-]{8,256}$/;
const ERROR_RE = /^[A-Za-z0-9._ -]{1,64}$/;
const EXTERNAL_ID_RE = /^[A-Za-z0-9._-]{1,128}$/;
const MAX_ERROR_DESCRIPTION = 512;

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

async function bouncePage(target) {
  const script = `location.replace(${jsString(target)});`;
  const hash = btoa(String.fromCharCode(...(await sha256(script))));
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
<p>Returning to ridrs ...</p>
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
      "content-security-policy": `default-src 'none'; style-src 'unsafe-inline'; script-src 'sha256-${hash}'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`,
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
  return bouncePage(`ridrs://oauth/intervals?${q.join("&")}`);
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
