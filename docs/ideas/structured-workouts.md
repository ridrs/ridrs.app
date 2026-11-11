<!-- SPDX-License-Identifier: CC-BY-SA-4.0 -->

# Proposal: Structured Workouts

**Status: proposal, 2026-11-11; every question answered by the maintainer (section 14). Next: phase 0 (rule 12, ADRs, contracts).** Where a later ADR differs, the ADR holds. It starts from the maintainer's request of 2026-11-10: a plugin that draws structured workouts as a capability, used by the workout cards and the calendar entries; a built-in catalogue of workouts; import of the common workout formats; a basic editor. It checks the request against the code as it is today, challenges parts of it and proposes phases. Each phase starts with failing Cucumber scenarios and gets its own ADR (AGENTS.md rules 1–3). Where the UI capability helps beyond workouts, and where it must not be used: [ui-capabilities.md](ui-capabilities.md).

## Summary

1. **One canonical workout format** in `@ridrs/workout` holds everything ZWO, FIT, ERG, MRC, TCX and intervals.icu can express. What the typed model has no field for is kept in per-format extensions, and the original file is kept as well. Importing translates; it never converts units.
2. **Drawing is a UI capability**, `ui.workout-chart`, provided by the plugin `ui-workout-chart`: Today, cards, calendar, details, editor, briefing and the HUD use it.
3. **A built-in catalogue** in `plugins/library-ridrs/resources/workouts/`, converted by a script from the maintainer's FIT and ZWO sources into the canonical format.
4. **Zones** for power and heart rate in the athlete profile, from intervals.icu or local, chosen like the FTP.
5. **Import** of six formats, **export** to all six, and **sync of workout content** to the intervals.icu calendar.
6. **An editor** (workbench, pointer and touch) and a **briefing** before every ride (ride path, controller) with a **simple workout player** and its own HUD widget.

## 1. Where the Code Stands

| Area | Finding | Consequence |
|---|---|---|
| Model, `packages/contracts/src/training.ts` | Targets are power in % FTP only. `low`/`high` means a ramp, while FIT and intervals.icu often mean a **range** with the same two values. No watts, heart rate, zones, free ride, distance or lap-button durations. | **Canonical model** (section 4) |
| `planner-intervals-icu`, `writeCalendar` | Its own comment says ridrs reads only part of a `workout_doc` (no zones, no difference between a range and a ramp). A **built-in** ridrs workout is created in intervals.icu by its name and length only. | The content is missing: **sync with content** (section 10) |
| Athlete profile, `athlete.ts` | `ftp`, `lthr`, `maxHeartRate`, `weight`; the source is chosen (ADR 0075); the FTP is written back to intervals.icu (`PUT sport-settings/Ride`). | Zones are added the same way (section 6) |
| Today tile, `ui-training-plan` | Flexbox bars at the mean of `low` and `high`, three colours, ramps drawn as rectangles, no axes, no interaction, `aria-hidden` | Replaced by the capability |
| Training area, `ui-area-training` | Placeholder list `WORKOUTS`, cards without structure, planning by drag and drop (a workbench screen, so fine under the new rule 12) | Catalogue and small charts |
| Starting a ride | Today starts a free ride at once; the route details start a route at once (`activity.start-requested { world }`). No workout can be chosen. | **Briefing** (section 11) |
| FIT, `@ridrs/fit` | Own encoder only; the Garmin SDK only in tests (ADR 0034) | Own **decoder**; the encoder learns the workout messages |
| XML | `fast-xml-parser` (ADR 0066) | ZWO and TCX |
| File dialog in the native app | No `tauri-plugin-dialog` | ADR |
| UI SDK, `ctx.slot()` | Mounts the contributions of an extension point, **without data** | New mechanism `ctx.render()` (section 5, accepted) |

## 2. Rule 12, New: the Ride Path and the Workbench

The maintainer's reason: everything a rider does once they sit on the trainer must work without a pointer; what never happens on the bicycle may need a pointer or touch.

**Wording for `AGENTS.md`:**

> 12. **Keyboard and controller on the ride path.** Everything a rider does once they sit on the trainer is fully usable with the arrow keys, Enter and Back alone (Escape, Backspace, the platform back button, or the controller buttons mapped to them): pairing devices, the briefing (choosing the route or world, the workout and the bicycle), starting, riding, pausing, continuing an interrupted ride, finishing, the debriefing and saving or uploading. Arrows move the focus, Enter activates, Back leaves the current view. On these screens the focused element is always clearly visible, and no element looks focused or selected unless it is.
> Screens off the ride path, such as creating and editing workouts, editing the training plan and the calendar, importing and exporting files, the athlete profile and its zones, the avatar and the settings, may require a pointer or touch. They keep the standard keyboard behaviour of their controls, but need not be usable by controller alone.

