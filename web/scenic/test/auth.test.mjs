// SPDX-License-Identifier: AGPL-3.0-or-later
// node --test test/ — Cloudflare Access JWT check and the localhost-only dev bypass (src/auth.js).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { verifyAccessJwt, adminIdentity, isLocalDevRequest, teamOrigin, sameOriginWrite } from '../src/auth.js';

const ORIGIN = 'https://myteam.cloudflareaccess.com', AUD = 'aud-tag-123';
const b64u = (buf) => Buffer.from(buf).toString('base64url');
const pair = await crypto.subtle.generateKey({ name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' }, true, ['sign', 'verify']);
const other = await crypto.subtle.generateKey({ name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' }, true, ['sign', 'verify']);
const jwk = { ...(await crypto.subtle.exportKey('jwk', pair.publicKey)), kid: 'k1' };
const getKeys = async (origin) => { assert.equal(origin, ORIGIN); return [jwk]; };
const now = Math.floor(Date.now() / 1000);

async function sign(payload, { key = pair.privateKey, kid = 'k1', alg = 'RS256' } = {}) {
  const head = b64u(JSON.stringify({ alg, kid, typ: 'JWT' })), body = b64u(JSON.stringify(payload));
  const sig = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', key, new TextEncoder().encode(`${head}.${body}`));
  return `${head}.${body}.${b64u(sig)}`;
}
const good = { aud: [AUD], email: 'editor@example.org', exp: now + 600, iat: now, iss: ORIGIN };

test('valid Access JWT is accepted', async () => {
  const p = await verifyAccessJwt(await sign(good), { origin: ORIGIN, aud: AUD, getKeys });
  assert.equal(p.email, 'editor@example.org');
});

test('wrong aud, expired, foreign signature, unknown key, other alg and garbage are rejected', async () => {
  const v = (t) => verifyAccessJwt(t, { origin: ORIGIN, aud: AUD, getKeys });
  await assert.rejects(v(await sign({ ...good, aud: ['other'] })), /aud/);
  await assert.rejects(v(await sign({ ...good, exp: now - 1 })), /expired/);
  await assert.rejects(v(await sign(good, { key: other.privateKey })), /signature/);
  await assert.rejects(v(await sign(good, { kid: 'nope' })), /unknown key/);
  await assert.rejects(v(await sign(good, { alg: 'HS256' })), /alg/);
  await assert.rejects(v(await sign({ ...good, iss: 'https://evil.cloudflareaccess.com' })), /issuer/);
  await assert.rejects(v('a.b'), /malformed/);
  await assert.rejects(verifyAccessJwt(await sign(good), { origin: ORIGIN, aud: '', getKeys }), /not configured/);
});

test('team domain forms', () => {
  assert.equal(teamOrigin('myteam'), ORIGIN);
  assert.equal(teamOrigin('myteam.cloudflareaccess.com'), ORIGIN);
  assert.equal(teamOrigin('https://myteam.cloudflareaccess.com/'), ORIGIN);
  assert.equal(teamOrigin(''), null);
});

test('adminIdentity: JWT header, and the dev bypass only for plain http on localhost', async () => {
  const env = { ACCESS_TEAM_DOMAIN: 'myteam', ACCESS_AUD: AUD };
  const req = (url, token) => new Request(url, { headers: token ? { 'Cf-Access-Jwt-Assertion': token } : {} });
  const token = await sign(good);
  assert.deepEqual(await adminIdentity(req('https://ridrs.example/api/admin/me', token), env, { getKeys }), { email: 'editor@example.org', via: 'access' });
  assert.equal(await adminIdentity(req('https://ridrs.example/api/admin/me'), env, { getKeys }), null);
  assert.equal(await adminIdentity(req('https://ridrs.example/api/admin/me', await sign({ ...good, aud: ['x'] })), env, { getKeys }), null);
  // Service token: no e-mail, the client id stands in.
  assert.equal((await adminIdentity(req('https://ridrs.example/x', await sign({ ...good, email: undefined, common_name: 'abc.access' })), env, { getKeys })).email, 'service:abc.access');

  const dev = { ...env, ADMIN_DEV_EMAIL: 'dev@localhost' };
  assert.deepEqual(await adminIdentity(req('http://localhost:8788/api/admin/me'), dev), { email: 'dev@localhost', via: 'dev' });
  assert.deepEqual(await adminIdentity(req('http://127.0.0.1:8790/admin/'), dev), { email: 'dev@localhost', via: 'dev' });
  assert.equal(await adminIdentity(req('https://ridrs.example/api/admin/me'), dev, { getKeys }), null, 'never on a real host');
  assert.equal(await adminIdentity(req('https://localhost/api/admin/me'), dev, { getKeys }), null, 'never over https');
  assert.equal(await adminIdentity(req('http://localhost.evil.example/api/admin/me'), dev, { getKeys }), null);
  assert.equal(await adminIdentity(req('http://localhost:8788/api/admin/me'), env, { getKeys }), null, 'no bypass without the variable');
  assert.equal(isLocalDevRequest('http://[::1]:8788/'), true);
  assert.equal(isLocalDevRequest('http://10.0.0.1/'), false);
});

test('rotated signing key: an unknown kid triggers one fresh key fetch', async () => {
  const rotated = { ...jwk, kid: 'k2' };
  let calls = 0;
  const keys = async (origin, { fresh = false } = {}) => { calls++; return fresh ? [jwk, rotated] : [jwk]; };
  const header = b64u(JSON.stringify({ alg: 'RS256', kid: 'k2' })), body = b64u(JSON.stringify(good));
  const sig = b64u(await crypto.subtle.sign('RSASSA-PKCS1-v1_5', pair.privateKey, new TextEncoder().encode(`${header}.${body}`)));
  const p = await verifyAccessJwt(`${header}.${body}.${sig}`, { origin: ORIGIN, aud: AUD, getKeys: keys });
  assert.equal(p.email, good.email);
  assert.equal(calls, 2);
});

test('CSRF guard: admin writes only from the same origin', () => {
  const r = (method, headers = {}) => new Request('https://ridrs.example/api/admin/videos/abc', { method, headers });
  assert.equal(sameOriginWrite(r('GET')), true);
  assert.equal(sameOriginWrite(r('POST', { Origin: 'https://ridrs.example' })), true);
  assert.equal(sameOriginWrite(r('POST', { Origin: 'https://evil.example' })), false);
  assert.equal(sameOriginWrite(r('DELETE', { 'Sec-Fetch-Site': 'same-origin' })), true);
  assert.equal(sameOriginWrite(r('POST', { 'Sec-Fetch-Site': 'cross-site' })), false);
  assert.equal(sameOriginWrite(r('POST')), false); // neither header: refuse
});
