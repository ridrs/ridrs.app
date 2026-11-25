<!-- SPDX-License-Identifier: CC-BY-SA-4.0 -->

# ADR 0109: Refined Stretches beside a Route's Video

Status: proposed on 2026-11-25 (plan `video-zwischenframes.md`, phase 2); the stretches' codec amended by ADR 0110 the same day. Extends [ADR 0094](0094-video-routes-stored-as-ride-packages.md) and [ADR 0061](0061-video-frames-chosen-by-the-render-clock.md).

## Context

The video world shows the frame at the video time of the presented distance (ADR 0061). A rider slower than the camera therefore sees fewer different frames per second than the video has: a rider at 100 W on 6 % behind a car filmed at 40 km/h sees 5 of 30. Phase 1 of the plan (`planRefinement` in `@ridrs/ride`) finds the stretches of a route's video where a rider at 100 W would see fewer than 30. Phase 0 measured how to compute in-between frames there: Apple's frame rate conversion (`VTFrameProcessor`) at 30–130 frames per second at 1080p (`experiments/rife-onnx-spike/FINDINGS.md`, round 2).

The computed frames must reach the frame player without changing the package: a route's package is never changed to improve it, and a file in the route's folder wins over the package's entry (ADR 0094). A video re-encoded whole would double the route's size and take hours. The frame player configures one decoder for one file, and a stretch encoded on its own has its own codec configuration.

## Decision

- **Each refined stretch is a video of its own** below `refine/` in the route's folder, as H.264 ([ADR 0110](0110-refining-a-route-after-its-download.md): VideoToolbox encodes no AV1, and every platform's WebCodecs decodes H.264). Its time 0 is the stretch's `from` in the video's time. It holds the video's frames of the stretch and the in-between frames, `factor` frames per frame of the video. It begins with a keyframe.
- **`refine/refine.json` lists them:**

  ```json
  { "version": 1, "video": "FR_Col_de_Pennes.mp4",
    "segments": [ { "from": 512.5, "to": 640, "factor": 4, "file": "000512.500.mp4" } ] }
  ```

  - `video` is the control file's `video-file-path`.
  - `from` and `to` are in seconds of the video's time (the frame player's, from its first shown frame).
  - `file` is relative to `refine/`.
  - Stretches may touch but not overlap.
  - `parseRefinement` in `@ridrs/ride` reads the file.
  - Both the refinement and the stretches' files are entries of the route, so the offer names their URLs as for any file (ADR 0094). Incyclist ignores the folder.
- **A refinement is all or nothing.** It is left out whole, with the reason logged, when it does not parse, names another video, or names a file the route lacks. A stretch whose file cannot be opened or decoded is left out for the ride, and the video plays there.
- **The video world plays a stretch with a frame player of its own** (`RefinedFramePlayer`):
  - The stretch's samples are moved onto the video's time (`shiftedSource`), so the selection rule of ADR 0061 stays as it is, and frames carry the video's time.
  - Where a stretch covers the shown time and has its frame, the frame comes from the stretch. Everywhere else, and until the stretch has its frame, it comes from the video.
  - A stretch is opened and decoded 2 s before the rider reaches it.
  - Within a stretch, the video is decoded from the stretch's end 2 s before the rider gets there, unless another stretch begins there.
  - Stretches more than 2 s behind or ahead are closed.
- **The frame player starts again at the keyframe when the time goes back behind the frames it closed**, also within one keyframe's run. A stretch has one keyframe for its whole length, so without this a step back would show nothing until the time caught up.
- **HDR videos play without refined stretches** for now. The stretches are SDR, and a PQ path is not measured (plan Z9).
- **The canvas counts the different frames it drew** (`data-frames-shown`), so the frames per second a rider sees can be measured in the running app through the debug bridge.

## Consequences

- A route improves without its package changing, and loses nothing when `refine/` is deleted.
- A stretch costs one more decoder while it plays and while it is primed, at most two stretches at once.
- The computing of the stretches (phase 3) writes exactly this format. It may add fields that identify what a refinement was computed for (power, mass, track), which version 1 readers ignore.
- Not covered: the switch between two decoders in WebKit's WebCodecs at full speed. The scenarios run on the fixtures with a decoder that stands in for WebCodecs. The plan's phase 4 measures it in the running app.
