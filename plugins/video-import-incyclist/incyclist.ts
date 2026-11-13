// SPDX-License-Identifier: AGPL-3.0-or-later

import {
  type DataArchive,
  type MediaFiles,
  type VideoImporter,
  type VideoRoute,
  videoRouteSchema,
} from '@ridrs/contracts';
import {
  CONTROL_FILE,
  controlFromRoute,
  decodeText,
  inspectPackage,
  parseControl,
  pictureOf,
  writeControl,
} from '@ridrs/ride';

/** Incyclist's video package: a control file (`gpx-import`), the video and its GPX track. */
export const INCYCLIST_FORMAT = 'incyclist-gpx-import';

/** Counts up when the import makes different routes from the same package. */
export const IMPORT_VERSION = '2';

const nameOf = (path: string) => path.split('/').at(-1) ?? path;

/** Whether the entries of a ZIP make an Incyclist package (`@ridrs/ride`, ADR 0093). */
export const inspectIncyclist = inspectPackage;

/**
 * Turns an Incyclist ZIP into a ridrs video route: unpacked into the folder, the video, the track
 * and the picture renamed (`video.mp4`, `track.gpx`, `thumbnail.png` or `.jpg`), everything else
 * removed, the control file `route.xml` written for them (ADR 0094).
 */
export function createIncyclistImporter(media: MediaFiles, archive: DataArchive): VideoImporter {
  return {
    format: INCYCLIST_FORMAT,
    inspect: inspectIncyclist,
    async import(pack, directory, facts, onProgress) {
      // Unpacking is the import's work; renaming and writing route.json take no time.
      const files = await archive.extract(pack, `${directory}/package`, ({ received, size }) => {
        if (size) onProgress?.(Math.min(received / size, 1));
      });
      const controlFile = files.find((file) => file.toLowerCase().endsWith('.xml'));
      if (!controlFile) {
        throw new Error('The package has no control file');
      }
      const control = parseControl(decodeText(await media.read(controlFile)));
      const fileNamed = (name: string) => {
        const file = files.find((candidate) => nameOf(candidate) === name);
        if (!file) {
          throw new Error(`The package has no file "${name}"`);
        }
        return file;
      };
      const video = fileNamed(control.video);
      const picture = pictureOf(control, files, video);
      const thumbnail = picture ? `thumbnail.${picture.slice(-3).toLowerCase()}` : undefined;
      await media.move(video, `${directory}/video.mp4`);
      await media.move(fileNamed(control.gpx), `${directory}/track.gpx`);
      if (picture && thumbnail) await media.move(picture, `${directory}/${thumbnail}`);
      await media.remove(`${directory}/package`);
      const route = videoRouteSchema.parse({
        format: 'ridrs-video-route',
        version: 1,
        title: facts.title ?? control.title ?? control.name ?? facts.fallbackTitle ?? 'Video',
        ...(facts.source ? { source: facts.source } : {}),
        notes: control.notes.map((note) => ({ distance: note.distance, text: { ...note.text } })),
        segments: control.segments.map((segment) => ({ ...segment })),
        video: { file: 'video.mp4', framerate: control.framerate, startFrame: control.startFrame },
        track: { file: 'track.gpx' },
        ...(thumbnail ? { thumbnail: { file: thumbnail } } : {}),
        imported: { by: 'video-import-incyclist', version: IMPORT_VERSION },
      } satisfies VideoRoute);
      // The route's control file (ADR 0094): what Incyclist and the video world read.
      await media.write(`${directory}/${CONTROL_FILE}`, new TextEncoder().encode(writeControl(controlFromRoute(route))));
      return route;
    },
  };
}
