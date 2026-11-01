<!-- SPDX-License-Identifier: CC-BY-SA-4.0 -->

# ADR 0008: Linting, Formatting, and Architecture Boundaries (`@biomejs/biome` & `dependency-cruiser`)

We use **@biomejs/biome** (2.6.4, MIT OR Apache-2.0) as the single linter and formatter, and **dependency-cruiser** (18.7.0, MIT) to enforce package and plugin import boundaries in CI. Biome replaces the traditional ESLint + Prettier stack with a single fast tool, while `dependency-cruiser` statically verifies that `packages/contracts` has no internal imports, `packages/core` never imports plugins or apps, and plugins only communicate through public contracts. Alternatives considered included ESLint with `eslint-plugin-boundaries` (slower and more complex configuration).
