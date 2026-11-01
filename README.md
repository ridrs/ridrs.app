<!-- SPDX-License-Identifier: CC-BY-SA-4.0 -->

# ridrs

Open-source, modular, headless-first indoor cycling platform.

## Repository Structure

- `apps/headless/`: Headless CLI composition root (`@ridrs/headless`).
- `packages/contracts/`: Public plugin, manifest, event, and capability contracts (`@ridrs/contracts`, `Apache-2.0`).
- `packages/core/`: Application core: discovery, capability resolution, lifecycle, diagnostics, and typed event bus (`@ridrs/core`, `AGPL-3.0-or-later`).
- `plugins/`: Production plugins directory (plugins start in Phase 2).
- `tests/`: Executable Gherkin specifications (`tests/features/`), step definitions, test harness, and fixture plugins.
- `docs/`: Architecture documentation (`docs/architecture/`) and Architecture Decision Records (`docs/decisions/`).
- `web/`: Cloudflare Worker application serving the project web page ([ridrs.app](https://ridrs.app)).

## Running ridrs headless

Install dependencies and verify the workspace:

```bash
pnpm install
pnpm typecheck
pnpm lint
pnpm test
```

Start the headless composition root against the example ping-pong plugins:

```bash
pnpm --filter @ridrs/headless start -- --plugins tests/fixtures/plugins/ping-pong
```

Press `Ctrl+C` (`SIGINT`) to gracefully stop and dispose all plugins.

## Web Application

For instructions on local development and deployment of the web application, see the [web README](web/README.md).
