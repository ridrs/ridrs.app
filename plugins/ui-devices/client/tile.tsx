// SPDX-License-Identifier: AGPL-3.0-or-later

import type { DeviceStatus } from '@ridrs/contracts';
import type { UiContext } from '@ridrs/ui-sdk';
import { requestDetails } from './details-request.ts';
import { type DeviceRow, describeDevices, type Tone } from './devices.ts';
import { KindIcon } from './theme.tsx';

/** The screen the tile opens. */
const SETUP = 'setup';

/** Drawn with the main screen's tokens (ADR 0058); the fallbacks keep it readable without them. */
const CSS = `
.dt-tile { display: flex; flex-direction: column; gap: 6px; height: 100%; padding: 20px;
  border: 1px solid var(--ridrs-line, #24324d); border-radius: var(--ridrs-radius, 16px);
  background: var(--ridrs-surface, #131c2e); color: var(--ridrs-text, #f2f5fa); }
.dt-title { display: flex; align-items: center; gap: 10px; margin: 0 0 6px; font-size: 18px; font-weight: 700; }
.dt-title i { width: 12px; height: 12px; border-radius: 50%; background: var(--ridrs-text-muted, #93a1b8); }
.dt-title i[data-tone="ok"] { background: var(--ridrs-ok, #3ddc84); }
.dt-title i[data-tone="busy"] { background: var(--ridrs-info, #2aa8ff); }
.dt-title i[data-tone="warn"] { background: var(--ridrs-warn, #ffb62e); }
.dt-row, .dt-open { display: flex; align-items: center; gap: 14px; width: 100%; padding: 10px 8px;
  border: 0; border-radius: 12px; background: transparent; color: inherit; text-align: left;
  font: 500 15px system-ui, sans-serif; cursor: pointer; }
.dt-row::after { content: '›'; margin-left: auto; color: var(--ridrs-text-muted, #93a1b8); font-size: 22px; }
.dt-row:hover, .dt-open:hover { background: var(--ridrs-surface-raised, #1a2540); }
.dt-row:focus-visible, .dt-open:focus-visible { outline: 3px solid var(--ridrs-focus, #fff); outline-offset: 2px; }
.dt-text { display: grid; gap: 2px; min-width: 0; }
.dt-name { overflow: hidden; font-weight: 600; text-overflow: ellipsis; white-space: nowrap; }
.dt-status { color: var(--ridrs-text-muted, #93a1b8); font-size: 14px; }
.dt-status[data-tone="ok"] { color: var(--ridrs-ok, #3ddc84); }
.dt-status[data-tone="busy"] { color: var(--ridrs-info, #2aa8ff); }
.dt-status[data-tone="warn"] { color: var(--ridrs-warn, #ffb62e); }
.dt-open { justify-content: flex-end; margin-top: auto; color: var(--ridrs-text-muted, #93a1b8); font-size: 14px; }
.dt-open.dt-setup { justify-content: flex-start; margin-top: 0; padding: 14px 16px;
  background: var(--ridrs-surface-raised, #1a2540); color: var(--ridrs-text, #f2f5fa); font-size: 16px; }
`;

/** The worst tone of the rows: one device that needs the rider colours the whole tile. */
export function overall(rows: readonly DeviceRow[]): Tone {
  for (const tone of ['warn', 'busy', 'ok'] as const) {
    if (rows.some((row) => row.tone === tone)) {
      return tone;
    }
  }
  return 'none';
}

function Row({ ctx, row }: { readonly ctx: UiContext; readonly row: DeviceRow }) {
  return (
    <button
      type="button"
      className="dt-row"
      data-testid="devices-tile-row"
      data-kind={row.kind}
      data-state={row.state}
      onClick={() => {
        requestDetails(row.kind);
        ctx.navigate(SETUP);
      }}
    >
      <KindIcon kind={row.kind} />
      <span className="dt-text">
        <span className="dt-name" data-testid="devices-tile-label">
          {row.label}
        </span>
        <span className="dt-status" data-tone={row.tone}>
          {row.state === 'none' ? row.status : `${row.deviceName} · ${row.status}`}
        </span>
      </span>
    </button>
  );
}

/**
 * The devices on the main screen: one row per kind (trainer, power, heart rate), each opening its
 * details in the device setup. Without any device it invites the rider to set them up.
 */
export function DevicesTileView({
  ctx,
  devices,
}: {
  readonly ctx: UiContext;
  readonly devices: readonly DeviceStatus[];
}) {
  const openSetup = () => ctx.navigate(SETUP);
  const [power, trainer, heartRate] = describeDevices(devices);
  const rows = devices.length === 0 ? [] : [trainer, power, heartRate].filter((row) => row !== undefined);

  return (
    <section className="dt-tile" data-testid="devices-tile" aria-label="Devices">
      <style>{CSS}</style>
      <h2 className="dt-title">
        <i data-tone={overall(rows)} aria-hidden="true" />
        Devices
      </h2>
      {rows.map((row) => (
        <Row key={row.kind} ctx={ctx} row={row} />
      ))}
      <button
        type="button"
        className={rows.length === 0 ? 'dt-open dt-setup' : 'dt-open'}
        data-testid="devices-open"
        onClick={openSetup}
      >
        {rows.length === 0 ? 'Set up your devices' : 'All devices'}
      </button>
    </section>
  );
}