| Ride path (keyboard and controller **required**) | Workbench (pointer or touch **is enough**) |
|---|---|
| Pairing devices | Settings |
| Briefing: choosing route or world, workout, bicycle | Workout editor |
| Browsing and filtering the workout catalogue, workout details, stepping through a chart | Import, export |
| Today's "Next workout" tile → briefing | Editing the calendar (drag and drop) |
| Riding, the HUD with the live chart, pause, debriefing | Athlete profile, zones, avatar |

Screens that are fully usable by keyboard today stay so; nothing is taken back.

## 3. Points We Challenged

1. **Keeping information beats simplicity.** A canonical format that holds every source without loss is much larger than today's model. It separates *understanding* (typed fields ridrs shows and rides) from *keeping* (per-format extensions and the original file): nothing is lost, and ridrs need not ride every rare field at once.
2. **A range is not a ramp.** FIT `custom_target 200–220 W` means "stay between 200 and 220"; ZWO `Ramp 0.5→0.75` means "rise linearly". The canonical model has a **start range and an optional end range**: a steady target has one range, a ramp two.
3. **No conversion on import; conversion only where it cannot be avoided.**
   - *Showing:* a workout in watts is drawn on a watt axis; with an FTP the zone colours are computed as well. That is drawing only.
   - *Riding:* watts stay watts. % FTP and zones are resolved **when the ride starts**, with the profile of that moment, and enter the ride as input: a replay gives the same targets.
   - *Exporting:* only where the target format cannot express the unit (watts → ZWO, MRC; % → ERG, TCX), and always with a warning.
4. **A planned workout follows its library workout.** An entry remembers which library workout it came from. When that workout changes, the **future entries that were not ridden yet** follow without being asked; a discreet notice says so. Ridden entries stay as they are. This differs on purpose from intervals.icu, where an entry is a loose copy.
5. **Licence of the built-in workouts.** The maintainer's own workouts (made with AI, ridden on intervals.icu) ship as **CC-BY-SA-4.0**. Whether purely AI-generated content is protected by copyright is open; for ridrs this is harmless, since no one else's rights are touched, and the licence notice does no harm. Workouts of Zwift, TrainerRoad, Wahoo SYSTM or others never ship, converted or not (LICENSING.md section 6a).
6. **Briefing and player belong together.** Choosing a workout in the briefing only makes sense once it is ridden. Both come in phase 6; the player is its own agent with its own HUD widget (section 11a).
7. **Rule 3 (no speculation):** fields that no supported format delivers stay out of the model.

## 4. The Canonical Workout Format (`ridrs-workout`, model v2)

### 4.1 Three Layers for an Import Without Loss

| Layer | Content | Used for |
|---|---|---|
| **1. Typed model** | Everything ridrs understands: durations, targets, ramps and ranges, repeats, cues, metadata | Showing, riding, editing, export to other formats |
| **2. Extensions** `extensions.<format>` | Per step and per workout, everything of the source that layer 1 does not hold (unknown ZWO attributes, FIT fields, TCX extensions …) | Export to the **same** format restores them |
| **3. Original file** | The bytes of the imported file, referenced by their hash (app files) | Provenance; a later import again with a better parser |

After an edit in the editor, layers 1 and 2 hold; the original stays as provenance only.

### 4.2 Model (Sketch for the ADR)

