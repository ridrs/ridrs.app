# ridrs relay and mailbox protocol (v1)

Base URL `https://ridrs.app`. JSON bodies are UTF-8. Binary values are base64url without padding.
Errors are `{ "error": "<code>" }` (`bad_request`, `unauthorized` (webhook secret, intervals.icu token), `unknown_device`, `stale_timestamp`, `bad_signature`, `rate_limited`, `too_large`, `upstream_error`, `method_not_allowed`, `upgrade_required`, `internal`). No CORS headers.

## 1. OAuth bounce: `GET /intervals/oauth/callback`
Query: `code` + `state`, or `error` (+ optional `error_description`, `state`). Nothing else is accepted, no parameter may repeat, otherwise 400.
`state` `^[A-Za-z0-9._~-]{8,256}$`, `code` `^[A-Za-z0-9._~-]{1,512}$`, `error` `^[A-Za-z0-9._ -]{1,64}$`, `error_description` at most 512 characters (percent-encoded into the target).
Answer 200 HTML (`Cache-Control: no-store`, `Referrer-Policy: no-referrer`, a CSP that allows only the one inline script) that sets `location` to the fixed target `ridrs://oauth/intervals?code=..&state=..` (or `?error=..&error_description=..&state=..`) and shows an "Open ridrs" link. For `code`+`state` the page also shows a status line and its script asks `POST /intervals/oauth/status` (section 1a) every 1.5 s, for at most 3 minutes, until the app reported how the sign-in ended: "Opening ridrs ...", "Finishing in the app ...", "Connected. You can close this page.", "The connection failed. Go back to ridrs and try again.", or after the time-out "Nothing heard from the app. Is ridrs open?". Merely following the link never counts as success. The CSP then also has `connect-src 'self'`. With `error=` (denied) the page says so, still bounces, and does not poll.

## 1a. Sign-in result: `POST /intervals/oauth/result` and `POST /intervals/oauth/status`
`result`, from the app after the token exchange: body `{ "state", "ok" }` (`Content-Type: application/json`, at most 512 bytes, `state` `^[A-Za-z0-9._~-]{16,128}$`, `ok` a boolean) -> `204`. Not signed: the app has no device key at that point; the random state (190 bits, known only to the browser and the app) is the secret. Only `base64url(sha256(state))` is stored (`oauth_results`), the first report for a state wins (`INSERT OR IGNORE`), nothing is logged. Errors: 400 `bad_request`, 413 `too_large`, 415 `bad_request` (wrong content type), 429 `rate_limited` (1200 per IP per hour, the `rate_limits` table, key `oauth|ip`).
`status`, from the bounce page: body `{ "state" }`, same validation -> `200 {"status":"pending"|"ok"|"failed"}`. POST so that the state never lands in a URL or a log. No CORS headers: only the same origin (the bounce page) can read it. Rows older than 10 minutes are deleted on every report and by the cron; later the status is `pending` again. All answers are `Cache-Control: no-store`.

## 2. Activity link: `GET /activities/<external_id>`
`external_id` `^[A-Za-z0-9._-]{1,128}$`, else 404. Same bounce page to `ridrs://activity/<external_id>`.

## 3. Webhook: `POST /intervals/webhook`
Secret in header `X-Webhook-Authorization`; if the header is absent, in the JSON body field `secret`. Constant-time comparison with `INTERVALS_WEBHOOK_SECRET`; wrong, missing or unconfigured: 401. Body limit 256 KiB (413). Body `{ "secret"?, "events": [ { "athlete_id", "type", "timestamp", ... } ] }` (at most 500 events are processed).
Authorized requests always get `200 {}`. Kept types: `ACTIVITY_UPLOADED`, `ACTIVITY_ANALYZED`, `CALENDAR_UPDATED`, `SPORT_SETTINGS_UPDATED`, `WELLNESS_UPDATED`, `APP_SCOPE_CHANGED`. Other types, malformed events (athlete_id must be a string or number matching `^[A-Za-z0-9_.-]{1,64}$`, timestamp a string of 1..64 characters) and unknown athletes are dropped silently.
For each event and each device of the athlete one encrypted row is inserted; row id = sha256 hex of `athlete_id|type|timestamp|device_id`, `INSERT OR IGNORE`. The encrypted plaintext is the whole event object as received.

