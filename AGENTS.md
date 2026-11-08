<!-- SPDX-License-Identifier: CC-BY-SA-4.0 -->

# AGENTS.md

## Licensing

Follow the licensing policy defined in [`LICENSING.md`](LICENSING.md).
Do not introduce or change licenses without maintainer approval.

## Standing Engineering Rules (All Phases)

1. **Test first.** Every use case starts with Cucumber scenarios that fail first. Cucumber is strict; given scenarios are never weakened.
2. **Libraries over utilities.** Generic helpers come from well-maintained, pure-JS, ESM libraries or Node built-ins; own code is reserved for ridrs domain logic. Every library choice has an ADR in `docs/decisions/`.
3. **No speculative implementation.** No events, capabilities, metrics, plugins or manifest fields without a use case in the current phase.
4. **Headless first.** All domain logic runs and is tested without a GUI.
5. **Plugins only talk through contracts.** Events and capabilities; no imports between plugins; the core never knows concrete plugins. Enforced by `dependency-cruiser`.
6. **The manifest is authoritative.** Folder prefixes are naming conventions only.
7. **Determinism.** Simulation code reads time and schedules work only through `ctx.clock`; a turn has one logical time, and tasks run at their planned time, before inputs of the same time. External inputs and results of asynchronous work enter only through the input queue (`ctx.inputs`). Ids come from `ctx.ids`, never from randomness. The same inputs give the same execution and the same states, live and on replay ([time-and-scheduling.md](docs/architecture/time-and-scheduling.md)).
8. **Extend, don't fork.** Each phase builds on the previous one; no parallel implementations.
9. **Every phase ends with a vertical use case** that runs through the real architecture.
10. **Rendering reads, never drives.** Rendering never writes simulation state directly; frame rate never changes physics results except through input timing. A UI plugin may act as a sensor: it delivers world data as an external input through a driver, like a device.
11. **Layers.** Sensors → drivers → interpolation layer (`@ridrs/temporal`, `@ridrs/spatial`) → physics. Physics plugins read input data only through readers; they subscribe to lifecycle events (`activity.*`) only, never to data events.
12. **Keyboard and remote first.** Every user interface is fully usable with the arrow keys, Enter and Back (Escape, Backspace or the platform back button) alone: arrows move the focus, Enter activates, Back leaves the current view. The focused element is always clearly visible, and no element looks focused or selected unless it is.
13. **Simulation on the bus, app state beside it.** The event bus carries what a replay or a continued ride needs: rider input that changes the ride, device data, derived events. App state (accounts, catalogs, progress) is state by key (`ctx.state`), app commands are services (`ctx.services`, `ctx.call`); neither is recorded. A value both the app and a ride use enters the ride as an input. Simulation plugins never read state or call services.

## Feature Workflow: One Worktree per Feature

Features are developed in parallel, each in its own Git worktree. The main checkout stays on `main` and is never used for feature work.

1. **Start in a new worktree.** Before the first change to a new feature, create a branch and a worktree next to the repository, not inside it (tools such as `biome check .` and Vitest would otherwise scan it):
   ```bash
   git worktree add -b feat/<name> ../ridrs_app-worktrees/<name> main
   cd ../ridrs_app-worktrees/<name> && pnpm install
   ```
   Use `feat/`, `fix/` or `docs/` as the branch prefix. If you are already in a feature worktree, keep working there.
2. **Stay in it.** Read, edit, build, test and run apps (including `tauri dev`) only inside that worktree. Never change files of the main checkout or of another feature's worktree.
3. **Done means all checks pass.** A feature is complete only when it meets the Standing Engineering Rules and, in its worktree, `pnpm typecheck`, `pnpm lint` and `pnpm test` all pass, with no skipped or weakened scenarios.
4. **Then suggest, don't act.** When the feature is complete, report the check results and suggest committing and merging into `main`. Commit, merge or push only after the maintainer agrees. Before merging, rebase the branch onto the current `main` and run the checks again; merge with a fast-forward:
   ```bash
   git rebase main
   cd <main checkout> && git merge --ff-only feat/<name>
   ```
5. **Clean up after the merge.** Remove the worktree and the branch: `git worktree remove ../ridrs_app-worktrees/<name>` and `git branch -d feat/<name>`.

## Building and Installing the Apps

How to build the release companion and install and launch it on an Android phone over `adb`, including the local environment pitfalls (no `cargo` on the `PATH`, OpenJ9 JDK, signing): [README, "Release companion on an Android phone"](README.md#release-companion-on-an-android-phone).

The native app on the Mac runs only from the repository root with `pnpm --filter @ridrs/native tauri dev`, in a terminal or in the background: it shows up as `ridrs-native`, with the current code and hot reload. Never open a bundled `ridrs.app` (`apps/native/src-tauri/target/{debug,release}/bundle/macos/`, also found by Spotlight and `open -a ridrs`): it holds the code of its last `tauri build`. Changes to the UI and TypeScript reach a running `tauri dev` by themselves; Rust changes rebuild and restart it.
