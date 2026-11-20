// SPDX-License-Identifier: AGPL-3.0-or-later
// Incyclist package without video (CLOUDFLARE-KONZEPT.md 4.7), same layout as catalog-web's packages:
// <CC>_<Name>.xml (control file <gpx-import>), <CC>_<Name>.gpx (one point per video second, elevation,
// time), optional preview image, LIESMICH.txt. Built in the worker with fflate (as catalog-web/scripts/lib/zip.mjs).
//
// Time convention (as catalog-web/scripts/lib/video.mjs reads packages): Incyclist starts the video at
// <start-frame> and aligns GPX time 0 with it. So <start-frame> = round(t_start × fps) + 1 and every
// <time> is 2000-01-01T00:00:00Z plus (video second − t_start); <ridrs:videoTime> carries the absolute video second.
import { zipSync } from 'fflate';
import { kmAlong, eleAt, trackAt } from '../site/lib/route-sync.js';

export const MIN_LEVEL = 3; // export from Lokalisierungsstufe 3 (1 best … 3)

const xmlEsc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' })[c]);

/** File stem <CC>_<Name>: ASCII letters, digits and underscores only, at most 60 characters of name. */
export function incyclistName({ country, place, title, id }) {
  const cc = /^[A-Za-z]{2}$/.test(country || '') ? country.toUpperCase() : 'XX';
  const clean = (s) => String(s || '').replace(/ß/g, 'ss').replace(/æ/gi, 'ae').replace(/ø/gi, 'o').replace(/đ/gi, 'd').replace(/ł/gi, 'l')
    .normalize('NFKD').replace(/\p{M}/gu, '').replace(/[^A-Za-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 60).replace(/_+$/, '');
  const name = clean(place) || clean(title) || clean(id) || 'Route';
  return `${cc}_${name}`;
}

/** Control file for Incyclist's "Eigenes Video" import. */
export function controlXml({ name, title, country, fps, startFrame, preview }) {
  return `<?xml version="1.0" encoding="UTF-8"?>
<gpx-import>
  <name>${xmlEsc(name)}</name>
  <title>${xmlEsc(title)}</title>
  <country>${xmlEsc(country || '')}</country>
  <video-file-path>${xmlEsc(name)}.mp4</video-file-path>
  <gpx-file-path>${xmlEsc(name)}.gpx</gpx-file-path>
${preview ? `  <preview>${xmlEsc(preview)}</preview>\n` : ''}  <framerate>${fps}</framerate>
  <start-frame>${startFrame}</start-frame>
</gpx-import>
`;
}

const iso = (s) => new Date(Date.UTC(2000, 0, 1) + Math.round(s * 1000)).toISOString().replace('.000Z', 'Z');

/**
 * GPX with one point per video second. Elevation: the track's own `e`, else the route profile [[km, ele]]
 * interpolated by km along the track (scaled to the profile's length).
 */
export function videoGpx({ name, title, track, profile, videoId, level }) {
  const t0 = track.t[0];
  let ele = track.e?.length === track.t.length ? track.e : null;
  if (!ele && profile?.length > 1) {
    const k = kmAlong(track.c), scale = profile.at(-1)[0] / (k.at(-1) || 1);
    ele = k.map((x) => Math.round(eleAt(profile, x * scale) * 10) / 10);
  }
  const pts = track.t.map((s, i) => `<trkpt lat="${track.c[i][1].toFixed(6)}" lon="${track.c[i][0].toFixed(6)}">${ele ? `<ele>${ele[i]}</ele>` : ''}<time>${iso(s - t0)}</time><extensions><ridrs:videoTime>${s}</ridrs:videoTime></extensions></trkpt>`);
  return `<?xml version="1.0" encoding="UTF-8"?>
<gpx version="1.1" creator="ridrs-scenic" xmlns="http://www.topografix.com/GPX/1/1" xmlns:ridrs="https://ridrs.org/gpx/1">
<metadata><name>${xmlEsc(title)}</name><desc>Video-synchrone Route zu https://www.youtube.com/watch?v=${videoId} (Lokalisierungsstufe ${level}). Zeit 00:00:00 = Start-Frame der Fahrt (Videosekunde ${t0}); ridrs:videoTime = Sekunde im Video. Geometry derived from OpenStreetMap data.</desc><copyright author="OpenStreetMap contributors"><year>${new Date().getUTCFullYear()}</year><license>https://opendatacommons.org/licenses/odbl/1-0/</license></copyright><link href="https://www.openstreetmap.org/copyright"><text>Map data © OpenStreetMap contributors (ODbL)</text></link></metadata>
<trk><name>${xmlEsc(name)}</name><trkseg>
${pts.join('\n')}
</trkseg></trk>
</gpx>
`;
}

export function readme({ name, title, videoId, level, levelName, fps, fpsKnown, t0, image }) {
  return `${title}
${'='.repeat(Math.min(70, [...title].length))}

Dieses Paket ist eine Videostrecke für Incyclist (Import „Eigenes Video“), ohne Video.

Inhalt:
- ${name}.xml  Steuerdatei
- ${name}.gpx  Strecke, ein Punkt pro Videosekunde, mit Höhe und Zeit
${image ? `- ${image.file}  Vorschaubild${image.credit ? ` (${image.credit})` : ''}\n` : ''}- LIESMICH.txt

Video: Das Video ist nicht enthalten und darf nicht weitergegeben werden. Die Rechte liegen bei der
Urheberin oder dem Urheber (https://www.youtube.com/watch?v=${videoId}). Wer eine eigene Kopie mit Erlaubnis
der Urheberin oder des Urhebers oder eine eigene Lizenz hat, legt sie unter dem Namen ${name}.mp4 neben die
XML-Datei. Das Paket ist nur für den privaten Gebrauch.

Genauigkeit: Lokalisierungsstufe ${level} (${levelName}).${level >= 3 ? ' Die Zeit ist nur aus Start, Ende und einem Geschwindigkeitsmodell geschätzt: Video und Position können um bis zu etwa 1 km abweichen.' : ''}
Die Fahrt beginnt bei Videosekunde ${t0} (Start-Frame ${Math.round(t0 * fps) + 1} bei ${fps} fps${fpsKnown ? '' : ', Bildrate nicht erfasst, 30 fps angenommen; bei anderer Bildrate in der XML anpassen'}).

Quellen und Lizenzen:
- Strecke: © OpenStreetMap-Mitwirkende, ODbL 1.0 (https://www.openstreetmap.org/copyright)
- Höhen: Copernicus DEM GLO-30 (c) DLR e.V. 2010-2014 and (c) Airbus Defence and Space GmbH 2014-2018, provided under COPERNICUS by the European Union and ESA
- Zuordnung von Videozeit und Position: ridrs Scenic (ridrs.app/scenic)
`;
}

/** The track with exactly one point per whole video second (pipeline tracks may be sparser or fractional). */
export function perSecond(track) {
  const { t } = track;
  if (t.every((s, i) => Number.isInteger(s) && (i === 0 || s - t[i - 1] === 1))) return track;
  const out = { v: 1, t: [], c: [] };
  for (let s = Math.ceil(t[0]); s <= Math.floor(t.at(-1)); s++) {
    const p = trackAt(track, s);
    out.t.push(s); out.c.push([Math.round(p[0] * 1e6) / 1e6, Math.round(p[1] * 1e6) / 1e6]);
  }
  return out;
}

/** The ZIP: control file, GPX, optional image ({ext, bytes, credit}), LIESMICH.txt. */
export function buildIncyclistZip({ videoId, title, country, place, track: rawTrack, profile, fps, level, levelName, image }) {
  const track = perSecond(rawTrack);
  const name = incyclistName({ country, place, title, id: videoId });
  const fpsKnown = fps > 0;
  const f = fpsKnown ? Math.round(fps * 100) / 100 : 30;
  const t0 = track.t[0];
  const img = image ? { file: `${name}.${image.ext}`, credit: image.credit } : null;
  const enc = new TextEncoder(), MTIME = new Date(2000, 0, 1);
  const files = {
    [`${name}.xml`]: [enc.encode(controlXml({ name, title, country, fps: f, startFrame: Math.round(t0 * f) + 1, preview: img?.file })), { mtime: MTIME, level: 6 }],
    [`${name}.gpx`]: [enc.encode(videoGpx({ name, title, track, profile, videoId, level })), { mtime: MTIME, level: 6 }],
  };
  if (img) files[img.file] = [image.bytes, { mtime: MTIME, level: 0 }];
  files['LIESMICH.txt'] = [enc.encode(readme({ name, title, videoId, level, levelName, fps: f, fpsKnown, t0, image: img })), { mtime: MTIME, level: 6 }];
  return { name, zip: zipSync(files) };
}