```ts
/** A range: "stay between". low = high: exact. */
interface Range { low: number; high: number }

type TargetUnit =
  | 'percent-ftp' | 'watts' | 'power-zone'                   // power
  | 'percent-lthr' | 'percent-max-hr' | 'bpm' | 'hr-zone'   // heart rate
  | 'rpm'                                                     // cadence
  | 'meters-per-second' | 'percent-threshold-speed'          // speed (FIT, TCX)
  | 'rpe';                                                    // perceived exertion (intervals.icu)

interface Target {
  unit: TargetUnit;
  start: Range;                 // at the start of the step
  end?: Range;                  // present: a ramp, linear from start to end
  averaging?: '3s' | '10s' | '30s' | 'lap';   // FIT power_3s / _10s / _30s / _lap
}

type Effort =
  | { kind: 'target'; primary: Target; secondary?: Target[] }  // e.g. power and cadence
  | { kind: 'free'; flatRoad?: boolean; secondary?: Target[] } // ZWO FreeRide (FlatRoad)
  | { kind: 'max-effort' };                                     // ZWO MaxEffort, all out

type Duration =
  | { kind: 'time'; seconds: number }
  | { kind: 'distance'; meters: number }
  | { kind: 'energy'; kilocalories: number }                      // FIT calories
  | { kind: 'open' }                                               // lap button
  | { kind: 'until'; unit: TargetUnit; comparison: 'above' | 'below'; value: number }; // FIT hr_less_than …

type Intensity = 'warm-up' | 'active' | 'interval' | 'rest' | 'recovery' | 'cool-down' | 'other'; // the FIT enum

interface WorkoutInterval {
  kind: 'interval';
  id: string;                         // stable: editor, player, sync
  name?: string;                      // FIT wkt_step_name, intervals.icu section
  notes?: string;                     // FIT notes, TCX Notes
  intensity?: Intensity;
  duration: Duration;
  effort: Effort;
  cues?: { offsetSeconds: number; durationSeconds?: number; text: string }[]; // ZWO textevent, MRC COURSE TEXT
  extensions?: Record<SourceFormat, unknown>;
}

interface WorkoutRepeat {
  kind: 'repeat';
  id: string;
  until:
    | { kind: 'count'; reps: number }
    | { kind: 'time'; seconds: number } | { kind: 'distance'; meters: number }
    | { kind: 'energy'; kilocalories: number }
    | { kind: 'condition'; unit: TargetUnit; comparison: 'above' | 'below'; value: number }; // FIT repeat_until_*
  steps: WorkoutStep[];
  extensions?: Record<SourceFormat, unknown>;
}

interface Workout {
  format: 'ridrs-workout'; version: 1;
  id: string; name: string; description?: string;
  sport: 'ride' | 'virtual-ride';    // cycling only; the import refuses other sports
  subSport?: string;                 // FIT sub_sport, e.g. indoor_cycling
  author?: string; license?: string; // required for built-in workouts
  category?: string; subcategory?: string; tags?: string[];   // ZWO category and tags, intervals.icu folder
  focus?: 'recovery'|'endurance'|'tempo'|'sweet-spot'|'threshold'|'vo2max'|'anaerobic'|'sprint'|'test';
  referenceFtp?: number;             // ERG/MRC "FTP=" of the header: information, no conversion
  declared?: { durationSeconds?: number; trainingLoad?: number; intensityFactor?: number }; // as the source states them
  source: { kind: 'builtin' | 'user' | 'imported' | 'provider'; format?: SourceFormat;
            fileName?: string; originalHash?: string; importedAt?: string };
  steps: WorkoutStep[];
  extensions?: Record<SourceFormat, unknown>;
}
type SourceFormat = 'zwo' | 'fit' | 'erg' | 'mrc' | 'tcx' | 'intervals';
```

**Derived, not stored:** duration (estimated and marked for distance, open and `until` durations), training load (TSS), intensity factor, estimated normalised power, kJ, time per zone, which steps ERG can ride.

### 4.3 Coverage: Every Feature of a Source Has a Place

| Source | Feature | In the model |
|---|---|---|
| ZWO | `SteadyState`, `SolidState` | target `percent-ftp`, exact range |
| ZWO | `Ramp`, `Warmup`, `Cooldown` | `start` and `end` (ramp) plus `intensity` |
| ZWO | `IntervalsT` (on, off, repeat) | `repeat` of two steps; the `IntervalsT` form is kept in `extensions.zwo` so that the export writes `IntervalsT` again |
| ZWO | `FreeRide` (`FlatRoad`), `MaxEffort` | `effort.free`, `max-effort` |
| ZWO | `Cadence`, `CadenceLow`/`High`, `CadenceResting` | `secondary` in rpm (resting: the recovery step of the `IntervalsT`) |
| ZWO | `textevent` | `cues` |
| ZWO | `author`, `category`, `subcategory`, `tags`, `sportType`, `durationType` | metadata, or `extensions.zwo` |
| FIT | `duration_type`: time, distance, calories, open, hr and power less or greater than, `repeat_until_*` | `Duration` and `repeat.until` |
| FIT | `target_type`: power (0–1000 = % FTP, above 1000 = W + 1000), power zone, heart rate (% max, bpm), heart rate zone, cadence, speed, open | `Target.unit` |
| FIT | `secondary_target_*` | `secondary` |
| FIT | `intensity`, `wkt_step_name`, `notes`, `sub_sport` | fields of the same meaning |
| ERG, MRC | points (minute, value): the same value is steady, a slope is a ramp, the same minute twice is a jump | one step per section, rebuilt **exactly** |
| ERG, MRC | `FTP=`, `[COURSE TEXT]` | `referenceFtp`, `cues` |
| TCX | `Step_t`, `Repeat_t`; Time, Distance, LapButton, HeartRateAbove/Below; `PowerZone`, `CustomPowerZone` (W), heart rate, cadence, speed; `Notes`; extensions | accordingly; extensions in `extensions.tcx` |
| intervals.icu | `75%`, `200w`, `Z2`, `%LTHR`, `%HR`, `bpm`, `rpm`, `ramp`, `freeride`, `maxeffort`, sections, RPE, text prompts | accordingly; a zone target stays `power-zone` or `hr-zone` |

