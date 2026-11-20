// SPDX-License-Identifier: AGPL-3.0-or-later
// node --test test/ — Incyclist package naming, control file, GPX and ZIP (src/incyclist.js), and image sniffing.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { unzipSync, strFromU8 } from 'fflate';
import { incyclistName, controlXml, videoGpx, buildIncyclistZip, perSecond } from '../src/incyclist.js';
import { sniffImage } from '../src/images.js';

test('names: <CC>_<Name>, ASCII only', () => {
  assert.equal(incyclistName({ country: 'IT', place: 'Passo dello Stelvio' }), 'IT_Passo_dello_Stelvio');
  assert.equal(incyclistName({ country: 'at', place: 'Großglockner-Hochalpenstraße' }), 'AT_Grossglockner_Hochalpenstrasse');
  assert.equal(incyclistName({ country: 'FR', place: null, title: 'Col de l’Iseran (4K) – Val d’Isère → Bonneval' }), 'FR_Col_de_l_Iseran_4K_Val_d_Isere_Bonneval');
  assert.equal(incyclistName({ country: null, place: '東京', title: 'Tokyo Drive', id: 'abc' }), 'XX_Tokyo_Drive');
  assert.ok(incyclistName({ country: 'DE', place: 'x'.repeat(200) }).length <= 63);
});

test('control file', () => {
  const xml = controlXml({ name: 'IT_Passo', title: 'Passo <A & B>', country: 'IT', fps: 59.94, startFrame: 3121, preview: 'IT_Passo.jpg' });
  assert.match(xml, /^<\?xml version="1.0" encoding="UTF-8"\?>\n<gpx-import>/);
  assert.match(xml, /<title>Passo &lt;A &amp; B&gt;<\/title>/);
  assert.match(xml, /<video-file-path>IT_Passo\.mp4<\/video-file-path>/);
  assert.match(xml, /<gpx-file-path>IT_Passo\.gpx<\/gpx-file-path>/);
  assert.match(xml, /<preview>IT_Passo\.jpg<\/preview>/);
  assert.match(xml, /<framerate>59\.94<\/framerate>/);
  assert.match(xml, /<start-frame>3121<\/start-frame>/);
  assert.doesNotMatch(controlXml({ name: 'X', title: 'X', fps: 30, startFrame: 1 }), /<preview>/);
});

const track = { v: 1, t: [52, 53, 54], c: [[7, 45], [7.0001, 45.0001], [7.0002, 45.0002]] };
test('GPX: one point per second, time from the start frame, video time, elevation from the profile', () => {
  const gpx = videoGpx({ name: 'X', title: 'T', track, profile: [[0, 1000], [0.0272, 1010]], videoId: 'abcdefghijk', level: 2 });
  const pts = [...gpx.matchAll(/<trkpt lat="([\d.]+)" lon="([\d.]+)"><ele>([\d.]+)<\/ele><time>([^<]+)<\/time><extensions><ridrs:videoTime>(\d+)/g)];
  assert.equal(pts.length, 3);
  assert.deepEqual(pts.map((m) => m[4]), ['2000-01-01T00:00:00Z', '2000-01-01T00:00:01Z', '2000-01-01T00:00:02Z']);
  assert.deepEqual(pts.map((m) => +m[5]), [52, 53, 54]);
  assert.equal(+pts[0][3], 1000);
  assert.equal(+pts[2][3], 1010);
  assert.match(gpx, /opendatacommons\.org\/licenses\/odbl/);
  const own = videoGpx({ name: 'X', title: 'T', track: { ...track, e: [5, 6, 7] }, profile: null, videoId: 'abcdefghijk', level: 2 });
  assert.match(own, /<ele>7<\/ele>/);
});

test('ZIP: control file, GPX, preview, LIESMICH; no video, no download instructions', () => {
  const jpg = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 16, 0x4a, 0x46, 0x49, 0x46, 0, 1, 1, 0, 0, 1, 0, 1, 0, 0, 0xff, 0xc0, 0, 17, 8, 2, 208, 5, 0, 3]);
  const { name, zip } = buildIncyclistZip({ videoId: 'abcdefghijk', title: 'Passo dello Stelvio – Bormio', country: 'IT', place: 'Passo dello Stelvio',
    track, profile: null, fps: 50, level: 3, levelName: 'Geschätzt synchron', image: { ext: 'jpg', bytes: jpg, credit: 'Foto: A. B.' } });
  assert.equal(name, 'IT_Passo_dello_Stelvio');
  const files = unzipSync(zip);
  assert.deepEqual(Object.keys(files).sort(), ['IT_Passo_dello_Stelvio.gpx', 'IT_Passo_dello_Stelvio.jpg', 'IT_Passo_dello_Stelvio.xml', 'LIESMICH.txt']);
  const xml = strFromU8(files['IT_Passo_dello_Stelvio.xml']);
  assert.match(xml, /<start-frame>2601<\/start-frame>/); // round(52 s × 50 fps) + 1
  assert.match(xml, /<preview>IT_Passo_dello_Stelvio\.jpg<\/preview>/);
  const readme = strFromU8(files['LIESMICH.txt']);
  assert.match(readme, /IT_Passo_dello_Stelvio\.mp4/);
  assert.match(readme, /abweichen/); // level 3 warning
  assert.doesNotMatch(readme, /yt-dlp|youtube-dl|herunterladen|download/i);
  assert.ok(!Object.keys(files).some((f) => f.endsWith('.mp4')));
  const noFps = unzipSync(buildIncyclistZip({ videoId: 'abcdefghijk', title: 'T', country: 'IT', place: 'P', track, fps: null, level: 2, levelName: 'Verankert' }).zip);
  assert.match(strFromU8(noFps['IT_P.xml']), /<framerate>30<\/framerate>/);
  assert.match(strFromU8(noFps['LIESMICH.txt']), /30 fps angenommen/);
});

test('image sniffing: type and size from the bytes', () => {
  const png = new Uint8Array(32); png.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52, 0, 0, 5, 0, 0, 0, 2, 208]);
  assert.deepEqual(sniffImage(png), { mime: 'image/png', ext: 'png', width: 1280, height: 720 });
  const jpg = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 16, 0x4a, 0x46, 0x49, 0x46, 0, 1, 1, 0, 0, 1, 0, 1, 0, 0, 0xff, 0xc0, 0, 17, 8, 2, 208, 5, 0, 3]);
  assert.deepEqual(sniffImage(jpg), { mime: 'image/jpeg', ext: 'jpg', width: 1280, height: 720 });
  const webp = new Uint8Array(32); webp.set([...Buffer.from('RIFF'), 0, 0, 0, 0, ...Buffer.from('WEBPVP8X'), 10, 0, 0, 0, 0, 0, 0, 0, 0xff, 0x04, 0, 0xcf, 0x02, 0]);
  assert.deepEqual(sniffImage(webp), { mime: 'image/webp', ext: 'webp', width: 1280, height: 720 });
  assert.equal(sniffImage(new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg"></svg>')), null);
});

test('tracks are resampled to one point per whole second', () => {
  const r = perSecond({ t: [0.5, 2.5, 4.5], c: [[0, 0], [2, 0], [4, 0]] });
  assert.deepEqual(r.t, [1, 2, 3, 4]);
  assert.deepEqual(r.c.map((p) => p[0]), [0.5, 1.5, 2.5, 3.5]);
  assert.equal(perSecond(track), track);
});
