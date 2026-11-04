<!-- SPDX-License-Identifier: CC-BY-SA-4.0 -->

# macOS BLE Heart Rate Monitor (`hr-monitor-osx`)

A standalone TypeScript + Electron desktop experiment for macOS that pairs with standard Bluetooth Low Energy (BLE) Heart Rate sensors (`0x180D`) and displays real-time BPM, cycling HR zones, beat-to-beat RR intervals, and a live 60-second telemetry trace.

## Features

- **Standard BLE Heart Rate Profile (`0x180D`)**:
  - Subscribes to GATT Characteristic `0x2A37` (Heart Rate Measurement) and decodes 8-bit/16-bit BPM, skin contact status bits, energy expended, and 1/1024s RR-interval values.
  - Reads optional `0x2A38` (Body Sensor Location) and `0x180F` / `0x2A19` (Battery Level).
  - Bridges Electron's `select-bluetooth-device` event over context-isolated IPC so you can pick from discovered CoreBluetooth sensors right in the app window.
- **Built-in Sensor Simulator**:
  - Encodes synthetic `0x2A37` binary packets and streams them through the same GATT binary parser so you can test the UI and zone transitions without a physical chest strap.

## Quick Start (macOS)

```bash
cd experiments/hr-monitor-osx
npm install
npm test
npm start
```

> **macOS Bluetooth Permission**: The first time you click **Connect BLE Heart Rate Sensor**, macOS will prompt to allow Electron / Terminal Bluetooth access. Make sure your BLE heart rate strap (Polar, Garmin, Wahoo, Coospo, Magene, etc.) is awake and not currently claimed by another app on your Mac or phone.

## Third-Party Dependencies

| Package | License | Purpose |
|---|---|---|
| `electron` | MIT | macOS desktop application shell and Web Bluetooth integration |
| `typescript` | Apache-2.0 | Static type checking and compilation |
| `@types/node` | MIT | Node.js TypeScript definitions |
