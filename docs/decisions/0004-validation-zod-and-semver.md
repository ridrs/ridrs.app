<!-- SPDX-License-Identifier: CC-BY-SA-4.0 -->

# ADR 0004: Schema and Version Validation (`zod` v4 & `semver`)

We use **zod** (4.6.7, MIT) for runtime validation and static type inference (`z.infer`) of `manifest.json` files and event payloads, paired with **semver** (7.8.5, ISC) to validate semantic version strings. Zod v4's `.strict()` object validation and `z.prettifyError` produce clear, field-accurate diagnostic messages with zero hand-written validation logic. Alternatives considered included Ajv/JSON Schema (requires separate TypeScript type maintenance) and Valibot (Zod has broader ecosystem familiarity and built-in error formatting).
