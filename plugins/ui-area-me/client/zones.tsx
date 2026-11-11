// SPDX-License-Identifier: AGPL-3.0-or-later

import { type HeartRateZones, type PowerZones, powerZonesSchema } from '@ridrs/contracts';
import type { UiContext } from '@ridrs/ui-sdk';
import { useMessages } from '@ridrs/ui-sdk/react';
import { messages } from './i18n/index.ts';

type Zones = PowerZones | HeartRateZones;
export type ZoneKind = 'power' | 'heartRate';

/** Ten zones at most, as the contract says (ADR 0082). */
const MAX_ZONES = 10;

export const ZONES_CSS = `
.me-zones { display: grid; gap: 8px; max-width: 640px; }
.me-zone { display: grid; grid-template-columns: 28px minmax(120px, 1fr) 110px minmax(90px, auto) 40px;
  align-items: center; gap: 8px; }
.me-zone-number { font-weight: 700; text-align: center; color: var(--ridrs-text-muted, #93a1b8); }
.me-zone-field { min-height: 40px; min-width: 0; padding: 6px 10px; border: 1px solid var(--ridrs-line, #24324d);
  border-radius: 12px; background: var(--ridrs-surface, #131c2e); color: var(--ridrs-text, #f2f5fa);
  font: 16px system-ui, sans-serif; font-variant-numeric: tabular-nums; }
.me-zone-field:focus-visible { outline: 3px solid var(--ridrs-focus, #fff); outline-offset: 2px; }
.me-zone-field[aria-invalid="true"] { border-color: var(--ridrs-warn, #ffb62e); }
.me-zone-open { color: var(--ridrs-text-muted, #93a1b8); padding: 0 10px; white-space: nowrap; }
.me-zone-absolute { font-variant-numeric: tabular-nums; color: var(--ridrs-text-muted, #93a1b8); white-space: nowrap; }
.me-zone-problem { margin: 0; color: var(--ridrs-warn, #ffb62e); }
[data-breakpoint="compact"] .me-zone { grid-template-columns: 24px minmax(0, 1fr) 90px 40px; }
[data-breakpoint="compact"] .me-zone-absolute { display: none; }
`;

/** The problem of a list of zones as the contract finds it, or undefined for a valid one. */
export function zonesProblem(zones: Zones): string | undefined {
  const result = powerZonesSchema.safeParse(zones);
  return result.success ? undefined : (result.error.issues[0]?.message ?? '');
}

/** One zone more: the open last zone gets a bound, a new open one follows. */
export function withAddedZone(zones: Zones, step: number, first: number): Zones {
  if (zones.length >= MAX_ZONES) return zones;
  const last = zones.at(-1);
  const before = zones.at(-2)?.upTo;
  const bound = before === undefined ? first : before + step;
  return [...zones.slice(0, -1), { ...last, upTo: Math.round(bound) }, {}];
}

/** One zone less; the zone below a removed last one becomes the open one. */
export function withoutZone(zones: Zones, index: number): Zones {
  if (zones.length <= 1) return zones;
  const rest = zones.filter((_, i) => i !== index);
  if (index !== zones.length - 1) return rest;
  const { upTo: _upTo, ...open } = rest[rest.length - 1] ?? {};
  return [...rest.slice(0, -1), open];
}

/**
 * The editor of one list of zones (ADR 0082): name and upper bound per zone, in % FTP for power
 * (with watts beside it when there is an FTP) and in bpm for heart rate; add, remove, reset. It
 * only changes a draft; the Me page's Save sends it.
 */
