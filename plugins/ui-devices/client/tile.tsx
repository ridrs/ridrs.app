// SPDX-License-Identifier: AGPL-3.0-or-later

import type { DeviceStatus } from '@ridrs/contracts';
import type { UiContext } from '@ridrs/ui-sdk';
import { useMessages } from '@ridrs/ui-sdk/react';
import { requestDetails } from './details-request.ts';
import { type DeviceRow, describeDevices, type Tone } from './devices.ts';
import { messages } from './i18n/index.ts';
import { KindIcon } from './theme.tsx';

/** The screen the tile opens. */
const SETUP = 'setup';

/** Drawn with the main screen's tokens (ADR 0058); the fallbacks keep it readable without them. */
const CSS = `
.dt-tile { display: flex; flex-direction: column; gap: 6px; height: 100%; padding: 20px;
  border: 0; box-shadow: var(--ridrs-edge); border-radius: var(--ridrs-radius);
  background: var(--ridrs-card-quiet); color: var(--ridrs-text); }
.dt-title { display: flex; align-items: center; gap: 10px; margin: 0 0 6px; font-size: 18px; font-weight: 500; }
.dt-title i { width: 12px; height: 12px; border-radius: 50%; background: var(--ridrs-text-muted); }
.dt-title i[data-tone="ok"] { background: var(--ridrs-ok); }
.dt-title i[data-tone="busy"] { background: var(--ridrs-info); }
.dt-title i[data-tone="warn"] { background: var(--ridrs-warn); }
.dt-row, .dt-open { display: flex; align-items: center; gap: 14px; width: 100%; padding: 10px 8px;
  border: 0; border-radius: var(--ridrs-radius); background: transparent; color: inherit; text-align: left;
  font: 500 15px var(--ridrs-font-text); cursor: pointer; }
.dt-row::after { content: '›'; margin-left: auto; color: var(--ridrs-text-muted); font-size: 22px; }
.dt-text { display: grid; gap: 2px; min-width: 0; }
.dt-name { overflow: hidden; font-weight: 500; text-overflow: ellipsis; white-space: nowrap; }
.dt-status { color: var(--ridrs-text-muted); font-size: 14px; }
.dt-status[data-tone="ok"] { color: var(--ridrs-ok); }
.dt-status[data-tone="busy"] { color: var(--ridrs-info); }
.dt-status[data-tone="warn"] { color: var(--ridrs-warn); }
.dt-open { justify-content: flex-end; margin-top: auto; color: var(--ridrs-text-muted); font-size: 14px; }
.dt-open.dt-setup { justify-content: flex-start; margin-top: 0; padding: 14px 16px;
  background: var(--ridrs-surface-raised); color: var(--ridrs-text); font-size: 16px; }
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
  const text = useMessages(ctx, messages);
  const openSetup = () => ctx.navigate(SETUP);
  const [power, trainer, heartRate] = describeDevices(devices, {}, text);
  const rows = devices.length === 0 ? [] : [trainer, power, heartRate].filter((row) => row !== undefined);

  return (
    <section className="dt-tile" data-testid="devices-tile" aria-label={text.devices}>
      <style>{CSS}</style>
      <h2 className="dt-title">
        <i data-tone={overall(rows)} aria-hidden="true" />
        {text.devices}
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
        {rows.length === 0 ? text.setUp : text.allDevices}
      </button>
    </section>
  );
}
