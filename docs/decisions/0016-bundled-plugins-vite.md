<!-- SPDX-License-Identifier: CC-BY-SA-4.0 -->

# ADR 0016: Bundled Plugin Discovery with Vite `import.meta.glob`

Apps cannot read a plugin directory, so `apps/native` bundles its plugin set at build time with **Vite** 8.3.5 (MIT) and `import.meta.glob`: manifests as raw strings (eager), plugin entries and client modules as lazy chunks. Node-only plugins are excluded with negative glob patterns (`!…/transport-ble-noble/**`); without the exclusion the build succeeds but the plugin fails at runtime.

The core never calls `import.meta.glob` (it exists only under Vite/Vitest). Discovery is a port (`PluginSource` in `@ridrs/core`) with two adapters: `createBundledPluginSource(set)` takes the glob result as plain data and runs anywhere (Cucumber feeds it in-memory records), and `createFileSystemPluginSource(dir)` lives in the Node-only entry `@ridrs/core/node` (`tinyglobby`, `node:fs`). Manifests are validated by the same `parseManifestJson` either way, so the manifest stays authoritative; only how manifests are found differs. A bundle cannot contain a folder without a manifest, so `missing-manifest` has no bundled equivalent, and `client-entry-missing` means "not part of the bundle" there.