**Proof:** round trips per format (import, then export to the same format, gives the same content) and cross checks (FIT → canonical → FIT, ZWO → canonical → ZWO). Test files in `packages/workout/test-vectors/`, broken and unusual files included.

## 5. Architecture

```
packages/
  workout/            NEW     @ridrs/workout: canonical model, validation, metrics,
                              resolving zones, chart geometry, codecs (import and export)
  fit/                EXTEND  own decoder; the encoder writes workout (26) and workout_step (27)
  contracts/          EXTEND  model v2, zones in the athlete profile, defineUiCapability, services
  ui-sdk, ui-shell    EXTEND  ctx.render(): UI capabilities (accepted)

plugins/
  library-ridrs/      NEW     host: the provider "ridrs" of training.library (built-in and own)
     resources/workouts/            canonical JSON files (shipped)
     resources/workouts/sources/    the maintainer's FIT and ZWO sources (provenance, not shipped)
  ui-workout-chart/   NEW     provides ui.workout-chart
  ui-workout-details/ NEW     details of any workout (ride path)
  ui-workout-editor/  NEW     editor (workbench)
  ui-briefing/        NEW     briefing before a ride (ride path)
  ui-route-profile/   NEW     provides ui.route-profile (taken out of ui-area-ride)
  workout-player/     NEW     host: sets trainer.target-power by the workout (control)
  ui-widget-workout/  NEW     HUD widget of the player
  planner-intervals-icu EXTEND  reads and writes the whole workout_doc, zones, content in the calendar
  profile-local       EXTEND  local zones
  ui-area-me          EXTEND  shows and edits zones (workbench)
  ui-training-plan, ui-area-training  EXTEND  charts, import and export, placeholders removed
```

**UI capability `ui.workout-chart`** (mechanism accepted, see [ui-capabilities.md](ui-capabilities.md)):

```ts
defineUiCapability('ui.workout-chart', {
  input: z.object({
    workout: workoutSchema,
    athlete: z.object({ ftp, lthr, maxHeartRate, powerZones, heartRateZones }).partial().optional(),
    variant: z.enum(['micro', 'mini', 'full', 'edit', 'hud']),
    progressSeconds: z.number().optional(),   // HUD: read from the bus, only passed on
    selectedStep: z.string().optional(),
  }),
  output: { 'step-focused': z.object({ stepId: z.string() }) },
});
```

```ts
// a consumer
const chart = ctx.render(workoutChart, element, { workout, athlete, variant: 'mini' });
chart.on('step-focused', ({ stepId }) => select(stepId));
chart.update({ workout: draft, athlete, variant: 'edit' });   // no new mount
chart.release();                                              // also on unmount
```

The rule of thumb for the ADR: **ride data is never handed over as render input.** It is read from the bus and at most passed on. The geometry (`layoutWorkout(workout, { width, height, athlete })` → polygons, axes, zones) lives in the package: pure, headless and shared by the chart, the editor and the HUD.

### 5.1 The Chart

Taken from intervals.icu, TrainerRoad and Zwift:

| Element | Common practice | ridrs |
|---|---|---|
| Width | proportional to time | yes |
| Height | intensity | a fixed scale of 0–150 % FTP (higher values clipped and marked), so that workouts compare; a workout in watts without an FTP gets a watt axis |
| Ramps | trapezoids, not rectangles | yes |
| Colour | power zones | the zones of the profile (section 6), in the kinetic look (ADR 0074), light and dark, checked for colour blindness |
| FTP line | at 100 % | dashed |
| Free ride, heart rate, open | own look | hatched with a symbol; the height is the estimated intensity |
| Repeats | a bracket "4×" over the block | in `full` and `edit` |
| Axes | time below, % or W at the left | in `full` and `edit` |
| Tooltip | duration, target in % and W, cadence, text | on hover **and** on focus |
| Step list | in sync with the chart | selection in the list ↔ highlight in the chart |
| Numbers | duration, TSS, IF | yes |

