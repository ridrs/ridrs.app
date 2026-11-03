<!-- SPDX-License-Identifier: CC-BY-SA-4.0 -->

# ADR 0034: Own FIT Encoder; the Official Garmin FIT SDK Only Validates

## Context

Saved rides are exported as FIT activity files. Garmin's official FIT JavaScript SDK (`@garmin/fitsdk`) is under the *Flexible and Interoperable Data Transfer (FIT) Protocol License*. Its section 2 says the licensee shall not:

> c. … rent, lease, lend, sell, sublicense, assign, distribute, publish, transfer or otherwise make available the Licensed Technology … to any third party …
>
> d. distribute the Licensed Technology or any derivatives thereof so that any part of it becomes subject to any license that requires that the Licensed Technology … be disclosed or distributed in source code form, or that others have the right to modify it;

Section 1 grants use "for Licensee's internal business purposes". Bundling or redistributing the SDK conflicts with ridrs' AGPL (§2d) and with distribution itself (§2c).

## Decision (maintainer, 2026-11-02)

- ridrs writes FIT with **its own encoder** in `@ridrs/fit`, implemented from the public FIT protocol documentation: 14-byte header with header CRC, definition before first data message per local type, little-endian, file CRC-16; no compressed timestamps, no developer fields. Message and field numbers, base types, scales and enum values come from the public profile (21.218). No SDK source is copied.
- **@garmin/fitsdk 21.218.0** is a **devDependency of the root test workspace only**. Vitest cross-checks the CRC (`CrcCalculator`) and every message, field, base type, scale and enum value (`Profile`); the features decode every exported file with `Decoder.isFIT`, `checkIntegrity()` and `read()` without errors.
- It is never imported from `packages/*/src`, `plugins/*` or `apps/*/src` (non-test): dependency-cruiser rule `fit-sdk-only-in-tests`, the scenario "The official SDK is not part of ridrs" and `scripts/check-native-bundle.mjs` enforce it. It is never bundled, vendored or distributed. The maintainer and CI accept the Garmin license for this use.
- Licenses: `@ridrs/fit` and `@ridrs/recording` are **AGPL-3.0-or-later** until the legal review allows Apache-2.0 (maintainer decision).

## Open

- **Legal review** of this setup (test-only use of the SDK in a public AGPL repository, CI downloads) before release — arranged by the maintainer.
