# AGENTS.md — Licensing Policy

This document defines the mandatory licensing rules for all contributors, maintainers, automated coding agents, and AI agents working on the ridrs project.

The goal is to build a genuinely open-source, community-driven cycling platform while ensuring that the core platform and its official extensions remain open and reusable.

These rules apply to all new files, modules, packages, plugins, documentation, examples, and third-party dependencies.

## 1. Project licensing strategy

Use the following licenses according to the type and purpose of the contribution.

| Project component | License | SPDX identifier |
|---|---|---|
| Core platform | GNU AGPL v3 or later | `AGPL-3.0-or-later` |
| Official plugins | GNU AGPL v3 or later | `AGPL-3.0-or-later` |
| Core application modules | GNU AGPL v3 or later | `AGPL-3.0-or-later` |
| Backend and server components | GNU AGPL v3 or later | `AGPL-3.0-or-later` |
| Independently usable SDK packages | Apache License 2.0 | `Apache-2.0` |
| Public developer APIs and SDK tooling | Apache License 2.0 | `Apache-2.0` |
| Documentation | Creative Commons Attribution-ShareAlike 4.0 | `CC-BY-SA-4.0` |
| Configuration and build scripts | Same license as the component they belong to | — |
| Third-party content (route catalogs, track-derived data, pictures) | Its original license; non-commercial licenses allowed, see section 6a | e.g. `CC-BY-NC-SA-4.0` |
| Third-party dependencies | Their original license | — |

Do not introduce alternative licenses without explicit approval from the project maintainers.

## 2. Core platform — AGPL-3.0-or-later

All first-party code belonging to the core ridrs platform MUST use `AGPL-3.0-or-later`.

This includes, but is not limited to:

- Application entry points and lifecycle management.
- Module discovery and registration.
- Plugin loading and management infrastructure.
- Event bus and messaging infrastructure.
- Metric collection, aggregation, interpolation and prediction.
- Simulation and physics engines.
- Training and workout engines.
- Device integrations maintained as part of the core.
- User interfaces and HUD infrastructure.
- Indoor and outdoor cycling environments.
- Multiplayer and community infrastructure.
- Backend services and APIs.
- Official platform integrations.

The license must remain `AGPL-3.0-or-later` for all modifications and redistributions of covered works.

The AGPL network-use provision is particularly important: users interacting remotely with a modified version of the platform must be offered access to the corresponding source code under the terms of the license.

**ridrs is a non-commercial project.** Commercial use of ridrs distributions is excluded: they bundle third-party content under non-commercial licenses (section 6a), and the project offers no commercial hosting, paid services or commercial editions.

The code licenses cannot carry that exclusion themselves. The AGPL permits commercial use of the code, and its section 7 lets any recipient remove an added non-commercial restriction. Excluding commercial use of the code itself would need a different, non-open-source license and the consent of all copyright holders (section 12).

## 3. Official plugins — AGPL-3.0-or-later

All plugins developed and distributed as official ridrs project components MUST use `AGPL-3.0-or-later`.

Examples include:

- Official metric providers.
- Official HUD components.
- Official resistance models.
- Official trainer and sensor adapters.
- Official world and rendering modules.
- Official workout and training plan modules.
- Official game modes and virtual opponents.
- Official event and multiplayer modules.

Official plugins are considered part of the open ridrs ecosystem.

Do not change the license of an official plugin to a more permissive license without explicit maintainer approval.

### Third-party plugins

The project does not automatically impose the AGPL on every independently developed third-party plugin merely because it implements a ridrs plugin interface.

Third-party developers may choose their own license where legally permissible.

However:

- The plugin must comply with the license obligations of all code it incorporates.
- It must not include AGPL-covered code in a way that violates its licensing conditions.
- Whether an in-process plugin constitutes a separate work or part of a combined work depends on the actual architecture and applicable copyright law.
- Plugin authors must clearly declare their license.
- The platform must not claim that its SDK grants permission to bypass the license of the core platform.

When introducing a new plugin loading or integration mechanism, preserve clear architectural boundaries and document the intended licensing model.

## 4. SDK and independently reusable packages — Apache-2.0

Packages specifically designed to be independently reusable outside the ridrs platform SHOULD use `Apache-2.0`.

Examples include:

- Public SDK packages.
- Standalone developer tooling.
- Independent protocol definitions.
- Reusable utilities.
- Standalone data format libraries.
- Independent device communication libraries, where appropriate.

Apache-2.0 is selected to encourage adoption, integration, and contributions from external developers and organizations.

Only use Apache-2.0 where the package is genuinely independent and can be distributed under that license without relicensing AGPL-covered code.

Do not move existing AGPL-covered implementation code into an Apache-2.0 package simply to make it permissively licensed.

Apache-2.0 is compatible with GPLv3-family licensing for incorporation into GPLv3-covered works, subject to the applicable license requirements.

## 5. Documentation — CC-BY-SA-4.0

Project documentation MUST use `CC-BY-SA-4.0`.

This includes:

- Architecture documentation.
- Developer guides.
- User manuals.
- Tutorials.
- Concept descriptions.
- Technical specifications.
- Explanatory diagrams and illustrations created for the project.

Documentation must permit commercial reuse and modification while requiring attribution and sharing adaptations under the same license.

Code examples that are intended to be copied into software projects must clearly identify their applicable software license. Do not assume that documentation licensing automatically determines the license of embedded source code.

## 6. Third-party dependencies

Before introducing any third-party dependency, agents MUST:

1. Identify its exact license.
2. Verify that the license permits the intended use and distribution.
3. Check compatibility with the license of the consuming component.
4. Preserve required copyright and attribution notices.
5. Include required license texts and NOTICE files where applicable.
6. Document dependencies and their licenses.