**Variants:** `micro` (calendar entry, about 18 px, silhouette and zone colour only), `mini` (card, Today tile, about 56 px, with the FTP line, duration and TSS below), `full` (details: axes, brackets, tooltips, zone bar, step list), `edit` (editor: like `full`, with selection and handles), `hud` (player: progress mark).

**Accessibility and use:** the SVG has `role="img"` and a generated short description ("65 minutes, 3 intervals of 12 minutes at 90 %").
- `micro`, `mini`: not focusable themselves; the card or tile around them is the focus target (Enter opens the details).
- `full` (ride path): every step is focusable with the left and right arrows, and the tooltip follows the focus: a rider can step through a workout on the bicycle before starting it.
- `edit` (workbench): hover, click and drag with a pointer or touch; the keyboard only as standard (Tab, Delete, Cmd/Ctrl+Z).

The geometry is memoised per workout and size; that is enough for 50 or more calendar entries.

## 6. Zones

**Contract:** the athlete profile gets zones. Their source is the chosen profile source (ADR 0075), local or intervals.icu, as for the FTP.

```ts
powerZones?: { name?: string; upTo: number }[];       // upper bounds in % FTP; the last one is open
heartRateZones?: { name?: string; upTo: number }[];   // upper bounds in bpm
```

| Source | Read | Write |
|---|---|---|
| **local** (`profile-local`) | default: the seven Coggan power zones (55, 75, 90, 105, 120, 150 %), heart rate zones from the LTHR (Friel bounds) | on the "Me" page (workbench) |
| **intervals.icu** | `sportSettings` of Ride: `power_zones`, `power_zone_names`, `hr_zones`, `hr_zone_names` | like the FTP, `PUT sport-settings/Ride` |

**Use:**
- **Chart colours** by the index of the zone, with its name in the tooltip; the palette covers up to ten zones, since intervals.icu allows its own number of zones (e.g. with a sweet spot zone).
- **Zone targets** (`Z2` of intervals.icu, FIT `power_zone`) are resolved with the zones of the profile: live for showing, once at the start for riding.
- **Time per zone** in the details and the briefing.
- Without an FTP there are no power zones: the chart is drawn neutral, with a discreet hint.

## 7. Built-In Catalogue

```
plugins/library-ridrs/resources/workouts/
  README.md                    the format, the licence rules, how to add workouts
  sources/                     sources as delivered (FIT, ZWO); not shipped
    sweet-spot-3x12.zwo …
  sweet-spot-3x12.json …       canonical; shipped
```

**How the maintainer's workouts get in** (CC-BY-SA-4.0):
1. FIT or ZWO files go into `sources/`, for example as exported from intervals.icu.
2. `pnpm workouts:convert` writes the canonical JSON files, with **the same importers** as the rider's import. What a source lacks (licence, author, focus) comes from a small file next to it, `sources/<name>.meta.json`.
3. A test checks that every canonical file is valid and matches its source: a forgotten conversion fails the build.
4. At run time the catalogue loads canonical files **only**. It is bundled and read only; "Edit" makes a copy.

**Working material: five example workouts**, as ZWO sources so that they take the same way as the maintainer's. They replace the placeholders and are replaced or joined by the maintainer's workouts later:

| # | Name | Structure | Tests |
|---|---|---|---|
| 1 | Sweet Spot 3×12 | warm-up ramp 50→75 % · 3× (12′ at 90 %, 4′ at 55 %) · cool-down ramp 65→45 % | ramps, a repeat |
| 2 | VO2max 5×4 | warm-up · 5× (4′ at 115 % with 95–105 rpm, 4′ at 50 %) · cool-down | cadence as a second target |
| 3 | Over-Unders 3×(4×3′) | 3× [ 4× (2′ at 95 %, 1′ at 108 %), 5′ at 50 % ] | nested repeats |
| 4 | Endurance 75 with drills | 3× (15′ at 68 %, 2′ at 68 % with 105–115 rpm) · 5′ free ride · text cues | free ride, cues |
| 5 | Microbursts 30/30 | warm-up with 3× 10″ max effort · 2× [ 10× (30″ at 130 %, 30″ at 50 %), 5′ ] | short steps, max effort |

Watt and heart rate targets, the lap button and `until` durations cannot be written in ZWO; they are covered by the test vectors of the package, not by the catalogue.

## 8. Import (Workbench)

