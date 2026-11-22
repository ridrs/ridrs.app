// SPDX-License-Identifier: AGPL-3.0-or-later

import {
  type AppFiles,
  type DataDrop,
  type HostDescription,
  INSTALLED_PLUGINS,
  type MediaFiles,
  PLUGIN_CHOICES_PATH,
  type PluginChoices,
  type PluginEntry,
  type PluginManifest,
  type PluginPreview,
  parseManifestJson,
  parsePluginChoices,
} from '@ridrs/contracts';

/** This plugin's id: it stays on, or the rider could not switch anything on again. */
export const SELF = 'plugins-manager';

/**
 * Plugins that stay on besides this one: the settings, where the plugins page is, and the main
 * screen and menu that lead there.
 */
const ALWAYS_ON = ['ui-settings', 'ui-main-screen', 'ui-main-menu'];

/** What the plugin manager reads and writes; the plugin's context in the app. */
export interface PluginServices {
  readonly host: () => HostDescription;
  readonly files?: AppFiles;
  readonly media?: MediaFiles;
  readonly drop?: DataDrop;
}

const folderOf = (id: string) => `${INSTALLED_PLUGINS}/${id}`;
const reasonOf = (error: unknown) => (error instanceof Error ? error.message : String(error));

/**
 * The plugins of the app and the ones the rider installed (ADR 0106): what the plugins page lists
 * (`plugins.list`), switching them on and off for the next start, installing a dragged ZIP into
 * the media storage and removing an installed one. The rider's choices are the file
 * {@link PLUGIN_CHOICES_PATH} of the app files.
 */
export class Plugins {
  private choices: PluginChoices = parsePluginChoices(undefined);
  /** The installed plugins' manifests, by their ids. */
  private installed = new Map<string, PluginManifest>();
  private entries = new Map<string, PluginEntry>();

  constructor(
    private readonly services: PluginServices,
    private readonly publish: (entries: ReadonlyMap<string, PluginEntry>) => void,
  ) {}

  /** Reads the choices and the installed plugins, then lists every plugin. */
  async load(): Promise<void> {
    const { files, media } = this.services;
    this.choices = parsePluginChoices(files ? await files.read(PLUGIN_CHOICES_PATH).catch(() => undefined) : undefined);
    this.installed = new Map();
    if (media) {
      const ids = new Set(
        (await media.entries(INSTALLED_PLUGINS).catch(() => []))
          .map((entry) => entry.path.split('/'))
          .filter((segments) => segments.length === 2 && segments[1] === 'manifest.json')
          .map((segments) => segments[0] as string),
      );
      for (const id of ids) {
        const manifest = await this.readManifest(media, id);
        if (manifest?.id === id) this.installed.set(id, manifest);
      }
    }
    this.list();
  }

  private async readManifest(media: MediaFiles, id: string): Promise<PluginManifest | undefined> {
    try {
      const parsed = parseManifestJson(new TextDecoder().decode(await media.read(`${folderOf(id)}/manifest.json`)));
      return parsed.success ? parsed.data : undefined;
    } catch {
      return undefined;
    }
  }

  /** Every plugin the host runs, every one the rider switched off, every installed one. */
  private list(): void {
    const host = this.services.host();
    const running = new Map(host.plugins.map((plugin) => [plugin.id, plugin]));
    const ids = new Set([...running.keys(), ...this.choices.disabled, ...this.installed.keys()]);
    // The running plugins that need a plugin: those that require a capability it provides.
    const neededBy = new Map<string, string[]>();
    for (const plugin of host.plugins) {
      for (const capability of plugin.requires) {
        for (const provider of host.resolution[capability] ?? []) {
          if (provider !== plugin.id) neededBy.set(provider, [...(neededBy.get(provider) ?? []), plugin.id]);
        }
      }
    }
    const locked = new Set([SELF, ...ALWAYS_ON, ...(host.resolution['storage.app-files'] ?? [])]);
    const entries = new Map<string, PluginEntry>();
    for (const id of [...ids].sort()) {
      const plugin = running.get(id);
      const manifest = this.installed.get(id);
      entries.set(id, {
        id,
        name: manifest?.name ?? id,
        ...(manifest?.version ?? plugin?.version ? { version: manifest?.version ?? plugin?.version } : {}),
        origin: manifest ? 'installed' : 'bundled',
        enabled: !this.choices.disabled.includes(id),
        // Listed while the host starts its plugins: one initialized is about to start.
        running: plugin?.state === 'started' || plugin?.state === 'initialized',
        locked: locked.has(id),
        neededBy: [...new Set(neededBy.get(id) ?? [])].sort(),
        programs: [...(this.choices.programs[id] ?? [])],
      });
    }
    this.entries = entries;
    this.publish(entries);
  }

