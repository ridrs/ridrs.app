// SPDX-License-Identifier: AGPL-3.0-or-later

import type {
  Diagnostic,
  UiManifestSection,
  UiRegistry,
  UiRegistryContribution,
  UiRegistryScreen,
} from '@ridrs/contracts';

export interface UiRegistryInput {
  readonly pluginId: string;
  readonly ui: UiManifestSection;
  /** Whether the plugin source can deliver `ui.client`. */
  readonly clientAvailable: boolean;
}

export interface UiRegistryResult {
  readonly registry: Omit<UiRegistry, 'revision'>;
  readonly problems: readonly Diagnostic[];
}

type UiRegistryCapability = UiRegistry['capabilities'][number];

interface InputWithProvided {
  readonly plugin: UiRegistryInput;
  readonly provided: UiManifestSection['provides'][number];
}

const byString = (a: string, b: string) => a.localeCompare(b);

function sortedUnion(lists: Iterable<readonly string[]>): string[] {
  return [...new Set([...lists].flat())].sort(byString);
}

/**
 * Indexes the UI sections of the started plugins. Pure and deterministic: the result depends only
 * on the set of inputs, never on their order or on start timing. The core validates and orders
 * entries but never interprets what a screen or an extension point means.
 */
export function computeUiRegistry(inputs: readonly UiRegistryInput[]): UiRegistryResult {
  const plugins = [...inputs].sort((a, b) => byString(a.pluginId, b.pluginId));
  const problems: Diagnostic[] = [];

  const withClient = plugins.filter((plugin) => {
    const { ui } = plugin;
    const declaresUi =
      ui.screens.length > 0 || ui.contributions.length > 0 || ui.provides.length > 0;
    if (declaresUi && !plugin.clientAvailable) {
      problems.push({
        code: 'client-entry-missing',
        pluginId: plugin.pluginId,
        message: `Client module "${ui.client}" of plugin "${plugin.pluginId}" is not available; its screens, contributions and UI capabilities are left out`,
        details: { client: ui.client },
      });
      return false;
    }
    return declaresUi;
  });

  // Screens: the smallest plugin id wins a screen id.
  const screenOwners = new Map<string, string>();
  for (const plugin of withClient) {
    for (const screen of plugin.ui.screens) {
      const owner = screenOwners.get(screen.id);
      if (owner === undefined) {
        screenOwners.set(screen.id, plugin.pluginId);
      } else if (owner !== plugin.pluginId) {
        problems.push({
          code: 'duplicate-screen',
          pluginId: plugin.pluginId,
          message: `Screen "${screen.id}" of plugin "${plugin.pluginId}" is left out: plugin "${owner}" already declares it`,
          details: { screen: screen.id, winner: owner },
        });
      }
    }
  }
  const acceptedScreens = withClient.flatMap((plugin) =>
    plugin.ui.screens
      .filter((screen) => screenOwners.get(screen.id) === plugin.pluginId)
      .map((screen) => ({ plugin, screen })),
  );

  // Extension points: the smallest plugin id wins a declaration.
  const pointOwners = new Map<string, string>();
  const declare = (pluginId: string, point: string) => {
    const owner = pointOwners.get(point);
    if (owner === undefined) {
      pointOwners.set(point, pluginId);
    } else if (owner !== pluginId) {
      problems.push({
        code: 'duplicate-extension-point',
        pluginId,
        message: `Extension point "${point}" of plugin "${pluginId}" is left out: plugin "${owner}" already declares it`,
        details: { extensionPoint: point, winner: owner },
      });
    }
  };
  for (const { plugin, screen } of acceptedScreens) {
    for (const point of screen.extensionPoints) {
      declare(plugin.pluginId, point);
    }
  }
  for (const plugin of withClient) {
    for (const contribution of plugin.ui.contributions) {
      for (const point of contribution.extensionPoints) {
        declare(plugin.pluginId, point);
      }
    }
  }
  const ownedPoints = (pluginId: string, points: readonly string[]) =>
    points.filter((point) => pointOwners.get(point) === pluginId);

  // A point is available once its declaring screen or contribution is itself in the registry, so
  // nested points (a contribution offering points) resolve to a fixed point.
  const available = new Set(
    acceptedScreens.flatMap(({ plugin, screen }) =>
      ownedPoints(plugin.pluginId, screen.extensionPoints),
    ),
  );
  const pending = withClient.flatMap((plugin) =>
    plugin.ui.contributions.map((contribution) => ({ plugin, contribution })),
  );
  const accepted: typeof pending = [];
  let progressed = true;
  while (progressed) {
    progressed = false;
    for (const entry of [...pending]) {
      if (available.has(entry.contribution.extensionPoint)) {
        pending.splice(pending.indexOf(entry), 1);
        accepted.push(entry);
        for (const point of ownedPoints(
          entry.plugin.pluginId,
          entry.contribution.extensionPoints,
        )) {
          available.add(point);
        }
        progressed = true;
      }
    }
  }
  for (const { plugin, contribution } of pending) {
    problems.push({
      code: 'unknown-extension-point',
      pluginId: plugin.pluginId,
      message: `Contribution "${contribution.id}" of plugin "${plugin.pluginId}" targets the unknown extension point "${contribution.extensionPoint}"`,
      details: { contribution: contribution.id, extensionPoint: contribution.extensionPoint },
    });
  }

  const screens: UiRegistryScreen[] = acceptedScreens
    .map(({ plugin, screen }) => ({
      pluginId: plugin.pluginId,
      id: screen.id,
      export: screen.export,
      extensionPoints: ownedPoints(plugin.pluginId, screen.extensionPoints),
      client: plugin.ui.client ?? '',
    }))
    .sort((a, b) => byString(a.id, b.id));

  const contributions: UiRegistryContribution[] = accepted
    .map(({ plugin, contribution }) => ({
      pluginId: plugin.pluginId,
      id: contribution.id,
      extensionPoint: contribution.extensionPoint,
      export: contribution.export,
      order: contribution.order,
      extensionPoints: ownedPoints(plugin.pluginId, contribution.extensionPoints),
      client: plugin.ui.client ?? '',
    }))
    .sort(
      (a, b) =>
        byString(a.extensionPoint, b.extensionPoint) ||
        a.order - b.order ||
        byString(a.pluginId, b.pluginId) ||
        byString(a.id, b.id),
    );

  // UI capabilities (ADR 0083): exactly one provider each. Start-up blocks rival providers like
  // those of a `single` capability; should two still meet here, neither is drawn.
  const providers = new Map<string, InputWithProvided[]>();
  for (const plugin of withClient) {
    for (const provided of plugin.ui.provides) {
      providers.set(provided.capability, [
        ...(providers.get(provided.capability) ?? []),
        { plugin, provided },
      ]);
    }
  }
  const capabilities: UiRegistryCapability[] = [];
  for (const [capability, entries] of providers) {
    const [only] = entries;
    if (entries.length === 1 && only) {
      capabilities.push({
        pluginId: only.plugin.pluginId,
        capability,
        export: only.provided.export,
        client: only.plugin.ui.client ?? '',
      });
      continue;
    }
    const ids = entries.map((entry) => entry.plugin.pluginId);
    for (const pluginId of ids) {
      problems.push({
        code: 'ambiguous-provider',
        pluginId,
        message: `UI capability "${capability}" has several providers (${ids.join(', ')}); none of them is drawn`,
        details: { capability, plugins: ids },
      });
    }
  }
  capabilities.sort((a, b) => byString(a.capability, b.capability));

  return {
    registry: {
      screens,
      contributions,
      capabilities,
      events: {
        subscribe: sortedUnion(plugins.map((p) => p.ui.events.subscribe)),
        publish: sortedUnion(plugins.map((p) => p.ui.events.publish)),
      },
      state: sortedUnion(plugins.map((p) => p.ui.state)),
      calls: sortedUnion(plugins.map((p) => p.ui.calls)),
      plugins: plugins.map((p) => ({
        pluginId: p.pluginId,
        events: {
          subscribe: sortedUnion([p.ui.events.subscribe]),
          publish: sortedUnion([p.ui.events.publish]),
        },
        state: sortedUnion([p.ui.state]),
        calls: sortedUnion([p.ui.calls]),
        uses: sortedUnion([p.ui.uses]),
      })),
    },
    problems,
  };
}