| Format | Parser | Note |
|---|---|---|
| ZWO | `fast-xml-parser` | unknown elements and attributes → `extensions.zwo` |
| FIT | own decoder in `@ridrs/fit` | `file_id.type = workout`; steps that jump back → `repeat` |
| ERG, MRC | own line parser | points → exact sections; `FTP=` → `referenceFtp` |
| TCX | `fast-xml-parser` | extensions → `extensions.tcx` |
| intervals.icu text | own grammar | copy and paste from a description |
| intervals.icu `workout_doc` | in `planner-intervals-icu` | library and calendar of intervals.icu, now **complete** |

**Flow:** "Import", or drop files or a ZIP → a preview with a small chart and a state per file (✓ / ⚠ note / ✗ error with its reason) → duplicates by the hash of the content ("skip" or "as a copy") → import. **No conversion question:** watts stay watts, % stays %. Notes only explain, e.g. "targets in watts, ridden in watts" or "3 steps by heart rate, no ERG". Running, swimming and strength workouts are refused with a note.

All parsers are **pure functions** (`Uint8Array | string → Result<Workout[], Diagnostics>`), tested headless.

## 9. Export (Its Own Phase)

To all six formats: ZWO, FIT, ERG, MRC, TCX and intervals.icu text. An export to the **format of origin** restores the extensions as well.

**Rule:** values are converted only where the target format would otherwise lack information it needs. What the target format can express stays as it is. Every conversion and every loss is shown as a warning **before** saving. If a conversion needs an FTP and there is none, that file is not exported, and the reason is shown.

| Target format | Cannot express | Behaviour |
|---|---|---|
| ZWO, MRC | absolute watts | converted to % with the current FTP, warning |
| ERG | % FTP, cadence, repeats | converted to watts with the FTP; cadence dropped; repeats unrolled; warning |
| ZWO, ERG, MRC | heart rate, distance, lap and `until` steps | a time step with the estimated duration, target free ride or the last power; warning |
| TCX | % FTP (only watts or a zone number) | converted to watts with the FTP, warning |
| FIT, intervals.icu text | – | no loss, except the extensions of other formats |

## 10. Calendar Sync With intervals.icu, With Content

**Goal:** when intervals.icu is the chosen calendar source, every workout planned there is created **with its whole content**, ridrs' own and built-in workouts included. Today only the name and the length go.

- `training.calendar.plan` of a workout of another provider (e.g. `ridrs`) takes the content from that library. The planner writes it as `workout_doc` or as intervals.icu text in the description; which of the two is decided by an ADR after a test against the API, by which keeps more.
- This needs the **intervals.icu exporter** before the export phase: it moves to phase 2.
- Watts go as `200w`, zones as `Z2`, ramps as `ramp`, cadence as `rpm`.
- Workouts of the intervals.icu library keep going with their original document (`libraryDocs`): nothing is rewritten.
- **Edits follow:** an entry keeps the id of its library workout. When the workout is saved in the editor, its future entries change with it, **without a question**; a **discreet notice** in the editor says so, e.g. in its footer: "Planned on 3 days; they change with it." Ridden and past entries stay as they are. In intervals.icu the entry is updated by `PUT` with the new content.
- An entry that was edited **in intervals.icu** keeps what intervals.icu has on the next load and is no longer tied to the library: ridrs never silently overwrites a change made there.

## 11. Briefing – Ride Path

The counterpart of the debriefing. Every ride starts through the briefing. **It asks only for what the button that led to it has not fixed.**

| Way in | Fixed | Chosen in the briefing |
|---|---|---|
| Today "Start ride" | – | route or world (or a free ride), workout (or none), bicycle |
| Today "Next workout", a calendar entry, workout details "Ride" | workout | route or world, bicycle |
| Route details "Go", Today "Ride again" | route | workout, bicycle |

- **Preview:** the route profile (`ui.route-profile`) and the workout chart (`ui.workout-chart`) one above the other, on the same time axis once both are chosen.
- **Summary:** duration, distance, TSS, time per zone.
- **Ready:** trainer and heart rate paired? If not, "Pair" right there (ride path). Is the route downloaded?
- **Remembers** the last choice (app state `ride.briefing`): Enter, Enter starts the usual ride.
- **Fixed points** are shown and can still be changed with "Change".
- **Start:** `activity.start-requested { world, workout }`. The workout enters the ride **whole, with its targets resolved**, not as an id: a replay needs no catalogue.
- **Different lengths:** the briefing notes a large difference, e.g. "Workout 60 min, route about 35 min: the picture then stands still and the workout goes on."

