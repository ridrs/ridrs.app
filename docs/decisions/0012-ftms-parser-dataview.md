<!-- SPDX-License-Identifier: CC-BY-SA-4.0 -->

# ADR 0012: FTMS Indoor Bike Data Parsing (`DataView`)

The FTMS Indoor Bike Data parser is implemented with the built-in `DataView` as a table of fields in flag-bit order (`plugins/device-ftms-trainer/parser.ts`). I did not find a maintained, typed, tested ESM FTMS parser on npm that I could verify in this environment (no registry search was possible), and the parser is ~60 lines of ridrs device-domain code. Only power and cadence are extracted; other fields are skipped by size. Revisit if a credible library appears.
