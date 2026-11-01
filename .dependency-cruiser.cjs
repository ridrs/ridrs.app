// SPDX-License-Identifier: AGPL-3.0-or-later

/** @type {import('dependency-cruiser').IConfiguration} */
module.exports = {
  forbidden: [
    {
      name: 'contracts-no-internal-imports',
      comment: 'packages/contracts imports no other internal package, app, plugin, or test.',
      severity: 'error',
      from: {
        path: '^packages/contracts/',
      },
      to: {
        path: '^(packages/(?!contracts/)|apps/|plugins/|tests/)',
      },
    },
    {
      name: 'core-only-imports-contracts',
      comment:
        'packages/core may import contracts; it must never import plugins/, apps/, or tests/.',
      severity: 'error',
      from: {
        path: '^packages/core/',
      },
      to: {
        path: '^(plugins/|apps/|tests/)',
      },
    },
    {
      name: 'plugins-no-core-or-apps',
      comment:
        'A plugin may import packages/contracts (and shared fixture contracts), never packages/core or apps.',
      severity: 'error',
      from: {
        path: '^(plugins/|tests/fixtures/plugins/)',
      },
      to: {
        path: '^(packages/core/|apps/)',
      },
    },
    {
      name: 'plugins-no-cross-plugin-imports',
      comment: 'A plugin must never import another plugin folder.',
      severity: 'error',
      from: {
        path: '^plugins/([^/]+)/',
      },
      to: {
        path: '^plugins/',
        pathNot: '^plugins/$1/',
      },
    },
    {
      name: 'fixture-plugins-no-cross-plugin-imports',
      comment: 'A fixture plugin must never import another plugin folder.',
      severity: 'error',
      from: {
        path: '^tests/fixtures/plugins/([^/]+)/([^/]+)/',
      },
      to: {
        path: '^(plugins/|tests/fixtures/plugins/)',
        pathNot: '^tests/fixtures/plugins/$1/$2/',
      },
    },
    {
      name: 'apps-no-plugin-imports',
      comment: 'apps/* compose core + contracts; they never import plugin code directly.',
      severity: 'error',
      from: {
        path: '^apps/',
      },
      to: {
        path: '^(plugins/|tests/fixtures/plugins/)',
      },
    },
  ],
  options: {
    doNotFollow: {
      path: 'node_modules',
    },
    tsPreCompilationDeps: true,
    tsConfig: {
      fileName: 'tsconfig.json',
    },
    enhancedResolveOptions: {
      exportsFields: ['exports'],
      conditionNames: ['import', 'require', 'node', 'default', 'types'],
      mainFields: ['module', 'main', 'types', 'typings'],
    },
  },
};
