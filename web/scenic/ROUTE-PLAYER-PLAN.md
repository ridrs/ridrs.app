<!-- SPDX-License-Identifier: CC-BY-SA-4.0 -->

# Route player plan (website, public)

Goal: a published GPX route (table `track`) opens in the same left dialog as a video. The dialog shows the whole elevation profile and plays the route from start to end. Where an editor assigned a video (table `track_video`, admin route editor), that video plays in sync with a pointer on the route; where none is assigned, the video slot is a black box and the pointer moves on by itself. Dragging the pointer on the map (and clicking or dragging on the profile) seeks, as it does for videos.

## What exists (branch `feat/scenic-route-editor`, deployed, not merged into `main`)

| Piece | Where | Reuse |
|---|---|---|
| `track.profile` `[[km, ele], …]`, km already on the stored line | migration 0011, `src/tracks.js` `profileOf` | as is |
| `track_video` (from_km, video_id, t_from_s, t_to_s; null video = gap) | migration 0011, `PUT /api/admin/tracks/:id/videos` | read publicly |
| km ↔ point on the route, nearest point, speed model | `site/lib/route-sync.js` (`kmAlong`, `pointAt`, `speedModel`, `trackAt`), `site/lib/track-cover.js` (`projectNear`, `timeAt`, `segmentsOf`, `segmentAt`, `climb`) | as is |
| Playback prototype: player follows the video along the route, changes video at each assignment | `site/admin/route-editor.js` `syncPlayer`, `follow` | move the logic into a shared pure module |
| Video dialog: slot, readout, profile with cursor and hover dot, draggable pointer, hash `#v=…&t=…` | `site/app.js` `openVideo`, `mountProfile`; `site/player.js` `mountPlayer` | generalise |
| Public route lines and legend; click on a line opens only a popup | `site/app.js` `addLayers`, `bindLayerEvents`, `loadTracks` | click opens the route dialog |

## Concept: one route clock

The route is cut into segments by `segmentsOf(track_video, km)`. Each segment gets a duration and a two-way mapping km ↔ seconds:

- **Video segment** (visible, embeddable, synced video with `t_from_s`/`t_to_s`): the sync track's points between `t_from_s` and `t_to_s`, projected onto the route line (`projectNear`, forward window, km made monotone and clamped to the segment). Mapping km → video second and back by interpolation. If the projection fails (track more than 200 m off for most points) the mapping falls back to linear between (from_km, t_from_s) and (to_km, t_to_s). Duration = t_to_s − t_from_s.
- **Gap segment** (no video, or the video is hidden, unpublished, not embeddable or not synced): time from `speedModel(line, cum, profile)` of the whole route (15–90 km/h from curves and climbs), so the pointer moves at a plausible driving speed. Times a gap speed factor (see open questions).

Summed up this gives a route timeline in seconds: total duration, position from km, km from position. Video segments are driven by the YouTube player (its time is the truth, buffering and pauses stop the pointer); gap segments by a `requestAnimationFrame` clock.

## Behaviour

