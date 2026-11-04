<!-- SPDX-License-Identifier: CC-BY-SA-4.0 -->

# ADR 0040: Zwift Ride Packets with the Protobuf Wire Reader (`@bufbuild/protobuf`)

## Context

The Zwift Ride controller sends its keypad status as an opcode byte (`0x23`) followed by a protobuf message: field 1 is a varint button map (a cleared bit means "held down"), further fields carry the analog paddles as nested messages. Reading varints, tags and skipping unknown fields is generic protobuf wire decoding, not ridrs domain logic, and `AGENTS.md` asks for a well-maintained, pure-JS ESM library for such helpers. There is no published `.proto` schema for the controller, so generated code is not an option; a low-level wire reader is enough.

## Decision

Use **@bufbuild/protobuf** 2.16.0 (Apache-2.0 AND BSD-3-Clause, pure TypeScript, ESM, no dependencies), only its `BinaryReader` from `@bufbuild/protobuf/wire`, in `plugins/device-zwift-ride` only. It throws on truncated input ("premature EOF"), which the plugin reports as `malformed-packet`.

The domain stays our own code (`plugins/device-zwift-ride/parser.ts`): which opcode is the keypad status, which field is the button map, the bit of each button and the "RideOn" handshake, all taken from the packet capture of `experiments/hr-monitor-osx`.

## Consequences

- No hand-written varint or tag decoding. The licenses are compatible with AGPL-3.0-or-later; listed in `NOTICE`.
- Rejected: `protobufjs` (CommonJS, generated code or reflection for a schema we do not have) and porting the experiment's own varint reader (rule 2).
- The analog paddles are skipped until a use case needs them.
