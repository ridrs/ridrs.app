<!-- SPDX-License-Identifier: CC-BY-SA-4.0 -->

# ADR 0001: Monorepo Workspace and TypeScript Execution (`pnpm` & `tsx`)

We use **pnpm workspaces** for monorepo package management and **tsx** (4.23.15, MIT) to execute TypeScript ESM modules directly without a separate build step in Phase 1. `pnpm` enforces strict dependency boundaries per workspace package and supports exact version pinning, while `tsx` provides fast, zero-configuration TypeScript execution for `apps/headless`, Cucumber step definitions, and dynamically imported fixture plugins. Alternatives considered included npm/yarn workspaces (weaker isolation) and pre-compiling TypeScript with `tsc` or `tsup` before running tests (unnecessary build ceremony in Phase 1).
