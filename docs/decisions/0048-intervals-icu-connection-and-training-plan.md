<!-- SPDX-License-Identifier: CC-BY-SA-4.0 -->

# ADR 0048: Connecting intervals.icu: OAuth with PKCE, and the Training Plan by Event

Status: accepted by the maintainer on 2026-11-04 and implemented the same day. The choices marked "maintainer" were made by the maintainer on 2026-11-02 and 2026-11-04.

## Context

The rider plans workouts on [intervals.icu](https://intervals.icu). The first use case: connect the account, load the athlete profile and the planned workouts, show the next workout on the main screen as a small widget, and its details on Enter. Uploading finished rides comes later and is out of scope.

intervals.icu offers OAuth 2 (authorization code) with PKCE (S256) and "public" clients, which exchange the code without a client secret. There are no refresh tokens; signing in again replaces the token, and `DELETE /api/v1/disconnect-app` revokes it. Redirect URIs must be registered exactly, and the port counts too: a loopback redirect on another port fails with "Invalid redirect_uri" (found on the first real sign-in, 2026-11-05). Paths with an athlete id accept `0` for the token's athlete. Rate limits are at least 5 000 calls a day per app and 10 per second per IP.

## Decision

### Account and sign-in (maintainer)

- **Public OAuth client "Ridrs.APP", client id `1697`**, with "PKCE required". The client id is configuration, not a secret: a constant in `planner-intervals-icu`. No client secret exists anywhere in ridrs.
- **Scopes `SETTINGS:READ,CALENDAR:READ`**: the profile (sport settings) and the calendar. Nothing else.
- **Redirect `http://127.0.0.1:47261/oauth/callback`** (loopback) on every platform: one mechanism for macOS and Android. The app listens on the fixed port 47261 only while a sign-in runs; this exact URI is registered for the app. The planner passes the port to `auth.browser-sign-in`. If another program holds the port, the sign-in fails (`sign-in-rejected`) and the rider can try again. Android may pause the app while the browser is in front; this is checked on the phone first (vertical use case). If it fails, a deep link replaces the loopback on Android only, in a follow-up ADR.
- **PKCE with Web Crypto** (`crypto.getRandomValues`, `crypto.subtle.digest('SHA-256')`, built into Node and every webview): a 64-character verifier from the unreserved alphabet, the challenge base64url without padding, a random `state` of 32 characters. No library: three lines over a built-in API.
- **The token is a secret.** It lives only in the capability `storage.secrets` (OS keychain, [ADR 0050](0050-secrets-in-the-os-keychain.md)), never in an event, a log, a recording or app files.

### Capabilities (contracts, Apache-2.0)

Each has exactly one consumer today (rule 3) and a simulated provider for the tests (rule 4).

| Capability | Cardinality | Shape | Native provider |
| --- | --- | --- | --- |
| `net.http` | single | `request({ method, url, headers?, body? }) → { status, headers, body: string }` | `net-http-tauri` ([ADR 0049](0049-http-and-loopback-sign-in-in-the-native-app.md)) |
| `auth.browser-sign-in` | single | `signIn({ authorizationUrl(redirectUri), callbackPath, callbackPort }) → { redirectUri, callbackUrl }`; rejects with `sign-in-cancelled` when the browser flow is abandoned | `auth-sign-in-tauri` (ADR 0049) |
| `storage.secrets` | single | `get(key) → string \| undefined`, `set(key, value)`, `remove(key)` | `storage-secrets-tauri` (ADR 0050) |

`net.http` returns the body as text so that a provider can cross any process boundary; the caller parses JSON.

### Events (contracts, Apache-2.0)

Named after the domain (`training.*`), not after intervals.icu: the UI and every later consumer stay independent of the service. `service: 'intervals.icu'` names the source.

- `training.connect-requested {}`, `training.disconnect-requested {}`, `training.refresh-requested {}`: published by the UI.
- `training.account-changed { service, state: 'disconnected' | 'connecting' | 'connected' | 'failed', athleteName?, reason? }`. `reason` ∈ `sign-in-cancelled`, `sign-in-rejected` (wrong `state`, an `error` in the callback, a failed code exchange), `token-rejected` (401 or 403), `unreachable`.
- `training.plan-changed { service, fetchedAt, offline, athlete, workouts }`:
  - `athlete { name, ftp?, weight?, lthr?, maxHeartRate? }`, from `GET /api/v1/athlete/0` (`WithSportSettings` in the OpenAPI spec at `https://intervals.icu/api/v1/docs`): `name`, `icu_weight`, and from the `sportSettings` entry whose `types` contain `Ride`: `indoor_ftp` if set, else `ftp` (ridrs rides indoors), `lthr` and `max_hr`.
  - `workouts`: planned cycling workouts in date order, each `{ id, date: 'YYYY-MM-DD', name, sport: 'ride' | 'virtual-ride', description?, durationSeconds?, trainingLoad?, steps }`.
  - A workout maps the `Event` fields `id`, `start_date_local` (the date part), `name`, `type`, `description`, `moving_time` and `icu_training_load`.
  - `steps`: the `workout_doc` steps (an untyped object in the spec; shape as in the intervals.icu forum: `duration` in s, `power { units: '%ftp', value }` or `{ start, end }` for a ramp, `cadence`, `warmup`, `cooldown`, `text`, and `reps` with nested `steps`), empty when intervals.icu has none (the doc is only filled once the workout was edited in the web app). A step is either `{ kind: 'interval', durationSeconds, phase?: 'warm-up' | 'cool-down', text?, power?, cadence? }` or `{ kind: 'repeat', reps, steps }`. `power { low, high }` is in % FTP (a fixed target has `low = high`) and additionally in watts (`lowWatts`, `highWatts`) when the profile has an FTP. A ramp is `low ≠ high`.
  - `offline: true` when the plan comes from the cache because intervals.icu could not be reached.

### Plugins (AGPL-3.0-or-later)

- **`planner-intervals-icu`**, type `transport`: like `world-driver-ui`, it brings outside data in and is left out of a replay, which injects its recorded inputs instead. It requires `net.http`, `auth.browser-sign-in`, `storage.secrets` and `storage.app-files`.
  - Connect: PKCE, sign-in, check `state`, exchange the code at `POST /api/oauth/token` (form fields `client_id`, `code`, `code_verifier`), keep `access_token` in `storage.secrets` under `intervals-icu.token`, then load the plan.
  - Load: `GET /api/v1/athlete/0` and `GET /api/v1/athlete/0/events?oldest=<today>&newest=<today + 13 days>&category=WORKOUT` with `Authorization: Bearer`. Keep `type` ∈ {`Ride`, `VirtualRide`} (**cycling only, 14 days: maintainer**). "Today" is the local date of `ctx.clock.now()`.
  - When: at start (if a token is stored), after `recording.completed`, and on `training.refresh-requested`. No timer: the plan changes rarely and the limits stay far away.
  - Cache: the last plan as `training/intervals-icu-plan.json` in `storage.app-files` (the native app's fs scope covers `$APPDATA/training/**` next to `recordings/**`). If intervals.icu cannot be reached at start, the cached plan goes out with `offline: true`. The cache holds no token.
  - 401 or 403: the token is removed, `account-changed` → `failed` with `token-rejected`; the UI offers to reconnect.
  - Disconnect: `DELETE /api/v1/disconnect-app` (best effort; offline it is skipped), remove the token and the cache, `account-changed` → `disconnected`, `plan-changed` with no workouts.
  - Results of asynchronous work (sign-in, HTTP, keychain) enter through `ctx.inputs.accept` as `training.account-changed` and `training.plan-changed` (rule 7). They are therefore recorded during a ride; their payloads hold no secret.
- **`ui-training-plan`**, type `ui`:
  - Contribution `next-workout` to `main/panel`. Disconnected or failed: a button "Connect intervals.icu" (or "Reconnect intervals.icu" after `token-rejected`) and the reason. Connected: one focusable card with the day ("Today", "Tomorrow", else the weekday and date), the name, the duration, the training load, and a power profile (bars by % FTP) when the workout has steps; "No workout planned" without one; "Offline" for a cached plan.
  - Screen `training-workout`: name, day, description, profile values (FTP, weight), the steps (repeats as "4×" with their steps), "Refresh" and "Disconnect intervals.icu". Back returns to the main screen.
  - Keyboard and remote (rule 12): the card is one focusable element; Enter opens the screen; arrows move between its buttons; Back leaves.

### Not in this ADR

Uploading rides, webhooks (none registered), other sports, workouts beyond 14 days, executing a workout (ERG targets would be simulation inputs and need a use case of their own), the workout library and calendars other than the default.

## Consequences

- The first network access of ridrs. The webview's CSP stays closed: requests run in Rust (ADR 0049).
- A sign-in the rider abandons in the browser keeps the panel at "Connecting…" until the provider's timeout (5 minutes); there is no cancel yet.
- `Date` in the planner: like transport plugins, `plugins/planner-*` may use the wall clock (biome override); it reads "today" from `ctx.clock` all the same.
- Recordings contain the athlete's name, FTP and weight when a plan arrives during a ride. They are the rider's own local files; nothing leaves the device.
- A replay excludes the planner (type `transport`) and injects its recorded events opaquely. Nothing in the simulation reads them.
- Until intervals.icu approves the client, only the maintainer's account can sign in. The scenarios run against a simulated intervals.icu and do not depend on it.