**Opening.** Click on a route line on the map, or on its legend entry → `openRoute(id)`, hash `#r=<id>` (with `&k=<km>` once seeked; `t` stays the video's parameter). The dialog shows: eyebrow "Route", name, description; the slot; the readout; the profile; facts (length, ↑/↓ from `climb(profile)`, min–max height, share with video); a list "Videos on this route" (km from–to, title, channel, level), each entry seeks there, with a link to the video's own dialog. The map fits the route and draws it highlighted, with the video-covered parts marked.

**Profile.** Same chart as for videos (`mountProfile`), plus a band below it: covered stretches in colour, gaps in grey. Hover shows km and height and the dot on the map (as now); click or drag seeks. A cursor follows playback.

**Playback controls** (below the slot): play/pause for the whole route, ‹/› 100 m and «/» 1 km (keys ←/→, Shift+←/→, space), as in the admin editor. In video segments the YouTube player's own controls keep working: if the user scrubs inside YouTube, the route position follows the video; scrubbing past `t_to_s` moves on to the next segment, before `t_from_s` clamps to the segment start.

**Slot.**
- Video segment: plays in one of two YouTube players (see "Seamless handover" below).
- Gap: the players are paused and covered by a black box (no text inside; the readout below says "no video until km 23.4").
- Consent: the two-click consent stays. Before consent, a video segment shows the consent box. Pressing play before consent asks once: "Load videos" or "Play route without videos" (then every segment is black).

**Readout.** km x of y · height · gradient · either "Video *title* 12:34 (open)" or "no video until km …".

**Seeking.** One function `seekKm(km)`: find the segment; video segment → map km to the video second, seek (or load the video at that second); gap → set the clock. Called by the map pointer (dragend; during drag only the readout and profile cursor move, as in `mountPlayer`), the profile, the buttons, the list and the hash.

## Seamless handover between videos

Requirement: where one video segment follows directly on another (no gap in between), the user must not notice that the player changes. `loadVideoById` on a single player is not good enough: it shows black and a spinner for 0.5–2 s while the new video buffers. So the slot holds **two YouTube players (A and B) stacked on top of each other** (double buffering), the same size, both in the DOM all the time. The visible one plays; the hidden one has the next video ready.

**Which boundaries.** Every boundary into a video segment:
- video → other video, or video → same video at another time (a jump within one video): handover A → B as below;
- gap → video: the video is pre-buffered too, so the picture comes at once when the black box ends;
- video → same video, continuous in time (`t_from_s` of the next = `t_to_s` of this one, ±1 s): no change at all, the player plays on.

**Pre-buffering.** As soon as the current segment has less than 30 s left (or at its start, if it is shorter), the hidden player gets the next video: `cueVideoById(next, t_from_s)`, then muted `playVideo()` and `pauseVideo()` as soon as it reports PLAYING. After that it has buffered from `t_from_s` and starts within about 100–300 ms. The same runs after every seek, for the segment after the new position. The time from `playVideo()` to PLAYING is measured here and kept as the player's start latency.

**Handover.** The route clock knows when the visible video reaches `t_to_s`. Start latency before that point, the hidden player gets `playVideo()`. As soon as it reports PLAYING and its time moves on, the visible layer changes: a crossfade of 250 ms (opacity) and of the sound (`setVolume` down on A, up on B), then A is paused and becomes the hidden player for the next boundary. A runs on for those few hundred ms; it is the same road, so the overlap does no harm. If B is not ready in time (pre-buffering failed, slow network), A keeps playing past the boundary until B plays, the route pointer stays at the boundary, and the handover happens then; only if B fails for good does the black box show.

**Layering.** The hidden player is not `display: none` or 0 px (YouTube then does not buffer, and picks a low quality); it lies under the visible one with `opacity: 0` and `pointer-events: none`. Only the visible player gets the user's clicks and YouTube controls.

**Phones (iOS).** Safari only lets a video start with sound after a user gesture on that element. So the first tap on play "unlocks" both players in the same gesture (B: muted `playVideo` + `pauseVideo`). If B still stays muted after a handover (`isMuted()`), the route keeps playing without sound and shows an unmute button; the fallback without this is `loadVideoById` on one player. To be tested on a real iPhone, not only in the simulator.

**What it cannot hide.** Two videos differ in camera, light, weather and speed. The cut is at the same place on the road; how exact depends on the sync (level 1/2 about 10–25 m, level 3 more). YouTube may show an ad before a monetised video in an embed; that cannot be switched off. Optional follow-up in the admin editor: per boundary an offset in seconds, set while looking at the last frame of A next to the first of B (column `track_video.t_from_s` already holds it; only the UI is missing).

**Ends.** At the end of the route: pause, pointer at the end. Leaving the dialog destroys player and clock. Opening a video from the route dialog shows "← Route" at the top of the video dialog (like the stack back button).

## Implementation steps

0. **Base.** Merge `feat/scenic-route-editor` into `main` (it is live but only on its branch), then a new worktree `feat/scenic-route-player` from `main`. The main checkout currently holds another session's uncommitted changes in `web/scenic`; do not mix.
1. **API** `GET /api/tracks/:id` (`src/tracks.js`, routed in `src/worker.js`): only published routes, else 404. Returns name, description, color, line, profile, km, distance_km, segments; assignments whose video is not `VISIBLE` or not embeddable or not synced become `video_id: null`, and neighbouring nulls are merged. Plus per video: title, channel, duration, loc_level, sync path (`/sync/<id>.json` or `/api/sync/<id>.json`). `cache-control: public, max-age=300`. Tests in `test/tracks.test.mjs`.
2. **Pure module** `site/lib/route-play.js`: `buildTimeline({line, cum, profile, segments, tracks, gapFactor})` → segments with duration and km ↔ t mappings; `locate(timeline, km)`, `kmAtClock`, `clockAtKm`; the "next segment" rule from `follow`. No DOM. Tests `test/route-play.test.mjs`: monotone mapping on a track with a detour and a stop, fallback to linear, gap durations from the speed model, hidden video → gap, merged gaps, boundaries.
3. **Player split** (`site/player.js`): a core `ytPlayer(host, {onTime, onState})` with API loading, polling with smooth time between polls, `play/pause/seek/cue(videoId, start)/load(videoId, start)/setVolume/mute/startLatency/destroy`, several instances per page; consent outside the core. `mountPlayer` stays the same on top of it (pointer on the video track, readout). Check the video dialog is unchanged.
4. **Handover** `site/route-deck.js`: the two stacked players, pre-buffering, the timed handover with crossfade, the fallback when B is late, the iOS unlock. Driven only by the route clock ("next video X at t, start at clock c"), no route logic inside. The timing rule (when to pre-buffer, when to start B, continuous same video = no change) is pure and goes into `route-play.js` with tests.
5. **Route dialog** `site/route.js` (keeps `app.js` from growing): `openRoute(id, km)`, route pointer marker (draggable, snapped with `projectNear`), the deck with the black overlay, controls, readout, video list. `app.js`: the dialog holds one current controller (`destroy()`) instead of the separate `player`/`profileCtl`/`current` for videos; `mountProfile` gets `bands` and `onSeek`; `fromHash` reads `r`/`k`; line click and legend open the route.
6. **Admin (optional, same PR or follow-up):** `route-editor.js` uses `route-play.js` and the deck instead of its own `follow`/`syncPlayer` logic, so both play the same way and editors hear and see the handovers as visitors will.
7. **Texts** for the dialog in all ten locales (`site/locales/*.js`; `test/i18n.test.mjs` checks keys and placeholders).
8. **Check:** `pnpm test`, then local `pnpm dev:site` with a published test route that has two synced videos back to back, then a gap, then a third video: open from line and legend; play through video → video (handover), video → gap, gap → video; drag the pointer into each kind of segment, also just before a boundary; click the profile; YouTube scrubbing; back/forward with `#r=`; phone width (bottom sheet); consent declined. **Handover measured, not judged by eye:** the deck logs per boundary the time from A's `t_to_s` to B's first PLAYING and how long no player was visible; target 0 ms without picture and under 300 ms overlap, on a normal and a throttled network (DevTools "Fast 4G"). iPhone Safari on a real device for sound after the handover. Deploy separately and only from a clean, committed checkout (see README).

## Open questions

1. **Speed in gaps.** Proposal: speed model in real time with a selector 1× / 4× / 16× that applies to gaps only. Alternative: gaps always fast (e.g. a fixed 10 s per km) or a "skip gaps" switch.
2. **Unsynced assigned videos.** Proposal: they count as gaps on the public page (black), because there is no reliable km ↔ time. Alternative: play them unsynced, pointer estimated linearly over the video's duration.
3. **Non-embeddable assigned videos.** Proposal: gap, but listed under "Videos on this route" with a YouTube link.
