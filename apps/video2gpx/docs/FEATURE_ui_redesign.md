# UI redesign (release candidate)

The single screen of the beta (video, map, run, result and log at once) is replaced by a workflow of stages. The UI stays
German, vanilla TypeScript and Vite, with Leaflet as the only runtime library. Plan: `plan-ui.md` of the RC session;
decisions U1 to U8 are in [DECISIONS.md](DECISIONS.md) (rows E10 to E15).

## Screens

| Route | Screen | What it shows |
|---|---|---|
| `#/` | **Start** | One field for an address (URL) or a file path, "Datei wählen …", drag and drop on the whole window, recent projects (poster, status icon and word, date, "⋯" menu: Im Finder zeigen, Löschen; "Alle Projekte" expands in place). For a URL: the template select and the exact command (`<details>`), computed by the backend (`import_resolve`). |
| `#/werkzeuge` | **Werkzeuge** | Built-in pipeline, ffmpeg and ffprobe (required), yt-dlp (optional, only for own templates that call it). The `brew install …` line is built from what is missing; "Homebrew ist nicht installiert?" and own paths as disclosures. Opened automatically on boot when a required tool is missing; re-checked on window focus. The app never runs `brew`. |
| `#/p/<id>/einrichten` | **Einrichten** | Map (square, ≤ 80 vh) and a 380 px side panel: video block (or the running import with progress, cancel, details; or an empty state), 1 Suchrahmen (draw, visible view, delete, map coverage with "Kartendaten laden …"), 2 Hinweise (start / end frame, GPX/KML corridor), 3 Fahrzeug (segmented control), Weitere Optionen. Sticky footer: checklist (each item moves the focus to its fix) and "Abgleich starten" / "Neu berechnen". |
| `…/berechnung` | **Berechnung** | Overall bar and remaining time, vertical step list (several steps can run at once), the "Video laden" row when the run waits for its import, signals (icon shape + word + text), log. End states: cancelled ("Fortsetzen", "Zurück zu Einrichten"), failed with an action per exit code. The run goes on when the user leaves; the activity chip in the bar leads back. |
| `…/ergebnis` | **Ergebnis** | Verdict bar (facts, basis chips; `no_route` as an alert with "Route trotzdem anzeigen"), video and map in sync, readouts (speed, grade, elevation), one shared timeline: confidence strip and the elevation profile of the whole route on the same time axis, as one `role="slider"` (←/→ 5 s, Shift 30 s, Home/End, Space plays). Missing elevation: "Höhendaten fehlen (… MB)" with "Laden". |
| `…/export` | **Export** | Start time of the GPX timestamps (retime without recompute), GPX card, Incyclist card (the former dialog, same fields and four-step progress). A banner for uncertain routes. |
| `…/hoehe` | **Höhe** | (since 15 Nov, see FEATURE_elevation_stage.md) Sources and one download button, the profile chart over the whole route, key figures, conspicuous stretches. |
| `#/kartendaten` | **Kartendaten** | Local `.osm.pbf` files, Geofabrik offer and download, elevation tiles. The same component opens as a dialog from Einrichten. |
| `#/einstellungen` | **Einstellungen** | Import-Vorlagen (built-in read-only, own ones editable, live preview from `import_preview`, placeholder chips and insert buttons, the old command history as "Frühere Befehle"), Werkzeuge link, Darstellung (System / Hell / Dunkel), Ortssuche, Entwickler, Über. |

The project workspace is one grid: the map and the `<video>` are created once and only re-laid out per stage (`data-stage`).
Views build their DOM once and patch it (`update()`), so live events never take the focus away.

## Code

