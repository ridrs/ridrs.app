<!-- SPDX-License-Identifier: CC-BY-SA-4.0 -->

# ADR 0005: Capability Dependency Resolution (`dependency-graph`)

We use **dependency-graph** (1.0.0, MIT) to model plugin capability dependencies, compute topological initialization/start order via `overallOrder()`, look up transitive dependents via `dependantsOf()` for failure isolation and reverse-order stopping, and detect cycles via `DepGraphCycleError.cyclePath`. Inserting nodes sorted by plugin `id` ensures deterministic tie-breaking across independent plugins without writing custom graph traversal or Tarjan/Kahn algorithms. Alternatives considered included `toposort` (does not expose transitive `dependantsOf` queries or structured cycle paths) and `graphlib` (larger surface area than needed).
