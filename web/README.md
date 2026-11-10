# ridrs.app

Cloudflare Workers application for [ridrs.app](https://ridrs.app).

## Project Setup

This project is built using Cloudflare Workers and managed via Wrangler.

### Configuration
- **Worker Name**: `ridrs-app`
- **Connected Domains**:
  - `ridrs.app`
  - `www.ridrs.app`
- **Entrypoint**: `src/index.js`
- **Configuration**: `wrangler.toml`

## Local Development

From the `web` directory:
```bash
npm run dev
# or
wrangler dev
```

## Manual Deployment

From the `web` directory:
```bash
npm run deploy
# or
wrangler deploy
```

## Automated Deployment on Push

Continuous deployment is handled natively via **Cloudflare Workers Builds**:
- Connected to GitHub repository `ridrs/ridrs.app`
- **Root Directory**: `web`
- **Production Branch**: `main`

Pushing to `main` automatically triggers Cloudflare to build and deploy the Worker application.

## Relay and webhook mailbox

Endpoints (details in [`PROTOCOL.md`](PROTOCOL.md)): `GET /intervals/oauth/callback` (waits for the app's sign-in result), `POST /intervals/oauth/result`, `POST /intervals/oauth/status`, `GET /activities/<id>`,
`POST /intervals/webhook`, `POST /devices`, `GET /updates`, `POST /updates/ack`, `DELETE /devices/<id>`,
`GET /updates/ws` (WebSocket push). Code: `src/router.js` (routing), `relay.js` (bounce pages), `mailbox.js`,
`signing.js`, `crypto.js`, `hub.js` (Durable Object `MailboxHub`).

### One-time setup (maintainer)
```bash
cd web
npx wrangler d1 create ridrs-mailbox-intervals
npx wrangler d1 migrations apply ridrs-mailbox-intervals --remote
npx wrangler secret put INTERVALS_WEBHOOK_SECRET # the secret configured in the intervals.icu webhook settings
npm run deploy                                   # also creates the MailboxHub Durable Object (migration v1) and the cron
```
- Secret: `INTERVALS_WEBHOOK_SECRET` (sent by intervals.icu in `X-Webhook-Authorization` or the body field `secret`).
- Cron `17 3 * * *` (in `wrangler.toml`) deletes rows older than 30 days, devices idle for 180 days and sign-in results older than 10 minutes. Migration `0002_oauth_results.sql` (table `oauth_results`) must be applied (`migrations apply ... --remote`) before the deploy.
- Durable Objects with SQLite storage (`new_sqlite_classes`) are, as far as I know, available on the Workers Free plan; if the deploy refuses the migration, the paid plan is needed. D1 is available on Free too.
- Intervals.icu settings: OAuth redirect URI `https://ridrs.app/intervals/oauth/callback`, webhook URL `https://ridrs.app/intervals/webhook`, activity link template `https://ridrs.app/activities/{id}` (check the exact placeholder in the intervals.icu app settings).

### Tests
```bash
npm install
npm test        # vitest in plain Node (needs Node 22.5+ for node:sqlite, used as a D1 stand-in)
```
The test vector `test-vectors/mailbox-v1.json` is checked by the tests; `UPDATE_VECTOR=1 npm test` rewrites it.
