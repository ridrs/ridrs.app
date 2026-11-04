// SPDX-License-Identifier: AGPL-3.0-or-later

import type { DeviceStatus } from '@ridrs/contracts';
import type { UiContext } from '@ridrs/ui-sdk';
import { type DeviceRow, describeDevices } from './devices.ts';
import { DeviceStyles } from './theme.tsx';

/** The screen the indicator opens. */
const SETUP = 'setup';

function Dot({ row }: { readonly row: DeviceRow }) {
  return (
    <span className={`rd-dot ${row.tone}`} data-kind={row.kind} data-state={row.state}>
      <i />
      {row.label}
    </span>
  );
}

/**
 * One dot per kind on the main screen: trainer, power, heart rate. Without any device it invites
 * the rider to set them up. Either way a click opens the device setup.
 */
export function DeviceIndicatorView({
  ctx,
  devices,
}: {
  readonly ctx: UiContext;
  readonly devices: readonly DeviceStatus[];
}) {
  const open = () => ctx.navigate(SETUP);

  if (devices.length === 0) {
    return (
      <>
        <DeviceStyles />
        <button type="button" className="rd-indicator" data-testid="device-indicator" onClick={open}>
          <span className="rd-dot busy">
            <i />
            Set up your devices
          </span>
        </button>
      </>
    );
  }

  const [power, trainer, heartRate] = describeDevices(devices);
  const dots = [trainer, power, heartRate].filter((row) => row !== undefined);
  const summary = dots.map((row) => `${row.label} ${row.status.toLowerCase()}`).join(', ');
  return (
    <>
      <DeviceStyles />
      <button
        type="button"
        className="rd-indicator"
        data-testid="device-indicator"
        aria-label={`Devices: ${summary}`}
        onClick={open}
      >
        {dots.map((row) => (
          <Dot key={row.kind} row={row} />
        ))}
      </button>
    </>
  );
}
