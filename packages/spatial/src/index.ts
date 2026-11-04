// SPDX-License-Identifier: AGPL-3.0-or-later

// Pure, deterministic sampling of the spatial data layer: no clock, no timers, no I/O. The core
// (`ctx.spatial`) owns series ownership and lifecycles; plugins never import this package.
export { SpatialSeries, type SpatialSeriesOptions } from './series.ts';