## 4. Register: `POST /devices`
Body `{ "token", "sign_pub", "enc_pub", "name"? }` (`sign_pub`: raw 32 byte Ed25519 key, `enc_pub`: raw 32 byte X25519 key, `name` at most 64 characters). The server calls `GET https://intervals.icu/api/v1/athlete/0` with `Authorization: Bearer <token>`; non-200: 401, network failure or unusable answer: 502. The string `id` is the athlete id. The token is never stored or logged. At most 5 devices per athlete (the oldest is deleted with its rows). Answer `{ "device_id" }` (128 bit random, base64url, 22 characters). Rate limit 10 registrations per IP per hour (429), kept in D1.

## 5. Signed requests
Headers `X-Ridrs-Device`, `X-Ridrs-Timestamp` (unix seconds), `X-Ridrs-Signature` = b64url(Ed25519) over the UTF-8 string
`METHOD "\n" pathAndQuery "\n" timestamp "\n" lowercase-hex-sha256(body)` (`pathAndQuery` = path plus raw query string, e.g. `/updates?since=12&limit=50`; empty body hashes the empty string). Body limit 4 KiB.
Accepted if the device is known, `|now - timestamp| <= 300`, `timestamp > last_ts` and the signature verifies; then `last_ts` is set with `UPDATE ... WHERE last_ts < ?` (atomic). Failures are `401` with one of three codes so the client can react:
- `{"error":"unknown_device"}`: no such registered device (deleted, replaced, purged, never registered). The client must register again. (This reveals whether a device id exists; ids are 128 bit random.)
- `{"error":"stale_timestamp"}`: outside the 300 s window, or not greater than the device's `last_ts` (replay, two requests in the same second, or a lost race). The client should correct its clock and use a strictly increasing timestamp (`max(now, last + 1)`).
- `{"error":"bad_signature"}`: malformed timestamp/signature, signature mismatch, body too large, or (DELETE) a path id different from the header id.
The same codes apply to `GET /updates/ws` (as 401 before the upgrade; for that path any query other than exactly `device`, `ts`, `sig` gives `bad_signature`).

## 6. `GET /updates?since=<cursor>&limit=<n>` (signed)
`since` default 0, `limit` default 50, at most 100. Answer `{ "events": [ { "cursor", "id", "type", "timestamp", "eph_pub", "ciphertext" } ], "next", "more" }`, cursor ascending; `next` is the last returned cursor (or `since` if none).

## 7. `POST /updates/ack` (signed), body `{ "upto": n }`
Deletes this device's rows with cursor <= n. Answer `{}`.

## 8. `DELETE /devices/<device_id>` (signed)
Path id must equal the header id. Deletes the device and its rows, closes its socket with 4401. Answer `{}`.

## 9. Encryption of one event per device
plaintext = UTF-8 JSON of the event. Fresh X25519 key pair per event; `shared = X25519(eph_priv, device.enc_pub)`; `key = HKDF-SHA256(ikm = shared, salt = eph_pub_raw || enc_pub_raw, info = "ridrs-mailbox-v1", 32 bytes)`; AES-256-GCM, random 12 byte nonce, `aad = UTF-8(device_id + "|" + type + "|" + timestamp)`; `ciphertext = nonce || ct || tag` (base64url), `eph_pub` base64url. Test vector: `test-vectors/mailbox-v1.json` (includes the device private key, ephemeral private key and nonce).

## 10. Retention
Rows older than 30 days are deleted (daily cron `17 3 * * *`, and opportunistically for the polling device on each `GET /updates`). Devices not seen (last signed request or registration) for 180 days are deleted with their rows. No event deletes anything automatically.

## 11. Push: `GET /updates/ws?device=<device_id>&ts=<unix s>&sig=<b64url>`
Needs `Upgrade: websocket` (else 426). Query is exactly these three parameters. Signed string: `"GET\n/updates/ws\n" + ts + "\n" + sha256hex("")` (path without the query). Same checks as section 5; failure: 401 with the codes of section 5 before the upgrade. The Worker forwards the upgrade to Durable Object `MailboxHub` (`idFromName(device_id)`).
- One socket per device: a new connection closes the older one with code 4000. Code 4401: the registration disappeared (deleted, replaced, idle purge, or detected on an ack).
- Keep-alive: client sends text `ping`, the Durable Object auto-responds `pong` without waking up. Incoming messages over 4 KiB close the socket (1009).
- Server -> client (JSON text): `{"t":"hello","next":<highest cursor of the device or 0>}` right after accept; `{"t":"event","event":{cursor,id,type,timestamp,eph_pub,ciphertext}}` for every newly inserted row.
- Client -> server: `{"t":"ack","upto":n}` = `POST /updates/ack`.
- Nothing is replayed on connect. The mailbox stays the source of truth: connect the socket first, then `GET /updates?since=<cursor>`, de-duplicate by cursor. A failed push never fails the webhook.
