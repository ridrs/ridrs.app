// SPDX-License-Identifier: AGPL-3.0-or-later

// Developer build only (imported behind VITE_DUMMY_DEVICES): dummy BLE devices for manual tests.

import {
  DUMMY_PROFILES,
  DUMMY_WATTS_RANGE,
  type DummyDevice,
  DummyDevices,
  type DummyProfile,
  mergeBleCentrals,
} from '@ridrs/ble-simulator';
import type { BleCentral } from '@ridrs/contracts';
import { useEffect, useState } from 'react';

/** Marker a test looks for to prove release bundles leave this module out. */
export const DUMMY_DEVICES_MARKER = 'ridrs-companion-dummy-devices';

/** Merges dummy devices into the forwarded central; the panel adds and removes them. */
export function withDummyDevices(real: BleCentral): { central: BleCentral; dummies: DummyDevices } {
  const dummies = new DummyDevices();
  const central = mergeBleCentrals(real, dummies.central, (id) => dummies.owns(id));
  return { central, dummies };
}

/** Where the controls start before the developer sets a power: the steady profile's 220 W. */
const DEFAULT_WATTS = 220;
const WATTS_STEP = 10;

function WattControls({
  dummies,
  device,
}: {
  readonly dummies: DummyDevices;
  readonly device: DummyDevice;
}) {
  const watts = device.watts ?? DEFAULT_WATTS;
  const set = (value: number) => dummies.setWatts(device.peripheralId, value);
  return (
    <div style={{ display: 'flex', gap: 8, alignItems: 'center', margin: '4px 0 8px' }}>
      <button
        type="button"
        aria-label={`${device.name} −${WATTS_STEP} W`}
        onClick={() => set(watts - WATTS_STEP)}
      >
        −{WATTS_STEP}
      </button>
      <input
        type="range"
        aria-label={`${device.name} power`}
        min={DUMMY_WATTS_RANGE.min}
        max={1000}
        step={5}
        value={watts}
        onChange={(e) => set(Number(e.target.value))}
        style={{ flex: 1, minWidth: 0 }}
      />
      <button
        type="button"
        aria-label={`${device.name} +${WATTS_STEP} W`}
        onClick={() => set(watts + WATTS_STEP)}
      >
        +{WATTS_STEP}
      </button>
      <span
        style={{
          minWidth: '4.5em',
          textAlign: 'right',
          opacity: device.watts === undefined ? 0.7 : 1,
        }}
      >
        {device.watts === undefined ? 'profile' : `${device.watts} W`}
      </span>
    </div>
  );
}

export function DummyPanel({ dummies }: { readonly dummies: DummyDevices }) {
  const [devices, setDevices] = useState<readonly DummyDevice[]>(() => dummies.list());
  const [profile, setProfile] = useState<DummyProfile>('steady');
  useEffect(() => dummies.onChange(setDevices), [dummies]);
  return (
    <div data-testid={DUMMY_DEVICES_MARKER}>
      <strong>Dummy devices</strong>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, margin: '8px 0' }}>
        <select
          aria-label="Dummy profile"
          value={profile}
          onChange={(e) => setProfile(e.target.value as DummyProfile)}
          style={{ flex: '1 1 12em', minWidth: 0 }}
        >
          {Object.entries(DUMMY_PROFILES).map(([id, description]) => (
            <option key={id} value={id}>
              {id}: {description}
            </option>
          ))}
        </select>
        <button type="button" onClick={() => dummies.add(profile)}>
          Add trainer
        </button>
      </div>
      {devices.length === 0 && <div style={{ opacity: 0.7 }}>No dummy devices yet.</div>}
      {devices.map((d) => (
        <div key={d.peripheralId}>
          <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
            <span style={{ flex: 1 }}>
              {d.name} · {d.profile}
            </span>
            <button type="button" onClick={() => dummies.remove(d.peripheralId)}>
              Remove
            </button>
          </div>
          <WattControls dummies={dummies} device={d} />
        </div>
      ))}
    </div>
  );
}
