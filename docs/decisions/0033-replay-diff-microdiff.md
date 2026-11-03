<!-- SPDX-License-Identifier: CC-BY-SA-4.0 -->

# ADR 0033: First Difference with `microdiff`

## Context

The replay comparison reports the first difference as a JSON path with both values. A deep diff of JSON values is a generic helper (AGENTS.md rule 2).

## Decision

- **microdiff** 1.6.0 (MIT, pure ESM, no dependencies) in `@ridrs/replay`: its first difference, in the key order of the recorded payload, gives the path (`samples[1].speed`) and the values.
- Equality is exact (no tolerance); both sides went through JSON (the recorder serializes at observation, the replay serializes the same way), so `-0` and `0` cannot differ.

## Consequences

- One small library instead of an own deep-diff. Timestamps and missing events are compared before the payload diff.