Preferred licenses include:

- MIT
- ISC
- BSD-2-Clause
- BSD-3-Clause
- Apache-2.0
- AGPL-3.0
- GPL-3.0-or-later
- LGPL-3.0-or-later, where its conditions are satisfied

Do not automatically assume that a license is compatible simply because it is commonly used in open-source projects.

In particular:

- Do not introduce GPL-2.0-only dependencies into AGPL-3.0-or-later components without an appropriate compatibility analysis.
- Do not introduce proprietary dependencies into the core without explicit approval.
- Do not introduce dependencies with unclear, missing, or custom licenses without explicit approval.
- Do not copy source code from projects with incompatible licenses.
- Do not remove or alter third-party copyright notices.

When in doubt, stop and request maintainer approval.

## 6a. Third-party content — non-commercial

Content that ridrs ships but did not create (route catalogs, notes, descriptions, pictures, profiles and paths derived from someone else's tracks) keeps its author's license. Non-commercial licenses such as `CC-BY-NC-SA-4.0` are allowed for content. They make every distribution that bundles the content non-commercial (section 2).

Rules:

- Content lives in its own folder (for example `plugins/<plugin>/catalog/`), never inside source files. The folder holds a `README.md` naming the author, the origin (URL) and the license, with that license's SPDX identifier.
- `NOTICE` lists every content folder with its author and license.
- The UI shows the credits (author, source, license) wherever the content is shown, as the license requires.
- ShareAlike content is shared under the same license, adaptations included (for example profiles derived from a CC BY-NC-SA track).
- ridrs never re-hosts or mirrors third-party media. Riders download videos from their origin to their own device.
- Content under licenses with database or share-alike terms that reach further, such as OpenStreetMap's ODbL, needs maintainer approval first.
- Content whose license is unclear is not shipped.

## 7. Copyright headers and SPDX identifiers

Every new source file MUST contain an appropriate SPDX license identifier.

For example, core TypeScript files:

```typescript
// SPDX-License-Identifier: AGPL-3.0-or-later
```

Apache-licensed SDK files:

```typescript
// SPDX-License-Identifier: Apache-2.0
```

Documentation files:

```markdown
<!-- SPDX-License-Identifier: CC-BY-SA-4.0 -->
```

Use the appropriate comment syntax for the file type.

Do not invent copyright holders or years.

Contributors retain copyright in their original contributions unless they explicitly agree otherwise.

## 8. Repository license files

The repository MUST contain:

```text
/
├── AGENTS.md
├── LICENSE
├── LICENSES/
│   ├── AGPL-3.0-or-later.txt
│   ├── Apache-2.0.txt
│   └── CC-BY-SA-4.0.txt
├── NOTICE
└── ...
```

`LICENSE` must clearly identify the default license of the repository's core software as `AGPL-3.0-or-later`.

`LICENSES/` contains the complete, unmodified license texts.

`NOTICE` contains applicable attribution and third-party notices.

Individual packages may have their own LICENSE files where their license differs from the repository default.

Use the REUSE specification and tooling where practical to validate licensing metadata.

## 9. Contributions

Contributions must be submitted under the existing license of the component being modified.

Contributors must have the legal right to submit their contributions under that license.

Use the Developer Certificate of Origin (DCO) with signed-off commits rather than introducing an automatic copyright assignment requirement.

Agents MUST NOT:

- Change the license of existing files without approval.
- Remove existing copyright or attribution notices.
- Re-license contributions from other authors.
- Copy code from external sources without verifying its license.
- Add dependencies with incompatible or unknown licensing conditions.

A change in project-wide licensing policy requires explicit maintainer approval and appropriate rights from all relevant copyright holders.

## 10. Trademark and branding

Software licenses do not grant rights to the ridrs project name, logos, visual identity, or other trademarks.

The following are separate from the software licensing policy:

- Project name and brand.
- Logos and visual identity.
- Domain names.
- Official project identity.
- Official partner or certification designations.

No contributor or third party may imply official affiliation, endorsement, or authorization to use project branding merely because they use or redistribute the software.

Trademark usage must be governed by a separate project trademark policy.

## 11. Instructions for AI coding agents

Before creating or modifying files:

1. Determine which project component the file belongs to.
2. Apply the correct license from this document.
3. Preserve existing licensing metadata.
4. Check third-party code and dependency licenses.
5. Add appropriate SPDX identifiers to new source files.
6. Do not introduce alternative licensing terms without maintainer approval.

When generating new plugins, distinguish between official first-party plugins and independently maintained third-party plugins.

When creating new SDK packages, verify that the code is independently reusable and does not contain AGPL-covered implementation code.

When uncertain about licensing, do not guess. Explain the issue and ask for maintainer approval before proceeding.

## 12. Licensing changes require explicit approval

This document is the authoritative licensing policy for the ridrs repository.

No AI agent, automated workflow, or individual contributor may independently change the licensing strategy.

Changes require explicit approval from the project maintainers.

---

## Summary

The licensing strategy is designed to achieve three objectives:

1. **Keep the platform open:** The core and official plugins remain under AGPL-3.0-or-later, including applicable network-use obligations.
2. **Encourage adoption:** Independently reusable SDKs and developer tools use Apache-2.0.
3. **Protect community knowledge:** Documentation uses CC-BY-SA-4.0.
4. **Respect content authors:** Third-party content keeps its license, non-commercial ones included (section 6a).

The result should be an open, non-commercial, community-driven cycling platform without unnecessarily restricting independent ecosystem development.