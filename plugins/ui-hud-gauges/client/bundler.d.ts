// SPDX-License-Identifier: AGPL-3.0-or-later

/** The URL of MapLibre's worker as the bundler builds it (Vite's `?worker&url`, ADR 0097). */
declare module 'maplibre-gl/dist/maplibre-gl-worker.mjs?worker&url' {
  const url: string;
  export default url;
}
