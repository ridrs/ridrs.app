// SPDX-License-Identifier: AGPL-3.0-or-later

import {
  dataArchiveCapability,
  definePlugin,
  storageMediaCapability,
  videoImporterCapability,
} from '@ridrs/contracts';
import { createIncyclistImporter, INCYCLIST_FORMAT, inspectIncyclist } from './incyclist.ts';

/** Post-processing of the format `incyclist-gpx-import`, for every source that ships it. */
export default definePlugin({
  initialize(ctx) {
    ctx.capabilities.provide(videoImporterCapability, {
      format: INCYCLIST_FORMAT,
      inspect: inspectIncyclist,
      import: (pack, directory, facts) =>
        createIncyclistImporter(
          ctx.capabilities.get(storageMediaCapability),
          ctx.capabilities.get(dataArchiveCapability),
        ).import(pack, directory, facts),
    });
  },
});
