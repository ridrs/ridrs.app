// SPDX-License-Identifier: AGPL-3.0-or-later

import type { ChartSummary, PowerBasis } from '@ridrs/workout';
import type { Messages } from './i18n/index.ts';

/** "65 min", "45 s": the same in every language, and in minutes as the cards of the app say them. */
export function durationText(seconds: number): string {
  const total = Math.round(seconds);
  return total < 60 ? `${total} s` : `${Math.round(total / 60)} min`;
}

/** The short description the chart reads out: "65 minutes, 3 intervals of 12 minutes at 90 %". */
export function describeSummary(summary: ChartSummary, unit: PowerBasis, text: Messages): string {
  const { mainIntervals: main } = summary;
  if (summary.durationSeconds <= 0 && !main) return text.noSteps;
  const duration = text.described(
    text.minutes(Math.max(1, Math.round(summary.durationSeconds / 60))),
    summary.durationEstimated,
  );
  if (!main) return duration;
  const at = unit === 'watts' ? `${Math.round(main.value)} W` : `${Math.round(main.value)} %`;
  const each = text.minutes(Math.max(1, Math.round(main.durationSeconds / 60)));
  return `${duration}, ${text.intervals(main.count, each, at)}`;
}
