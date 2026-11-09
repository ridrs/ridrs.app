import { DatabaseSync } from "node:sqlite";
import { readFileSync } from "node:fs";
import crypto from "node:crypto";
import { b64uEncode, sha256Hex } from "../src/crypto.js";

// Minimal D1 look-alike on node:sqlite (prepare/bind/run/first/all/batch).
export function makeDb() {
  const db = new DatabaseSync(":memory:");
  db.exec(readFileSync(new URL("../migrations/0001_mailbox.sql", import.meta.url), "utf8"));
  const stmt = (sql, args = []) => ({
    bind: (...a) => stmt(sql, a),
    run: async () => {
      const r = db.prepare(sql).run(...args);
      return { meta: { changes: Number(r.changes) } };
    },
    first: async () => db.prepare(sql).get(...args) ?? null,
    all: async () => ({ results: db.prepare(sql).all(...args) }),
  });
  return {
    raw: db,
    prepare: (sql) => stmt(sql),
    batch: async (stmts) => {
      const out = [];
      db.exec("BEGIN");
      try {
        for (const s of stmts) out.push(await s.run());
        db.exec("COMMIT");
      } catch (e) {
        db.exec("ROLLBACK");
        throw e;
      }
      return out;
    },
  };
}

export function makeEnv(extra = {}) {
  return { DB: makeDb(), INTERVALS_WEBHOOK_SECRET: "s3cret-value", ...extra };
}

export function rawKeyFromPair(pair, kind) {
  const jwk = pair.publicKey.export({ format: "jwk" });
  return Buffer.from(jwk.x, "base64url");
}

export function newClient() {
  const sign = crypto.generateKeyPairSync("ed25519");
  const enc = crypto.generateKeyPairSync("x25519");
  return {
    sign,
    enc,
    signPub: b64uEncode(rawKeyFromPair(sign)),
    encPub: b64uEncode(rawKeyFromPair(enc)),
  };
}

export async function signedRequest(client, deviceId, method, pathAndQuery, { body = "", ts = Math.floor(Date.now() / 1000), tamper } = {}) {
  const message = `${method}\n${pathAndQuery}\n${ts}\n${await sha256Hex(new TextEncoder().encode(body))}`;
  const sig = crypto.sign(null, Buffer.from(message), client.sign.privateKey);
  return new Request(`https://ridrs.app${pathAndQuery}`, {
    method,
    body: body === "" ? undefined : body,
    headers: {
      "x-ridrs-device": deviceId,
      "x-ridrs-timestamp": String(ts),
      "x-ridrs-signature": tamper ? b64uEncode(Buffer.alloc(64)) : b64uEncode(sig),
    },
  });
}

// Independent decrypt using node:crypto only.
export function decryptEvent(client, deviceId, ev) {
  const ephRaw = Buffer.from(ev.eph_pub, "base64url");
  const eph = crypto.createPublicKey({
    key: { kty: "OKP", crv: "X25519", x: ev.eph_pub },
    format: "jwk",
  });
  const shared = crypto.diffieHellman({ privateKey: client.enc.privateKey, publicKey: eph });
  const key = Buffer.from(
    crypto.hkdfSync("sha256", shared, Buffer.concat([ephRaw, Buffer.from(client.encPub, "base64url")]), "ridrs-mailbox-v1", 32),
  );
  const blob = Buffer.from(ev.ciphertext, "base64url");
  const d = crypto.createDecipheriv("aes-256-gcm", key, blob.subarray(0, 12));
  d.setAAD(Buffer.from(`${deviceId}|${ev.type}|${ev.timestamp}`));
  d.setAuthTag(blob.subarray(blob.length - 16));
  return Buffer.concat([d.update(blob.subarray(12, blob.length - 16)), d.final()]).toString("utf8");
}
