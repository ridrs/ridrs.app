<!-- SPDX-License-Identifier: CC-BY-SA-4.0 -->

# ADR 0057: Trainer-Side Virtual Shifting: Findings, Not Implemented

Status: findings of the Phase 8 spike (decision D1). No production code; a follow-up gets its own ADR.

## Context

Zwift sends a KICKR CORE the virtual gear's ratio, and the trainer applies the gear itself. ridrs shifts on its side over FTMS ([ADR 0054](0054-trainer-load-and-virtual-gear-formula.md)). The spike asked whether and how a third-party app can send the ratio instead.

**Sources.** All were read only; no code was copied:

- the SHIFTR documentation (GPL-3.0; read, not copied): README and VirtualShifting.md, github.com/doudar/SHIFTR;
- virtual-cog (Unlicense, unofficial interoperability research): `Devices/Shared/zwift.proto`, `BleUUIDs.swift`, `Devices/Kickr/KickrZwiftClient.swift`, `Physics/GearModel.swift`, github.com/pymmog/virtual-cog;
- Wahoo support, "Virtual shifting with Wahoo smart trainers".

## Findings

- **Firmware.** The KICKR CORE (v1) supports Zwift virtual shifting from firmware 1.3.17 (Wahoo).
- **The same Zwift service as the Zwift Ride.** Service `00000001-19ca-4651-86e5-fa29dcdd09d1`:
  - `…0002`: measurement, notify;
  - `…0003`: control point, written with response;
  - `…0004`: command response, notify and read.
- **The same handshake as the Zwift Ride.** The ASCII "RideOn" is written to `…0003` and the trainer answers "RideOn" ([ADR 0040](0040-zwift-ride-protobuf-wire-bufbuild.md)).
- **Commands:** one op code byte, then protobuf.
  - Op code `0x04`, HubCommand:
    - field 3 PowerTarget (uint32 W);
    - field 4 SimulationParam: 1 wind (sint32, m/s × 100), 2 incline (sint32, % × 100), 3 CWa (uint32, × 10000), 4 Crr (uint32, × 100000);
    - field 5 PhysicalParam: 2 GearRatioX10000 (uint32), 4 bike weight (× 100), 5 rider weight (× 100).
  - Op code `0x03` on `…0002`: riding data (power, cadence, speed × 100, heart rate).
  - Op code `0x00`: an info request (query 520 probes the gear ratio).
- **A third-party app can send the ratio.** It writes the ratio (× 10000) and the simulation parameters **without** the gear, and the trainer applies the gear. That is the stated intent of the design conversation ([ADR 0054](0054-trainer-load-and-virtual-gear-formula.md), correction).
- **Zwift's numbers.** Zwift's ratios run from 0.75 to 5.49 in 24 steps. SHIFTR's base ratio is 34/14 and its geared force is the force × ratio / base: the same scaling as ADR 0054.
- **Not verified on our hardware.** It is open whether the maintainer's KICKR CORE shows `…0001` to an app that is not Zwift. The field numbers are reverse-engineered and unofficial.

## Decision

Not implemented in Phase 8.

**Follow-up.** `device-ftms-trainer` (or a Zwift-hub variant) would choose this path when the trainer shows the Zwift service. It would reuse `@bufbuild/protobuf` (ADR 0040) and the RideOn handshake, and send `resistance` plus `virtualGear.ratio` from the trainer load sample, which already carries both.

**First step of the follow-up.** A GATT dump of the maintainer's KICKR CORE (noble on the Mac).
