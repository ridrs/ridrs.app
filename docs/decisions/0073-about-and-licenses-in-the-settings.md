<!-- SPDX-License-Identifier: CC-BY-SA-4.0 -->

# ADR 0073: About and Licenses in the Settings

Status: **proposed** on 2026-11-08, on the maintainer's request (an "About & licenses" part so that license and attribution notices can be reached from the UI). Implemented the same day; awaiting acceptance.

## Context

ridrs bundles third-party code and content under MIT, ISC, Apache-2.0, BSD, MPL-2.0 and CC-BY-NC-SA-4.0, and is itself AGPL-3.0-or-later. No screen showed the licenses or the app's own notice. AGPL section 5(d) asks an interactive user interface to display Appropriate Legal Notices, and the notices of the bundled components ask for their license text to travel with the distribution.

## Decisions

- **The settings end with an About section:** the app's name and version, "Licensed under GNU AGPL v3 or later", a link to the source code (https://github.com/ridrs/ridrs.app, offered also for AGPL section 13) and a button "Licenses & credits".
- **Licenses & credits is a page inside the settings, not a dialog screen of `layout.json`.** A dialog screen gives way when another one is navigated to, so Back from it would close the dialog and land on the page beneath, not in the settings. A page inside the settings (state of the settings screen, handled by `useBack` like "Advanced") makes Back step out one level at a time: license text, list, settings, page. It also needs no layout entry, manifest screen or contract.
- **The page lists** the app itself ("ridrs itself", its AGPL text), the third-party content with its credit (author, origin, SPDX license, the credit paragraph of the folder's README and the address of the full legal code), and every component of NOTICE with name, version, SPDX license and purpose. Choosing a component opens its full license text. Texts are split into paragraphs that take the focus, so the arrows (and a remote) step through and scroll a long text. The purposes are the English words of NOTICE in both languages; the page's own texts are translated (ADR 0072).
- **The AGPL text is kept in `LICENSES/AGPL-3.0-or-later.txt`** (the unmodified text from gnu.org; the root `LICENSE` is only an overview of the licensing). No license changes: the file only makes the existing license's text available to the screen.
- **The data is generated, not copied:** `pnpm generate:licenses` (`scripts/generate-licenses.ts`, logic in `scripts/licenses.ts`) reads the tables and the MPL-2.0 paragraph of the root `NOTICE` and writes `plugins/ui-settings/client/licenses.generated.ts` (every distinct text once) and `about.generated.ts` (the version, kept small so that the settings do not load the large module; the licenses page loads the other with a dynamic `import()`). A text comes from, in this order: the repository's own files (`plugins/*/licenses/<package>…`, such as the OFL texts of the Kinetic look's fonts, ADR 0074; the icons' `LICENSE`; `crates/vendor/tauri-plugin-blec`), the package's license files in `node_modules`, the crate's in the Cargo registry, the text generated before (on a machine without a Rust toolchain). A package that ships no license file gets the holder-free Apache-2.0 or MPL-2.0 text another component provides, and for other licenses a pointer to spdx.org: `@bufbuild/protobuf` (BSD-3-Clause part) and `@fabianlars/tauri-plugin-oauth` (MIT part). The generator fails when a NOTICE row ends without any text.
- **The generated files are committed**, as the Rust toolchain and the whole `node_modules` are not on every machine that builds. A unit test (`tests/unit/licenses.test.ts`) reads NOTICE again and fails when a row is missing, differs in license, version or purpose, has no text, or when the file lists something NOTICE does not: after changing NOTICE, run `pnpm generate:licenses`. The generated files are excluded from Biome.
- **The version is the root `package.json`'s**, read at generation time, like the one the native app hands the host (`__RIDRS_VERSION__`); no contract or capability is added.
- **The native app may open the source link** in the system browser: `capabilities/default.json` allows `https://github.com/ridrs/ridrs.app*` for `opener:allow-open-url` beside the sign-in page.

## Consequences

- A new dependency in NOTICE shows up on the screen after `pnpm generate:licenses`; forgetting it fails `pnpm test`.
- The settings bundle grows by one small file; the license texts (about 400 KB) load only when the page opens.
- No new library (rule 2): the parser reads one table format with Node built-ins.
- Tests: `tests/features/ui/about-licenses.feature` (the About section, reaching the page by keyboard, every NOTICE entry, a license text, the credits, German) and `tests/unit/licenses.test.ts`.
