<!-- SPDX-License-Identifier: CC-BY-SA-4.0 -->

# ADR 0010: Reconnect Backoff (`p-retry`)

We use **p-retry** (8.0.1, MIT, pure ESM) for reconnecting to a trainer: `retries: Infinity`, `factor: 2`, `minTimeout: 1000`, `maxTimeout: 30000`, `randomize: false`, aborted through `ctx.signal`. No hand-written retry loops. The first attempt represents the connection that was just lost, so the first real reconnection happens after the initial 1 s delay.
