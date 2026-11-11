<!-- SPDX-License-Identifier: CC-BY-SA-4.0 -->

# ADR 0082: Power and Heart Rate Zones in the Athlete Profile

Status: accepted on 2026-11-11 by the maintainer ([structured-workouts.md](../ideas/structured-workouts.md), sections 6 and 14, F7 and A7).

## Context

Workout charts are coloured by zones, intervals.icu and FIT workouts have zone targets (`Z2`, `power_zone`), and the details and the briefing show the time per zone. ridrs had FTP, LTHR and maximum heart rate in the athlete profile (ADR 0075), but no zones. intervals.icu lets every athlete define their own number of zones, for example with a sweet spot zone.

## Decision

- The athlete profile gets `powerZones` (upper bounds in % FTP) and `heartRateZones` (upper bounds in bpm): lists of `{ name?, upTo? }`, lowest first, rising, at most ten; every zone but the last has `upTo`, the last one is open. A zone target is the zone with that 1-based number.
- The zones come from the **chosen profile source** (ADR 0075), like the FTP, and are written back the same way:
  - **local** (`profile-local`): by default the seven Coggan power zones (upper bounds 55, 75, 90, 105, 120, 150 % FTP, the last open) and heart rate zones from the LTHR with Friel's bounds; edited on the "Me" page (workbench).
  - **intervals.icu**: `power_zones`, `power_zone_names`, `hr_zones`, `hr_zone_names` of the Ride sport settings; written with `PUT sport-settings/Ride` when intervals.icu is the profile source.
- Zones are resolved **live for showing** and **once at the start of a ride** for riding; the resolved watts enter the ride as input. Without an FTP there are no power zones: the chart is drawn neutral with a discreet hint.
- The chart palette covers up to ten zones, by zone index.

## Consequences

- `athlete.profile.update` accepts zones; the profile's schema refuses falling bounds, an open zone before the last and more than ten zones.
- The ride athlete (`activity.athlete`) does not carry zones: the briefing resolves the targets before the start.