| Case | Behaviour |
|---|---|
| The workout ends before the route | ERG ends; a free ride **on the gradient of the route** |
| The route ends before the workout | The picture stays on its last frame, the workout goes on to its end, then a free ride: today's behaviour at the end of a route, extended by the workout |
| Both have ended | A free ride, as today after the end of a route |

**A free ride:** the trainer rides in resistance mode, with the gears as usual. **While the route goes on, its gradient holds**, so that picture and resistance match. **Without a route, and after its end, the gradient is 0 %.**

## 11a. A Simple Workout Player With Its Own HUD Widget

The player starts **simple and robust**; refinement comes later.

**Plugin `workout-player`** (host, type `control`):
- Takes the workout from the activity state (`activity.start-requested { world, workout }`). Its targets were **resolved at the start**: % FTP and zones became watts with the FTP and the zones of the profile; watt targets stay watts.
- **Time:** ridden time by `ctx.clock` (rule 7). A pause holds the workout; continuing an interrupted ride goes on at the same step.
- **Target:** `trainer.target-power` as input, as `control-erg` does; ramps follow every second.
- **Steps without an ERG target** (free ride, max effort, heart rate target, a range without power): ERG off; resistance by the gradient of the route; without a route, or after its end, 0 %.
- **Durations:** time as given; distance by the virtual distance; open and `until` until "Next step" on the controller, `until` also once its condition is met.
- **Controls (ride path):** "Next step" skips. Pause and finish as today.
- **Precedence:** during a step with a power target only the player sets the target, and `control-erg` ignores its plus and minus buttons (a note in the HUD says so). Changing the intensity with plus and minus is a later refinement.
- **Bus and replay:** the player publishes `workout.step-changed { stepId, index, startedAt }` as a derived event. A replay gives the same targets at the same times. A skip is rider input and is recorded (rule 13).
- **End:** ERG off, then a free ride (section 11).

**HUD widget `ui-widget-workout`** (a contribution to `hud/widget`):

```
┌─ VO2max 5×4 ────────────────────────── 3/5 ─┐
│  NOW    4:00 at 115 %  288 W   95–105 rpm   │
│         ███████████░░░░░░░  1:47 left       │
│  NEXT   4:00 at 50 %   125 W                │
│  ▁▂▃▅▅▂▅▅▂[▅]▂▅▅▂▅▅▂▁   ← ui.workout-chart  │
│                    ▲ progress      (hud)    │
└─────────────────────────────────────────────┘
```

- **Shows:** the workout's name, the set or repeat ("3/5"), the current step with its target in % and W, the cadence target, the time left in the step with a bar, the next step, and a small chart with a progress mark.
- **Reads** the workout and the step from the bus (`activity.state-changed`, `workout.step-changed`) and passes the progress on to `ui.workout-chart` (`variant: 'hud'`). Rendering reads, it never drives (rule 10).
- **Brief notes:** the cues of the workout (text events) for their duration, and 3-2-1 before a step changes.
- Without a workout the widget does not show.

**Not yet (later refinements):** intensity up and down, extending a step, smoothing the target or the trainer's ramp-up, a lap per step in the ride's FIT export, a score of how well the workout went in the debriefing.

## 12. Editor (Basic, Workbench)

Pointer and touch first; a live chart on top, the list of steps below.
- New; "Edit as a copy" (built-in workouts); edit (own workouts); metadata
- Steps: warm-up, steady, ramp, range, cool-down, free ride, max effort, interval block (n × on and off)
- Fields: duration, target (% FTP, watts, zone), optional cadence, name, notes
- Reorder by drag and drop, duplicate, delete, wrap a block in a repeat and unwrap it
- In the chart: a click selects; dragging an edge changes the duration or the power (snapping to 15 s and 1 %)
- Live: duration, TSS, IF, time per zone · undo and redo · validation (duration above 0, power 0–300 %, repeats 1–99, a name)
- Heart rate, distance and `until` steps of imported workouts stay as they are and can be **shown and deleted**; creating them comes later.
- The notice about planned entries that change with the workout (section 10).
- **Later:** a text mode with the intervals.icu syntax, templates and building blocks, multiple selection, creating heart rate steps.

## 13. Phases and Agents

Each phase: Cucumber first, one worktree per feature, `typecheck`, `lint` and `test` pass, a vertical use case.

