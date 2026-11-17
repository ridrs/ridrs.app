<!-- SPDX-License-Identifier: CC-BY-SA-4.0 -->

# ADR 0101: Matroska and WebM Videos Read by Their Cues, with mediabunny

## Context

A route's video is the file its control file names, with its own extension (`@ridrs/ride`, ADR 0066). The video world read every video with mp4box.js (ADR 0061), so only ISO BMFF files played: MP4, M4V and QuickTime. video2gpx can now put a video into its package as it is, without converting it to MP4, and much of what riders film or download comes as Matroska or WebM (YouTube's 4K and HDR streams are VP9 or AV1 in WebM). Such a route was imported and then failed when the ride started: "The video has no sample table (moov)".

A Matroska file has no sample table. Its blocks lie in clusters, and only its cues say where the keyframes are. Measured on a 9.1 GB WebM (AV1, 4K HDR, 51 min, 522 keyframes) read by range with mediabunny:

- the track, its decoder configuration and colour: 18 reads, 5.3 MB, 10 ms;
- the keyframe at or before a time, from the cues: 2 reads, 2 ms;
- 300 samples from that keyframe on: 8 reads, 17 MB;
- every keyframe, one after another: the whole file, 9.1 GB, 2.4 s from the local disk.

So an index of every sample, as ADR 0061 builds for an MP4, would read the whole file before the ride: seconds from disk, far longer over the app's media scheme. Parsing Matroska (EBML, lacing, cues, codec private data) is generic work (rule 2).

## Decision

- **The frame player asks a video source** (`VideoSource`, `plugins/ui-world-video/client/video-source.ts`) for the keyframe at or before a time and for the samples in decode order from a keyframe on, a batch at a time. It asks for a keyframe only when the time leaves what it fed: behind the start, or beyond the latest sample fed. Selection, buffering and restarts are those of ADR 0061.
- **An MP4, M4V or QuickTime file** keeps its index from mp4box.js: keyframes are found at once and a batch is one range request of contiguous samples, as before.
- **A Matroska or WebM file** (recognised by its EBML header) is read with **mediabunny** (`mediabunny` 1.65.0, MPL-2.0, pure TypeScript and ESM, no runtime dependencies): keyframes from its cues, samples cluster by cluster through its packet reader, over the same range reader. Its colour (`Colour` element or the codec's) is mapped to the H.273 code points of ADR 0091, so a PQ WebM is shown on the HDR canvas. 1.65.0 was 18 days old when chosen; the latest, 1.66.0, 4 days.
- A file in neither container is refused with a reason when the route loads.
- The app's media scheme names the type of `.mov`, `.m4v`, `.mkv` and `.webm` files too, letters compared without case.

mediabunny reads MP4 as well, but replacing mp4box.js would change the tested MP4 path for no gain; both stay behind the one video source.

## Consequences

- Routes whose video is `.mkv` or `.webm` play; a long one is never read in full before the ride (a scenario reads less than half of a 20 s test file to show a frame at 15 s).
- After a jump past what was fed, the picture waits for one keyframe lookup (two small reads) more than with an MP4.
- A Matroska file without cues can still be played, but every keyframe lookup then reads the clusters from the start: slow for a long video. video2gpx and ffmpeg write cues by default.
- mediabunny is MPL-2.0, which is not on LICENSING.md's preferred list: it is used unmodified, as a separate npm package, which MPL-2.0 §3.3 permits to combine with AGPL-3.0-or-later, like the MPL crates Tauri pulls in. It needs the maintainer's approval before this is merged.
- WebCodecs still decides what plays: a codec the platform cannot decode (ProRes, say) shows a message, as before.
