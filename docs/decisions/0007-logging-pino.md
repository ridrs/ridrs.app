<!-- SPDX-License-Identifier: CC-BY-SA-4.0 -->

# ADR 0007: Structured Logging (`pino`)

We use **pino** (10.4.0, MIT) with **pino-pretty** (13.2.0, MIT) in development for structured JSON logging. The host creates a child logger bound to `{ pluginId }` for each plugin context (`ctx.logger`) and logs structured diagnostics with minimal overhead. Built-in `node:util` `parseArgs` and `node:crypto` `randomUUID` are used alongside `pino` in the headless CLI and event bus to avoid unnecessary external packages where Node built-ins cover the concern directly. Alternatives considered included `winston` (heavier and slower) and `consola` (less suited for structured machine-parseable JSON logs).
