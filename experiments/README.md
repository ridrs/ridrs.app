<!-- SPDX-License-Identifier: CC-BY-SA-4.0 -->

# Experiments

This directory holds standalone prototypes and hardware/UI spikes that live outside the main `ridrs` workspace pipeline (`apps/`, `packages/`, `plugins/`).

## Available Experiments

| Folder | Description |
|---|---|
| [`tauri-ble-spike`](./tauri-ble-spike/) | Time-boxed spike: one Tauri 2 project for Windows, macOS, iOS and Android with native BLE (btleplug via `tauri-plugin-blec` plus a thin own command layer), `TauriBleCentral` implementing the unchanged `BleCentral` contract, and a WebView portability probe for real ridrs code. Results in `FINDINGS.md`. |
| [`hr-monitor-osx`](./hr-monitor-osx/) | TypeScript + Electron macOS desktop application that connects to Bluetooth Low Energy (BLE) Heart Rate sensors (`0x180D` / `0x2A37`) via Web Bluetooth and displays live BPM, HR zones, RR-intervals, and a real-time telemetry trace (plus a built-in sensor simulator). |
| [`tabata-sync`](./tabata-sync/) | Workout music analysis engine (landmark fingerprints, audio markers, tempo and beats, SQLite) and, in later phases, a player that shows Tabata intervals in sync with the music. Plan in `ARCHITECTURE.md`, results in `README.md`. |