  /** Starts a plugin at the next start, or not. */
  async setEnabled(id: string, enabled: boolean): Promise<void> {
    const entry = this.entries.get(id);
    if (!entry) throw new Error(`There is no plugin "${id}"`);
    if (entry.locked && !enabled) throw new Error(`The plugin "${id}" stays on`);
    const disabled = this.choices.disabled.filter((each) => each !== id);
    await this.save({ ...this.choices, disabled: enabled ? disabled : [...disabled, id].sort() });
    this.list();
  }

  /** What the dragged file `file` would install, or why it cannot be installed. */
  async preview(file: string): Promise<{ ok: true; plugin: PluginPreview } | { ok: false; reason: string }> {
    try {
      return { ok: true, plugin: await this.inspect(file) };
    } catch (error) {
      return { ok: false, reason: reasonOf(error) };
    }
  }

  private async inspect(id: string): Promise<PluginPreview> {
    const dropped = this.services.drop?.file(id);
    if (!dropped) throw new Error('The file is gone');
    const { entries } = await dropped.peek();
    const entry = entries?.find((each) => each.name === 'manifest.json');
    if (!entries || !entry?.bytes) throw new Error(`${dropped.name} is no plugin: it has no manifest.json`);
    const parsed = parseManifestJson(new TextDecoder().decode(entry.bytes));
    if (!parsed.success) throw new Error(`${dropped.name} has no valid manifest: ${parsed.message}`);
    const manifest = parsed.data;
    if (!entries.some((each) => each.name === manifest.entry)) throw new Error(`${dropped.name} has no ${manifest.entry}`);
    if (this.entries.get(manifest.id)?.origin === 'bundled' || this.services.host().plugins.some((plugin) => plugin.id === manifest.id && !this.installed.has(manifest.id))) {
      throw new Error(`The app has a plugin "${manifest.id}" already`);
    }
    return {
      id: manifest.id,
      name: manifest.name,
      version: manifest.version,
      capabilities: [...manifest.requires, ...(manifest.optionalRequires ?? [])],
      programs: [...(manifest.programs ?? [])],
    };
  }

  /** Installs the plugin of the dragged file `file` and grants it its programs. */
  async install(file: string, move = false): Promise<string> {
    const plugin = await this.inspect(file);
    const { media } = this.services;
    const dropped = this.services.drop?.file(file);
    if (!media || !dropped) throw new Error('This app cannot install plugins');
    const folder = folderOf(plugin.id);
    await media.remove(folder);
    await dropped.extractTo(folder);
    const manifest = await this.readManifest(media, plugin.id);
    if (!manifest) {
      await media.remove(folder);
      throw new Error(`${dropped.name} has no valid manifest`);
    }
    this.installed.set(plugin.id, manifest);
    await this.save({ ...this.choices, programs: { ...this.choices.programs, [plugin.id]: plugin.programs } });
    if (move) await dropped.removeOriginal().catch(() => undefined);
    this.list();
    return plugin.id;
  }

  /** Removes an installed plugin from the device, its grants and its choice with it. */
  async remove(id: string): Promise<void> {
    if (!this.installed.has(id)) throw new Error(`"${id}" is no installed plugin`);
    await this.services.media?.remove(folderOf(id));
    this.installed.delete(id);
    const { [id]: _granted, ...programs } = this.choices.programs;
    await this.save({ ...this.choices, disabled: this.choices.disabled.filter((each) => each !== id), programs });
    this.list();
  }

  private async save(choices: PluginChoices): Promise<void> {
    const { files } = this.services;
    if (!files) throw new Error('This app cannot keep the choices of plugins');
    await files.replace(PLUGIN_CHOICES_PATH, new TextEncoder().encode(`${JSON.stringify(choices, null, 2)}\n`));
    this.choices = choices;
  }
}
