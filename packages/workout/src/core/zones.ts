// SPDX-License-Identifier: AGPL-3.0-or-later

import type { HeartRateZones, PowerZones } from '@ridrs/contracts';

/**
 * Training zones by their upper bounds, lowest first, the last one open (ADR 0082): the shape of
 * both `powerZones` (% FTP) and `heartRateZones` (bpm) of the athlete profile.
 */
export type TrainingZones = readonly { readonly name?: string; readonly upTo?: number }[];

/** Coggan's seven power zones, upper bounds in % FTP (Allen & Coggan, "Training and Racing with a Power Meter"). */
const COGGAN: readonly (readonly [string, number | undefined])[] = [
  ['Active Recovery', 55],
  ['Endurance', 75],
  ['Tempo', 90],
  ['Threshold', 105],
  ['VO2 Max', 120],
  ['Anaerobic Capacity', 150],
  ['Neuromuscular Power', undefined],
];

/**
 * Friel's seven heart rate zones for cycling, upper bounds in % of the lactate threshold heart
 * rate (Joe Friel, "Quick Guide to Setting Zones", TrainingPeaks): Z1 up to 81 %, Z2 89 %, Z3
 * 93 %, Z4 99 %, Z5a 102 %, Z5b 106 %, Z5c above. intervals.icu uses the same bounds.
 */
const FRIEL: readonly (readonly [string, number | undefined])[] = [
  ['Recovery', 81],
  ['Aerobic', 89],
  ['Tempo', 93],
  ['SubThreshold', 99],
  ['SuperThreshold', 102],
  ['Aerobic Capacity', 106],
  ['Anaerobic Capacity', undefined],
];

/** The default power zones of a local profile: Coggan's, in % FTP. */
export function defaultPowerZones(): PowerZones {
  return COGGAN.map(([name, upTo]) => (upTo === undefined ? { name } : { name, upTo }));
}

/**
 * The default heart rate zones of a local profile: Friel's bounds of the LTHR, in whole bpm. A
 * bound that rounds onto the one below moves up by 1 bpm, so that the bounds keep rising.
 */
export function defaultHeartRateZones(lthr: number): HeartRateZones {
  let previous = 0;
  return FRIEL.map(([name, percent]) => {
    if (percent === undefined) return { name };
    const upTo = Math.max(Math.round((lthr * percent) / 100), previous + 1);
    previous = upTo;
    return { name, upTo };
  });
}

/**
 * The 1-based zone a value lies in: the first whose upper bound it does not pass (bounds are
 * inclusive: 55 % is Z1 of Coggan's zones, 55.5 % is Z2), else the last, open zone.
 */
export function zoneOf(value: number, zones: TrainingZones): number {
  const index = zones.findIndex((zone) => zone.upTo !== undefined && value <= zone.upTo);
  return index === -1 ? zones.length : index + 1;
}

/**
 * The bounds of the 1-based zone `zone`: from the bound of the zone below (0 for the first) up to
 * its own; `high` is undefined for the last, open zone. Undefined for a zone the list lacks.
 */
export function zoneBounds(
  zone: number,
  zones: TrainingZones,
): { readonly low: number; readonly high: number | undefined } | undefined {
  if (!Number.isInteger(zone) || zone < 1 || zone > zones.length) return undefined;
  return { low: zones[zone - 2]?.upTo ?? 0, high: zones[zone - 1]?.upTo };
}