```
Phase 0  Foundations (1 agent, in order)
         AGENTS.md rule 12 · ADRs: canonical workout format · UI capabilities ·
         zones in the profile · FIT decoder · tauri-plugin-dialog · catalogue (sources, licence, conversion)
         contracts and the JSON schema docs/formats/ridrs-workout-v1
            │
Phase 1  in parallel (4 agents)
   A  @ridrs/workout: model, validation, metrics, resolving zones, chart geometry
   B  text importers: ZWO, ERG, MRC, TCX, intervals.icu text (with test vectors)
   C  @ridrs/fit: decoder and FIT workout importer
   D  ui-sdk and ui-shell: ctx.render
            │
Phase 2  in parallel (4 agents)
   E  zones: contract, profile-local, intervals.icu read and write, the "Me" page
   F  library-ridrs, conversion script, five examples; the whole workout_doc read
   G  ui-workout-chart, used by Today, the cards and the calendar
   H  ui-workout-details, catalogue filters (controller), intervals.icu exporter, calendar sync with content
            │
Phase 3  import UX                                      1 agent    workbench
Phase 4  editor (basic)                                 1 agent    workbench
Phase 5  export: the other five formats, FIT workout encoder, export dialog   1–2 agents
Phase 6  ride path, in parallel (3 agents)
   I  workout-player (host), the workout in the start event and the activity state, the end of a route
   J  ui-widget-workout (HUD)
   K  ui-briefing and ui.route-profile (taken out of ui-area-ride)
```

Phases 3, 4 and 5 depend on phase 2 only and can run in parallel. In phase 6, I and J share only the contract (`workout.step-changed`, the workout in the activity state), which comes first in a small joint step.

**Vertical use cases:**
- *After phase 2:* a ZWO example in the catalogue is shown in the zone colours of intervals.icu, dragged into the calendar, and shows up in intervals.icu **with its content**.
- *After phase 4:* import a ZWO file → change an interval in the editor → plan it → see it on Today → step through its details with the arrow keys, Enter and Back only.
- *After phase 6:* "Next workout" → briefing → choose a route → ride. ERG follows the workout, the HUD widget shows it, and a replay gives the same targets.

## 14. Decisions of the Maintainer (2026-11-11)

| # | Question | Decision |
|---|---|---|
| F1, A3 | The workout player | A simple player with its own HUD widget in phase 6 (section 11a); refined later |
| F2 | How to draw for another plugin | A UI capability with typed input and output, `ctx.render` |
| F3 | Export | To all formats, in its own phase |
| F4, A1 | The built-in workouts | The maintainer's own workouts (made with AI, ridden on intervals.icu), delivered as FIT or ZWO, converted to the canonical format, CC-BY-SA-4.0. The five examples are working material. |
| F5 | Heart rate, distance and lap-button steps | Imported without loss, shown, marked |
| F6 | Planning ridrs workouts in intervals.icu | With their content (section 10) |
| F7 | Zones | Now, from intervals.icu or local, like the FTP |
| F8 | Innovative features | Later (section 15) |
| F10 | Rule 12, borderline cases | Pairing devices: ride path. Settings: workbench. |
| F11 | Starting a ride with a workout | A new briefing step (section 11) |
| A2 | Export to formats that lack a unit | Convert only where needed information would be missing, with a warning |
| A4 | Workouts of other sports | Refused |
| A5 | Changing what the way in fixed, in the briefing | Allowed |
| A6 | A planned library workout is edited | Future entries change with it; a discreet notice, no confirmation |
| A7 | Zones changed in ridrs | Written back to intervals.icu when it is the profile source |
| A8, B1 | Workout and route of different lengths; what a free ride is | Section 11: a free ride follows the route's gradient while the route goes on, 0 % without a route and after its end |
| – | Import | No conversion; workouts in watts are ridden in watts |
| – | Canonical format | One internal format that every source maps to without loss; model v2 extended as needed |

## 15. Later

Innovative features, once the rest stands:
- **Time-Fit:** shortens or lengthens a workout to the time a rider has, keeping the core intervals and cutting warm-up, cool-down and rests first, with how much of the training stimulus remains.
- **Route fusion:** routes whose climbs fit the structure of a workout, or a workout made from a route; the briefing is already the stage for it.
- **W′ balance preview:** while looking at or editing a workout, a W′ balance line warns where an interval is likely too hard and suggests a change.
- **Ghost of one's former self:** riding the same workout against one's own recorded ride, with a score per interval; built on recording and replay.
- **Ride to workout:** finding the structure in a ridden ride and turning it into a workout for the editor.
- Bonus, **cadence beat:** music chosen or paced by the cadence target.

Also: a text mode in the editor, templates, planned against done in the debriefing (`ui.ride-chart`), sharing by file or link, importing Wahoo `.plan` and Golden Cheetah `.json`.
