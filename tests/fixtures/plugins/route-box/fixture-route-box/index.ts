// SPDX-License-Identifier: AGPL-3.0-or-later

import { definePlugin, type RouteOffer, routeOfferState } from '@ridrs/contracts';

/** A file of the ride package as a `data:` URL: the box fetches it like a stored one. */
const file = (type: string, text: string) =>
  `data:${type};base64,${Buffer.from(text).toString('base64')}`;

/** Five points due north and then east, about 1.2 km: a track the map can draw. */
const POINTS = [
  [46.0, 7.0],
  [46.002, 7.0],
  [46.004, 7.0],
  [46.006, 7.0],
  [46.008, 7.003],
] as const;

const GPX = `<?xml version="1.0" encoding="UTF-8"?>
<gpx version="1.1" creator="ridrs fixture" xmlns="http://www.topografix.com/GPX/1/1">
  <trk><name>Hill</name><trkseg>
${POINTS.map(([lat, lon], i) => `    <trkpt lat="${lat}" lon="${lon}"><ele>${100 + i * 10}</ele><time>2026-01-01T00:0${i}:00Z</time></trkpt>`).join('\n')}
  </trkseg></trk>
</gpx>`;

const CONTROL = `<?xml version="1.0" encoding="UTF-8"?>
<gpx-import>
  <title>Hill</title>
  <video-file-path>video.mp4</video-file-path>
  <gpx-file-path>track.gpx</gpx-file-path>
  <framerate>30</framerate>
</gpx-import>`;

const offer: RouteOffer = {
  id: 'fixture-route-box/hill',
  kind: 'video',
  title: 'Hill',
  distance: 1200,
  ascent: 40,
  sparkline: [100, 105, 112, 120, 131, 140],
  tags: {},
  availability: {
    state: 'ready',
    files: {
      'hill/hill.xml': file('application/xml', CONTROL),
      'hill/video.mp4': 'data:video/mp4;base64,',
      'hill/track.gpx': file('application/gpx+xml', GPX),
    },
  },
  world: { landscape: 'fixture-route-box/landscape', route: 'hill' },
};

/** One downloaded video route with a track and elevations, for the route box scenarios. */
export default definePlugin({
  start(ctx) {
    ctx.state.set(routeOfferState, offer.id, offer);
  },
});
