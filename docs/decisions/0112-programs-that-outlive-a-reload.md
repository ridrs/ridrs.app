<!-- SPDX-License-Identifier: CC-BY-SA-4.0 -->

# ADR 0112: Programs That Outlive a Reload

Status: proposed on 2026-11-26, on the maintainer's request that the page reconnect to a program still running after a reload. Amends `process.run` of [ADR 0106](0106-plugins-the-rider-switches-installs-and-removes.md).

## Context

On 2026-11-26 the download of a 4K video of ridrs Scenic failed with `No such file or directory: …mp4.part-Frag670`:

- The downloader started yt-dlp at 10:31. At 10:39 the page of the Mac app reloaded. The program runs in the native app (`process_run`) and went on, but the plugin that waited for it was gone, and its new instance offered the route as fetchable again.
- The download was started again: a second yt-dlp wrote the same file. The first merged fragment 670 into the part and deleted it while the second still wanted it.

A reload drops every promise and channel of the page; the native app knows nothing about who waits for a program. Two ways out:

- **End the programs of a page when it reloads.** yt-dlp goes on from its part at the next start. Simple, but a download of an hour stops at every reload and the rider has to start it again.
- **Keep the program and let the new page find it.** Only the caller knows which runs must not exist twice (one writer per file) and how to find its run again after a reload: the arguments do not say it (another quality of the same video writes the same file).

## Decision

- **A run may have a key.** `ProcessRequest.key` is a name the caller chooses, unique for the work, by convention prefixed with its plugin id (`download-youtube:<route id>`). A run without a key behaves as before.
- **One program per key.** `run` with a key under which a program runs starts nothing: it attaches to that program, whatever its program and arguments.
- **`attach(key, onLine, signal)`** joins the program that runs under `key` and resolves with its exit code, or with `undefined` at once where none runs. A plugin calls it when it starts (after a reload it is a new instance) to show the work as going on.
- **Who attaches** hears the lines the program writes from then on, not those before: a program whose progress matters writes it again and again (yt-dlp does).
- **Aborting** the `signal` of any caller of the key ends the program for all of them: after a reload there is one page, and the rider who cancels means the work.
- **The programs end with the app.** The Mac app ends them when it exits; on Node they are its children.
- `process-run-tauri` and `process-run-node` both do this, so the scenarios hold it.

## Consequences

- A download goes on across a reload and shows its progress again as soon as the plugin has started; it is started twice no more.
- The downloader of YouTube videos (outside the repository) passes its key and attaches in `setRoutes`; it needs a new version.
- Keys are global per app, like the grants: a plugin could attach to another's run. The prefix is a convention, not a check.
- `data.fetch` (`media_fetch`) has the same gap: a fetch goes on after a reload, and a second fetch of the same target races it. It is left for its own decision, when a use case meets it.
- A program that outlives the native app (a hard kill of `tauri dev` on a rebuild) is not found again: the app starts with no runs.
