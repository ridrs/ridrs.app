// SPDX-License-Identifier: AGPL-3.0-or-later

import { definePlugin, filesSaveService } from '@ridrs/contracts';
import { save } from '@tauri-apps/plugin-dialog';
import { writeFile } from '@tauri-apps/plugin-fs';

/** The bytes of a base64 string. */
function decode(data: string): Uint8Array {
  const binary = atob(data);
  const bytes = new Uint8Array(binary.length);
  for (let at = 0; at < binary.length; at += 1) bytes[at] = binary.charCodeAt(at);
  return bytes;
}

/** The extension of a file name, without its dot: what the save dialog offers as the file type. */
const extensionOf = (fileName: string): string | undefined => {
  const dot = fileName.lastIndexOf('.');
  return dot > 0 ? fileName.slice(dot + 1) : undefined;
};

/**
 * `files.save` in the native app (ADR 0085): the system's save dialog through the official Tauri
 * dialog plugin, then the file written through the fs plugin (ADR 0038) to the path the rider
 * chose, and only to it: the dialog adds the chosen file to the fs scope, so the capability
 * allows no folder. Answers once the dialog closed; `saved: false` when the rider cancelled.
 */
export default definePlugin({
  initialize(ctx) {
    ctx.services.provide(filesSaveService, async ({ fileName, data }) => {
      const extension = extensionOf(fileName);
      const path = await save({
        defaultPath: fileName,
        ...(extension ? { filters: [{ name: extension.toUpperCase(), extensions: [extension] }] } : {}),
      });
      if (path === null) return { saved: false };
      await writeFile(path, decode(data));
      return { saved: true };
    });
  },
});
