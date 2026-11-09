import crypto from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { b64uDecode, b64uEncode, encryptForDevice } from "../src/crypto.js";

const VECTOR_URL = new URL("../test-vectors/mailbox-v1.json", import.meta.url);
const fixedInputs = () => ({
  device_id: "AAAAAAAAAAAAAAAAAAAAAA",
  type: "ACTIVITY_UPLOADED",
  timestamp: "2026-01-01T10:00:00",
  plaintext: JSON.stringify({ athlete_id: "i42", type: "ACTIVITY_UPLOADED", timestamp: "2026-01-01T10:00:00" }),
  device_enc_priv: b64uEncode(Uint8Array.from({ length: 32 }, (_, i) => i + 1)),
  eph_priv: b64uEncode(Uint8Array.from({ length: 32 }, (_, i) => 0x80 + i)),
  nonce: b64uEncode(Uint8Array.from({ length: 12 }, (_, i) => 0xa0 + i)),
});

function x25519Pub(privB64) {
  const pkcs8 = Buffer.concat([Buffer.from("302e020100300506032b656e04220420", "hex"), Buffer.from(privB64, "base64url")]);
  const key = crypto.createPrivateKey({ key: pkcs8, format: "der", type: "pkcs8" });
  return crypto.createPublicKey(key).export({ format: "jwk" }).x;
}

async function computeVector() {
  const i = fixedInputs();
  const device_enc_pub = x25519Pub(i.device_enc_priv);
  const out = await encryptForDevice({
    encPub: b64uDecode(device_enc_pub),
    deviceId: i.device_id,
    type: i.type,
    timestamp: i.timestamp,
    plaintext: i.plaintext,
    fixed: { ephPriv: b64uDecode(i.eph_priv), nonce: b64uDecode(i.nonce) },
  });
  return {
    description: "ridrs mailbox v1: X25519 + HKDF-SHA256 (salt = eph_pub || enc_pub, info = 'ridrs-mailbox-v1') + AES-256-GCM (aad = device_id|type|timestamp). Binary values are base64url without padding; ciphertext = nonce || ct || tag.",
    ...i,
    device_enc_pub,
    eph_pub: out.ephPub,
    ciphertext: out.ciphertext,
  };
}

describe("mailbox crypto", () => {
  it("base64url round trips", () => {
    for (const n of [0, 1, 2, 3, 31, 32]) {
      const b = crypto.randomBytes(n);
      expect(Buffer.from(b64uDecode(b64uEncode(b)))).toEqual(b);
    }
    expect(b64uDecode("a+b")).toBeNull();
    expect(b64uDecode("a")).toBeNull();
  });
  it("matches the published test vector", async () => {
    if (process.env.UPDATE_VECTOR) writeFileSync(VECTOR_URL, `${JSON.stringify(await computeVector(), null, 2)}\n`);
    const committed = JSON.parse(readFileSync(VECTOR_URL, "utf8"));
    expect(await computeVector()).toEqual(committed);
  });
  it("the test vector decrypts with an independent implementation", () => {
    const v = JSON.parse(readFileSync(VECTOR_URL, "utf8"));
    const pkcs8 = Buffer.concat([Buffer.from("302e020100300506032b656e04220420", "hex"), Buffer.from(v.device_enc_priv, "base64url")]);
    const priv = crypto.createPrivateKey({ key: pkcs8, format: "der", type: "pkcs8" });
    const eph = crypto.createPublicKey({ key: { kty: "OKP", crv: "X25519", x: v.eph_pub }, format: "jwk" });
    const shared = crypto.diffieHellman({ privateKey: priv, publicKey: eph });
    const salt = Buffer.concat([Buffer.from(v.eph_pub, "base64url"), Buffer.from(v.device_enc_pub, "base64url")]);
    const key = Buffer.from(crypto.hkdfSync("sha256", shared, salt, "ridrs-mailbox-v1", 32));
    const blob = Buffer.from(v.ciphertext, "base64url");
    expect(blob.subarray(0, 12)).toEqual(Buffer.from(v.nonce, "base64url"));
    const d = crypto.createDecipheriv("aes-256-gcm", key, blob.subarray(0, 12));
    d.setAAD(Buffer.from(`${v.device_id}|${v.type}|${v.timestamp}`));
    d.setAuthTag(blob.subarray(blob.length - 16));
    expect(Buffer.concat([d.update(blob.subarray(12, blob.length - 16)), d.final()]).toString()).toBe(v.plaintext);
  });
});
