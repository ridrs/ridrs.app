<!-- SPDX-License-Identifier: CC-BY-SA-4.0 -->

# ADR 0110: Refining a Route after Its Download

Status: proposed on 2026-11-25 (plan `video-zwischenframes.md`, phase 3). Builds on [ADR 0109](0109-refined-stretches-beside-a-routes-video.md); amends it in one point (the stretches' codec).

## Context

ADR 0109 says how a route's refined stretches lie beside its video and how the video world plays them. Something must compute them:

- `planRefinement` (`@ridrs/ride`) finds the stretches from the route's track.
- Apple's frame rate conversion (`VTFrameProcessor`, macOS 15.4+) computes the in-between frames at 30–130 per second at 1080p (`experiments/rife-onnx-spike`, round 2).
- The work takes minutes per route. It runs after the download, in the background, and must leave the ride alone.

The `objc2-video-toolbox`, `objc2-av-foundation` and `objc2-core-video` crates (0.3.2) bind every API the work needs. The maintainer chose a separate program in Swift all the same (2026-11-25), for three reasons:

- `bin/vtfrc` of phase 0 already works.
- AVFoundation is safe to use from Swift.
- A crash or a memory problem of the media frameworks then ends the program, not the app, and cancelling ends the program.

## Decision

- **`ridrs-refine`, a Swift program in the app's bundle** (`apps/native/src-tauri/helpers/`, built by `build.rs` with `swiftc` on macOS, shipped as an external binary of the bundle). It computes one stretch per call:
  - **Input:** the video's absolute path, `from`, `to`, `factor`, and the output path.
  - **Work:** `AVAssetReader` decodes the video from the first frame at or after `from` to `to`. `VTFrameProcessor` computes `factor − 1` frames between each pair. `AVAssetWriter` writes the video's frames and the in-between frames as H.264 to the output, its first frame a keyframe at time 0.
  - **Output:** progress lines and a last line with the stretch's actual `from` and `to` (the times of its first frame and of the frame after its last) on stdout, as JSON. It exits with 0, or with 1 and a reason on stderr.
- **The stretches are H.264**, not the route video's codec as ADR 0109 said. VideoToolbox encodes H.264 and HEVC but not AV1, the codec of the Van Gestel videos, and every platform's WebCodecs decodes H.264.
- **The capability `video.interpolate`** (single, `@ridrs/contracts`) computes one stretch from media paths, with progress and an `AbortSignal`, and answers the actual times.
  - `video-interpolate-tauri` provides it: the command `video_interpolate` resolves the media paths, starts `ridrs-refine` without a shell, passes its lines to a channel and ends its process group on `video_interpolate_cancel`.
  - The Node host has no provider. The scenarios use a test provider.
- **The plugin `video-refine` does the work**, app state and services only (rule 13):
  - It watches `route.offer`, and refines each ready video route whose folder `videos/<offer id>` has a control file, a track and its video as a file of its own. A video stored in `route.ride` is skipped with the reason.
  - It plans with `planRefinement` at 100 W.
  - It computes the stretches one route and one stretch at a time. Each goes to `refine/<name>.part` and is moved to its name once whole.
  - After each stretch it writes `refine/refine.json` with the stretches done so far, so a cancelled or interrupted refinement keeps them and goes on from there.
  - A refinement whose stretches equal the plan's is done; otherwise the stretches that differ are computed again and those no longer planned are removed.
  - Its state `video.refinement`, by offer id, says `waiting`, `refining` with its progress, `done`, `skipped` or `failed` with the reason.
  - `video.refine` starts or cancels a route's refinement.
  - It waits while a ride runs or is paused (`activity.state-changed`) and goes on after it.
- **`route.refresh`** (keyed by `route.offer`): the source of a route reads its files on the device anew, through its downloader (`RouteDownloads.refresh`, optional), and offers them. `video-refine` asks for it after each stretch, so the next ride's video world finds them.
- The track the job plans with is the video world's: the GPX track with its times (`parseTimedTrack`, `@ridrs/ride`), made plausible (`plausibleTrack`, moved from `ui-world-video` to `@ridrs/ride`).

## Consequences

- A route downloaded on a Mac with macOS 15.4 or later is refined without the rider doing anything. Elsewhere the routes play as before, and the state says why.
- The app bundle grows by the program, about 1 MB.
- `RouteDownloads.refresh` is optional: a downloader without it (one outside the repository) offers new files from the next start on.
- Not covered: the athlete's weight and another power than 100 W (plan Z1), and HDR videos (plan Z9).