```
src/main.ts            boot: api, shell, views, event wiring, router
src/app/               router.ts (hash routes), shell.ts (bar, stage bar, activity chips, toasts, live region, shortcuts),
                       project.ts (open / create / close), theme.ts (data-theme, ?theme=, &freeze=)
src/features/          import.ts (classifySource, import state, templates), run.ts (checklist, start, cancel, resume, result),
                       gloss.ts (German texts for signals, verdicts, reasons)
src/views/             start, tools, setup, run, result, export, maps, settings, importDetails
src/ui/                tokens.css, base.css, components.css, layout.css, views.css, components.ts, icons.ts, dialog.ts
src/mapPanel.ts, frames.ts, hint.ts      map, frame editing (keyboard: arrows move, Shift+arrows resize, Delete), route hints
src/videoPanel.ts, ridePanel.ts          player (HTML5 or frame fallback), readouts and elevation data
src/incyclist.ts                         Incyclist export card
src/mock/              index.ts (mock Api), scenarios.ts, fixtures.ts, selfcheck.ts (classifySource and the run reducer)
```

## Design system

Colour tokens for light and dark (`src/ui/tokens.css`, contrast computed: text ≥ 4.5 : 1, control outlines ≥ 3 : 1), tints as
explicit tokens (the build target is Safari 15, so no `color-mix` for fills), map colours shared by Leaflet and the legends.
Controls are 32 px (28 px in dense rows), focus ring on everything focusable, about 20 inline SVG icons instead of emoji,
state never by colour alone. `prefers-reduced-motion` stops spinners and transitions.

## Mock scenarios and checks

`pnpm dev`, then `http://127.0.0.1:1450/?mock=<scenario>`; `&theme=light|dark`, `&freeze=1` (no timers, no animation),
`&at=<pct>`, `&dem=missing`, `&total=unknown`, `&video=webm`, `&hint=kml`; the hash picks the view
(`?mock=result#/p/demo-1/export`). Scenarios: `start`, `recent`, `notemplate`, `tools`, `tools-ytdlp`, `tools-nopipeline`,
`import`, `import-error`, `templates`, `dev`, `project`, `fresh`, `nosuggest`, `noframe`, `nomap`, `novideo`,
`videomissing`, `offline`, `mapdata`, `frames`, `running`, `running-start`, `running-parallel`, `running-stream`,
`cancelled`, `failed`, `result`, `uncertain`, `noroute`, `difficult`, `hints`, `result-frames`, `export`,
`export-uncertain`, `export-running`, `export-done`, `selfcheck` (aliases: `empty` → `start`, `noenv` → `tools`).

`pnpm ui-shots` (needs `pnpm dev` and Google Chrome; `playwright-core` and `axe-core` are devDependencies) opens 42
scenario shots in light and dark at 1360 × 900, six of them also at 900 × 640, and fails on axe WCAG 2.1 A/AA violations,
console errors, horizontal overflow, a missing `h1`, a failed self-check, a focus lost during live run events, or a
keyboard cancel/resume that does not keep the focus. Images go to `research/route-shape-matching/work/ui-shots/`
(git-ignored); a selection is in `docs/screenshots/`.

## Verified (browser mock, 13 Nov)

- All 96 shots clean (axe, console, overflow, h1, self-check), focus kept during a running job, cancel → focus on
  "Fortsetzen" → Enter resumes.
- Keyboard walk-through in the browser pane: Start (field focused) → path + Enter → Einrichten (tab order: search,
  map, frame, zoom, video, frame tools, hints, vehicle, options, start) → Enter on "Abgleich starten" → Berechnung →
  Ergebnis (focus on the verdict heading) → Exportieren → Export; Kartendaten dialog opens with Enter, Escape closes it
  and the focus returns to the opener; timeline keys seek the video.
- `pnpm build`: see the RC report for sizes; `dist/` contains no `mock`.

## Not verifiable in the mock

Real WKWebView behaviour (clipboard, drag and drop paths, dark tiles, video decoding and sync on a real result), real
progress of an import command, the backend's `import-progress` / `import-done` timing, `follow_import` with a real
pipeline (it queues the run until the import ends, DECISIONS E8), and the first-run redirect with a really missing
ffmpeg. These need one pass in the real app after the integrator's build.

## Open

- A component gallery view (`#/_ui`, plan WP-B) was not built; the scenarios cover the components.
- APP_SPEC has no "Workflow and screens" section yet; this file is the reference.
