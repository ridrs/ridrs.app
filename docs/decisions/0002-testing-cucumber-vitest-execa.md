<!-- SPDX-License-Identifier: CC-BY-SA-4.0 -->

# ADR 0002: Acceptance and Unit Testing (`@cucumber/cucumber`, `vitest`, `execa`)

We use **@cucumber/cucumber** (13.3.0, MIT) in strict mode with **node:assert/strict** as the executable specification gate, **vitest** (5.0.5, MIT) for fast unit tests on contract and core edge cases, and **execa** (10.2.1, MIT) to spawn and signal the headless CLI process in end-to-end scenarios. Cucumber keeps behavioral scenarios readable and directly traceable to each phase's vertical use cases, Vitest provides instant feedback on low-level schema and registry invariants, and `execa` handles child process output streaming and POSIX signal delivery cleanly without custom child_process boilerplate. Alternatives considered included Jest (heavier ESM setup) and Cucumber-only testing without unit tests.
