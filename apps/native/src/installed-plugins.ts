// SPDX-License-Identifier: AGPL-3.0-or-later

import {
  INSTALLED_PLUGINS,
  PLUGIN_CHOICES_PATH,
  type PluginChoices,
  parsePluginChoices,
} from '@ridrs/contracts';
import type { PluginCandidate, PluginSource } from '@ridrs/core';
import { convertFileSrc, invoke } from '@tauri-apps/api/core';
import { BaseDirectory, readFile } from '@tauri-apps/plugin-fs';

/** The app's scheme for media in the WebView (crates/ridrs-media/src/protocol.rs). */
const SCHEME = 'ridrs-media';

/**
 * The URL of a media file with its folders as `/`, as the content security policy names the folder
 * `plugins/` (`convertFileSrc` would encode them): `ridrs-media://localhost/…` on the Mac,
 * `http://ridrs-media.localhost/…` where the WebView needs http.
 */
function moduleUrl(path: string): string {
  return `${convertFileSrc('', SCHEME)}${path.split('/').map(encodeURIComponent).join('/')}`;
}

/** The rider's choices of plugins (ADR 0106), read before the host starts; none without the file. */
export async function readPluginChoices(): Promise<PluginChoices> {
  const bytes = await readFile(PLUGIN_CHOICES_PATH, { baseDir: BaseDirectory.AppData }).catch(
    () => undefined,
  );
  return parsePluginChoices(bytes);
}

/**
 * The plugins the rider installed (ADR 0106): each folder `plugins/<id>/` of the media storage
 * with a manifest. Its entry, one bundled ES module, is loaded from the app's media scheme, which
 * the content security policy allows for scripts below `plugins/` only.
 */
export function createInstalledPluginSource(): PluginSource {
  return {
    async list(): Promise<readonly PluginCandidate[]> {
      const entries = await invoke<{ path: string }[]>('media_entries', {
        folder: INSTALLED_PLUGINS,
      }).catch(() => []);
      const paths = new Set(entries.map((entry) => entry.path));
      const folders = [...paths]
        .map((path) => path.split('/'))
        .filter((segments) => segments.length === 2 && segments[1] === 'manifest.json')
        .map((segments) => segments[0] as string);
      return folders.map((folder): PluginCandidate => {
        const below = (path: string) =>
          `${INSTALLED_PLUGINS}/${folder}/${path.replace(/^\.\//, '')}`;
        return {
          folder,
          location: `media:${INSTALLED_PLUGINS}/${folder}`,
          readManifest: async () =>
            new TextDecoder().decode(
              new Uint8Array(
                await invoke<ArrayBuffer>('media_read', { path: below('manifest.json') }),
              ),
            ),
          hasModule: async (path) => paths.has(`${folder}/${path.replace(/^\.\//, '')}`),
          loadModule: (path) => import(/* @vite-ignore */ moduleUrl(below(path))),
        };
      });
    },
  };
}