export function ZonesEditor({
  ctx,
  kind,
  zones,
  ftp,
  readOnly,
  defaults,
  onChange,
}: {
  readonly ctx: UiContext;
  readonly kind: ZoneKind;
  readonly zones: Zones;
  readonly ftp?: number | undefined;
  readonly readOnly: boolean;
  /** The defaults to reset to; none where there are none to offer (heart rate without an LTHR). */
  readonly defaults?: Zones | undefined;
  readonly onChange: (zones: Zones) => void;
}) {
  const text = useMessages(ctx, messages);
  const power = kind === 'power';
  const label = power ? text.powerZoneLabel : text.heartRateZoneLabel;
  const unit = power ? '% FTP' : 'bpm';
  const problem = zonesProblem(zones);
  const edit = (index: number, change: { name?: string; upTo?: number | undefined }) =>
    onChange(
      zones.map((zone, i) => {
        if (i !== index) return zone;
        const name = 'name' in change ? change.name : zone.name;
        const upTo = 'upTo' in change ? change.upTo : zone.upTo;
        return { ...(name ? { name } : {}), ...(upTo !== undefined && !Number.isNaN(upTo) ? { upTo } : {}) };
      }),
    );
  const watts = (percent: number) => `${Math.round((ftp ?? 0) * (percent / 100))} W`;
  return (
    <div className="me-zones" data-testid={`${kind}-zones`}>
      {zones.map((zone, index) => {
        const last = index === zones.length - 1;
        const n = index + 1;
        const below = zones[index - 1]?.upTo ?? 0;
        const invalid = problem !== undefined && !last && (zone.upTo === undefined || zone.upTo <= below);
        return (
          // The list is edited in place and has no ids: the position is the identity.
          // biome-ignore lint/suspicious/noArrayIndexKey: see above
          <div className="me-zone" key={index} data-testid={`${kind}-zone-${n}`}>
            <span className="me-zone-number">{n}</span>
            <input
              className="me-zone-field"
              aria-label={text.zoneName(label, n)}
              placeholder={text.zoneDefaultName(n)}
              maxLength={40}
              value={zone.name ?? ''}
              disabled={readOnly}
              onChange={(event) => edit(index, { name: event.target.value })}
            />
            {last ? (
              <span className="me-zone-open" data-testid={`${kind}-zone-${n}-bound`}>
                {text.zoneAbove(`${below} ${unit}`)}
              </span>
            ) : (
              <input
                className="me-zone-field"
                type="number"
                inputMode="numeric"
                min={1}
                aria-label={text.zoneBound(label, n, unit)}
                aria-invalid={invalid}
                value={zone.upTo ?? ''}
                disabled={readOnly}
                onChange={(event) =>
                  edit(index, { upTo: event.target.value === '' ? undefined : Number(event.target.value) })
                }
              />
            )}
            {power && ftp !== undefined ? (
              <span className="me-zone-absolute" data-testid={`${kind}-zone-${n}-watts`}>
                {last
                  ? text.zoneAbove(watts(below))
                  : zone.upTo === undefined
                    ? ''
                    : text.zoneUpTo(watts(zone.upTo))}
              </span>
            ) : (
              <span />
            )}
            <button
              type="button"
              className="pv-icon"
              aria-label={text.removeZone(label, n)}
              disabled={readOnly || zones.length <= 1}
              onClick={() => onChange(withoutZone(zones, index))}
            >
              ×
            </button>
          </div>
        );
      })}
      {problem !== undefined ? (
        <p className="me-zone-problem" role="status">
          {text.zonesInvalid(label, text.zoneReasons[problem] ?? text.zoneReasonFallback)}
        </p>
      ) : null}
      <div className="pv-row">
        <button
          type="button"
          className="pv-button"
          disabled={readOnly || zones.length >= MAX_ZONES}
          onClick={() => onChange(withAddedZone(zones, power ? 10 : 5, power ? 100 : 150))}
        >
          {text.addZone(label)}
        </button>
        {defaults ? (
          <button type="button" className="pv-button" disabled={readOnly} onClick={() => onChange(defaults)}>
            {text.resetZones(power ? text.powerZones : text.heartRateZones)}
          </button>
        ) : null}
      </div>
    </div>
  );
}
