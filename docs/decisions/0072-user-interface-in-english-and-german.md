<!-- SPDX-License-Identifier: CC-BY-SA-4.0 -->

# ADR 0072: The User Interface in English and German

Status: **proposed** on 2026-11-08, on the maintainer's request ("refactor all strings from user interfaces of ridrs_app into a language specific source, then translate all with app context in mind into German, offer German as second language in the settings and apply the chosen language setting to the running app"). Implemented the same day; awaiting acceptance.

## Context

Every text of the user interface was written into the components. The settings already offered English and Deutsch (ADR 0059), but as a placeholder that nothing read. Plugins share no code (AGENTS.md rule 5), so no plugin can look up another plugin's texts, and a language chosen in the settings plugin has to reach every UI plugin without an import.

## Decisions

- **One language file per plugin and language.** A UI plugin keeps its texts in `client/i18n/en.ts` (the shape of every language: `export type Messages = typeof en`) and `client/i18n/de.ts` (`export const de: Messages`), joined in `client/i18n/index.ts` as `Catalogs<Messages>`. A missing or extra German text fails the type check. The kit `@ridrs/ui-preview`, the metric labels of `@ridrs/ui-sdk` and the companion app have their own files alike.
- **Texts are values or functions.** A text with numbers or names in it is a function (`downloading: (percent) => …`), so each language orders its words itself. Numbers with a decimal take the language's decimal mark (`localizeNumber`: "46.2" in English, "46,2" in German); dates use `Intl.DateTimeFormat` with the language's locale.
- **No library.** A lookup of a typed object by language is no generic utility worth a dependency (rule 2): the types check the catalogs, `Intl` (a built-in) formats dates. A message format library (ICU, i18next) would add a runtime and untyped keys for no case the app has today. Plurals are written out where they occur.
- **The language is app state** (ADR 0068): the topic `app.language` (key `app`, `en` or `de`) and the service `app.set-language` (`@ridrs/contracts`, `language.ts`). The host side of `ui-settings` owns both: it reads its user settings document `language` at start, sets the topic before any UI renders, and keeps and sets every change. Without `ui-settings`, the topic stays empty and the UI speaks English.
- **Every UI plugin declares `app.language` in `ui.state`** and reads it through `watchLanguage` (`@ridrs/ui-sdk`) or the React hooks `useLanguage` and `useMessages` (`@ridrs/ui-sdk/react`). A change re-renders every component that shows text, at once. A screen mounted later starts in the language spoken last, so it does not flash English before its snapshot arrives.
- **React bindings beside the SDK.** `@ridrs/ui-sdk` stays framework-neutral; its subpath `@ridrs/ui-sdk/react` (`src/react.ts`, React as a peer dependency) holds the two hooks, so the HUD widgets, which may import only the contracts, the SDK and React, use them too. The dependency rule `react-only-in-ui-code` names this one file as its exception.
- **The settings show each language by its own name** (English, Deutsch), so that anyone finds theirs. Reset to defaults sets English again.
- **The native app sets `<html lang>`** from `app.language` (composition root), for screen readers.
- **The companion app has no settings:** it follows the phone's language (German, else English).

## What stays as it is

- **Data, not wording:** names of routes, workouts, events and the demo course; route catalog data (titles, tour names); the bicycle's default name; ids kept in settings documents (weekday ids, entry kinds). Known tag values are translated where they are shown (countries and levels of a route).
- **Reasons from host plugins** (a refused download, a failed connection) are shown as the host says them, in English. Translating them needs codes in the contracts first.
- **Developer surfaces:** log and error messages, the companion's dummy device panel (developer build only), the raw protocol values in the trainer debug HUD.

## Consequences

- A new text goes into both language files; the type check enforces it.
- Tests stay in English, the default. Steps that find an element by a text that is now translated find it in every language (the main menu by its name in each catalog).
- Tests: `tests/features/ui/language.feature` (English by default, German at once everywhere, kept after a restart, back to English); Vitest: the Ride area's texts in both languages (`routes.test.ts`).
