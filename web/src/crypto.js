// Helpers for the mailbox: base64url, SHA-256, constant-time compare and the
// per-event encryption (X25519 + HKDF-SHA256 + AES-256-GCM), see PROTOCOL.md.

const encoder = new TextEncoder();

export function b64uEncode(bytes) {
  let bin = "";
  const u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  for (let i = 0; i < u8.length; i++) bin += String.fromCharCode(u8[i]);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function b64uDecode(str) {
  if (typeof str !== "string" || !/^[A-Za-z0-9_-]*$/.test(str) || str.length % 4 === 1) return null;
  const b64 = str.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((str.length + 3) % 4);
  try {
    const bin = atob(b64);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  } catch {
    return null;
  }
}

export function hex(bytes) {
  return [...new Uint8Array(bytes)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export async function sha256(data) {
  const bytes = typeof data === "string" ? encoder.encode(data) : data;
  return new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
}

export async function sha256Hex(data) {
  return hex(await sha256(data));
}

// Constant-time string comparison: compares the SHA-256 digests of both values.
export async function timingSafeEqualStr(a, b) {
  const [da, db] = await Promise.all([sha256(String(a)), sha256(String(b))]);
  let diff = 0;
  for (let i = 0; i < da.length; i++) diff |= da[i] ^ db[i];
  return diff === 0;
}

export function randomId() {
  return b64uEncode(crypto.getRandomValues(new Uint8Array(16)));
}

// PKCS#8 prefix of a raw 32 byte X25519 private key.
const X25519_PKCS8 = new Uint8Array([
  0x30, 0x2e, 0x02, 0x01, 0x00, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x6e, 0x04, 0x22, 0x04, 0x20,
]);

async function x25519FromPrivate(raw) {
  const pkcs8 = new Uint8Array(X25519_PKCS8.length + 32);
  pkcs8.set(X25519_PKCS8);
  pkcs8.set(raw, X25519_PKCS8.length);
  const key = await crypto.subtle.importKey("pkcs8", pkcs8, { name: "X25519" }, true, ["deriveBits"]);
  const jwk = await crypto.subtle.exportKey("jwk", key);
  return { key, pub: b64uDecode(jwk.x) };
}

async function ephemeralKeyPair(fixedPriv) {
  if (fixedPriv) return x25519FromPrivate(fixedPriv);
  const pair = await crypto.subtle.generateKey({ name: "X25519" }, true, ["deriveBits"]);
  const pub = new Uint8Array(await crypto.subtle.exportKey("raw", pair.publicKey));
  return { key: pair.privateKey, pub };
}

// Encrypts `plaintext` (a string) for one device. `fixed` ({ephPriv, nonce}) is
// only for the published test vector.
export async function encryptForDevice({ encPub, deviceId, type, timestamp, plaintext, fixed }) {
  const eph = await ephemeralKeyPair(fixed?.ephPriv);
  const peer = await crypto.subtle.importKey("raw", encPub, { name: "X25519" }, false, []);
  const shared = await crypto.subtle.deriveBits({ name: "X25519", public: peer }, eph.key, 256);
  const salt = new Uint8Array(64);
  salt.set(eph.pub);
  salt.set(encPub, 32);
  const hkdfKey = await crypto.subtle.importKey("raw", shared, "HKDF", false, ["deriveKey"]);
  const aesKey = await crypto.subtle.deriveKey(
    { name: "HKDF", hash: "SHA-256", salt, info: encoder.encode("ridrs-mailbox-v1") },
    hkdfKey,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt"],
  );
  const nonce = fixed?.nonce ?? crypto.getRandomValues(new Uint8Array(12));
  const aad = encoder.encode(`${deviceId}|${type}|${timestamp}`);
  const sealed = new Uint8Array(
    await crypto.subtle.encrypt({ name: "AES-GCM", iv: nonce, additionalData: aad }, aesKey, encoder.encode(plaintext)),
  );
  const out = new Uint8Array(12 + sealed.length);
  out.set(nonce);
  out.set(sealed, 12);
  return { ephPub: b64uEncode(eph.pub), ciphertext: b64uEncode(out) };
}
