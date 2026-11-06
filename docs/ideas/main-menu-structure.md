<!-- SPDX-License-Identifier: CC-BY-SA-4.0 -->

# Ideas: Menu Structure of Indoor Cycling Platforms – Analysis and Recommendation

**Status: ideas only.** Since 2026-11-06 the areas and the global elements exist as a clickable preview with placeholders ([ADR 0059](../decisions/0059-app-areas-as-a-clickable-preview.md)); the rest is not decided or implemented. This page is the English translation of a research document from 2026-11-06 that compares the menus of seven indoor cycling platforms and proposes a menu structure. It is **optional future development**: each part is taken up only when a real use case of a phase needs it, and then designed in small steps with its own Cucumber scenarios and ADR (AGENTS.md rules 1, 3 and 9). The architecture documents in `docs/architecture/` describe only what exists.

## Summary

The best structure has five main areas by user intent – **Today, Ride, Training, Events, Me** – plus three global elements that are visible everywhere: **Search, Device status, Settings**.

All seven platforms end up with 5–8 main items built from almost the same blocks (routes, workouts, events, profile). Users are not annoyed by the number of menu items, but at four points:

- **Too long a way to start riding:** large promotion and challenge tiles, scrolling, mandatory pairing before browsing.
- **No search, no favourites:** at Zwift one of the most requested features for almost ten years.
- **Planning only half in the app:** calendars that cannot be edited directly (TrainerRoad in the past, Wahoo SYSTM).
- **Redesigns that remove features:** for example "Ride With" at Zwift in 2022.

The proposal below addresses exactly these four points: at most two clicks to the start, a global search with favourites, the calendar as the hub of training, and settings that are reachable before, during and after the ride.

## Choice of platforms

Besides Zwift and Rouvy, five platforms cover the three market segments: virtual worlds (**MyWhoosh**, **TrainingPeaks Virtual**), structured training (**TrainerRoad**, **Wahoo SYSTM**) and real video (**FulGaz**, a sister product of Rouvy since its acquisition). The choice is an estimate by popularity and role in the market, not a measurement of market share.

Sources are the official help centres (for the menus) and manufacturer forums, app store reviews and the specialist press (for the criticism), as of early November 2026.

## Table 1: Menu structures compared

Six of the seven platforms separate routes, workouts and events at the top level; only FulGaz organises everything through ride collections. The biggest differences are where the calendar, devices and settings sit.

| Platform | Type | Main navigation (level 1) | Planning / calendar | Devices and settings | Notable |
|---|---|---|---|---|---|
| [Zwift](https://forums.zwift.com/t/home-screen-theater-card-and-progress-card-september-2026/671249) | Virtual world | Text navigation: Home, Events, Workouts, Routes; Garage and Achievements as icons top right | "My List" and a "For You" row with day labels; planning mostly in the companion app | Own pairing screen before Home; many settings in the in-game menu | Since Sept. 2026 Home has a large "Theater Card" (challenges) and a progress widget |
| [Rouvy](https://support.rouvy.com/hc/en-us/articles/19606011647889) | Real video + AR | Left bar: Menu, Search, Home, Challenges, Routes, Events, Workouts, New | Workouts and training plans in the Workouts area; playlist through the companion app | "Menu" as a personal hub with 15 items (profile, subscription, sensors, settings, downloads …) | Own search entry with filters; ride menu with sensors, settings, customise interface, pause |
| [MyWhoosh](https://www.cyclingweekly.com/fitness/what-is-mywhoosh-what-to-know-about-the-ucis-chosen-virtual-cycling-platform) | Virtual world, free | Free Ride (worlds → routes), Workouts & Video on Demand (14 folders), Events, Calendar, Profile | Events calendar collects booked events and connected training plans | FTP and weight in the Profile tab | Companion app v3 with a tab bar: Home, Teams, MyWhoosh Space, Messages, Profile |
| [TrainerRoad](https://support.trainerroad.com/hc/en-us/articles/360057075531-TrainNow-Overview) | Structured training | Calendar, TrainNow, Workouts (list, favourites), Training Plans / Plan Builder, Career | The calendar is the centre; drag and drop, moving weeks | App settings; deep planning long only on the web | AI recommendation "TrainNow" as its own main item |
| [Wahoo SYSTM](https://support.wahoofitness.com/hc/en-us/articles/4405703679122-The-Home-page-and-Navigation-Bar-Windows-and-Mac) | Structured training + video | Side bar: Home (today, yesterday, tomorrow), Calendar, Library, Plans, Settings, More | Calendar filled through a training plan or "Add to calendar" from the Library | Settings with data sharing (Strava, Garmin, TrainingPeaks) and display | Home shows the training day; daily recommendation in the Home tab |
| [TrainingPeaks Virtual](https://help.trainingpeaks.com/hc/en-us/articles/31339600374541-TrainingPeaks-Virtual-Menu) | Virtual world for coaching | Home, Workouts, Routes, Pacers, Events, Challenges, Profile, Settings | Workouts come from the coach's TrainingPeaks calendar | Pairing, zones, history under Profile; trainer/graphics/audio under Settings | Freely configurable ride UI: about 50 values at about 20 positions |
| [FulGaz](https://feedback.fulgaz.com/articles/360044755831-tips-on-searching-fulgaz-rides) | Real video | Main page with two rows of collections (partners/events; new, easy, hilly …), "Your Rides", world map | Training plans and sync from TrainingPeaks / Today's Plan | "Connect Devices" top right; Performance Settings in the main menu | Everything through ride collections instead of category navigation |

## Table 2: What bothers users and what they suggest

The criticism is less about looks than about paths: how fast you start riding, find, plan and reach settings.

| Platform | What bothers most | Most frequent suggestions |
|---|---|---|
| Zwift | Tile Home needs more clicks and scrolling ([road.cc](https://road.cc/content/news/zwift-changes-its-layout-and-people-are-very-angry-292485)); large challenge/promotion cards; "Ride With" was dropped in the redesign; no search and no favourites for workouts ([forum](https://forums.zwift.com/t/workouts-search-function/213167?page=2)); settings reachable only after starting a ride ([TR forum](https://www.trainerroad.com/forum/t/finally-zwift-introduces-return-to-home-feature/55762?page=2)); contradictory achievement numbers | Search bar for workouts and routes with filters (name, duration, TSS); favourites and "recently ridden"; fixed entries in "For You"; make the progress widget clickable; reduce friction before riding ([forum](https://forums.zwift.com/t/home-screen-theater-card-and-progress-card-september-2026/671249)); recommendations optional |
| Rouvy | Before 2023: navigation called "horrible", rides not sortable by popularity ([Wahoo forum](https://wahoox.forum.wahoofitness.com/t/testing-rouvy-my-advice-dont/17936)); search showed at most 100 results ([Slowtwitch](https://slowtwitch.com/?p=48293)); even after the redesign the interface partly looks dated, workout filters thinner than at TrainerRoad ([Cyclist's Hub](https://www.cyclistshub.com/rouvy-review)); cancellation hard to find | More filters and sorting (popularity, gradient, workout zones); permanent map view on Apple TV ([Marlvel](https://marlvel.ai/apps/rouvy-real-indoor-cycling-app/reviews)); complete translations |
| MyWhoosh | Crashes and connection problems dominate; own past rides not available in the app; steering by touch unintuitive ([Apptail](https://apptail.io/app/mywhoosh-indoor-cycling-app-pfW/greece)) | Best times directly in the route selection menu ([Apptail](https://apptail.io/app/mywhoosh-indoor-cycling-app-pfW/italy)); ride history in the app; better Garmin integration |
| TrainerRoad | Mobile calendar long showed only "the next 3–4 workouts", no undo, plan details only on the web ([forum](https://www.trainerroad.com/forum/t/calendar-overhaul-feature-ideas/82360)); progression levels visible only in the Career area ([forum](https://trainerroad.com/forum/t/trainnow-view-current-progression-level/76662)) | Full calendar editing in the app; move weeks, insert a recovery week; show the level directly in TrainNow; filter by interval duration |
| Wahoo SYSTM | Calendar can be filled only through a training plan or the Library; no rest days, notes, outdoor rides ([forum](https://wahoox.forum.wahoofitness.com/t/more-calendar-options/22999)); calendar loads slowly; Explore text list not very intuitive | Add workouts directly from the calendar ([forum](https://wahoox.forum.wahoofitness.com/t/request-plan-outdoors-workouts-individual-workouts/19464)); plan notes and cross-training; export to Google/Apple/Outlook calendars |
| TrainingPeaks Virtual | Download screen before the first menu can take very long ([App Store](https://apps.apple.com/app/id6480213250)); in-ride menu sometimes hangs ([UserVoice](https://peaksware.uservoice.com/forums/964442-trainingpeaks-virtual-customer-feedback/suggestions/49082114-basic-implementation-zwift-style-and-bug)) | Download in the background; familiar comfort features like Zwift (the maker deliberately rejects some, for example a W/kg display) |
| FulGaz | "Good ride UI, horrible menu"; settings too deep and confusing ([road.cc](https://road.cc/content/review/fulgaz-training-app-291725)); pairing must be completed before rides can be viewed; on Windows no exit/menu bar ([Trustpilot](https://www.trustpilot.com/review/fulgaz.com?page=2)) | One simple settings menu with an "Advanced" option; browsing without pairing; further improved search and filters |

## Patterns across all platforms

Six requirements show up at almost all platforms and form the design rules for the proposal.

| # | Requirement | Seen at | Design rule |
|---|---|---|---|
| 1 | Start riding quickly | Zwift, FulGaz, TP Virtual | Planned training and "Repeat last ride" at the very top; at most 2 clicks to the start |
| 2 | Find instead of scroll | Zwift, Rouvy, TrainerRoad, MyWhoosh | Global search with filters (duration, TSS, zone, gradient, country), favourites, history |
| 3 | Plan in the app | TrainerRoad, Wahoo SYSTM, Zwift | Calendar as the hub: "schedule" everything from everywhere, edit directly in the calendar, undo |
| 4 | Settings always reachable | Zwift, FulGaz, Rouvy | Device status and settings global, before and during the ride; pairing never required for browsing |
| 5 | Controllable Home | Zwift | Personalisation yes, but tiles can be hidden; promotion and gamification not dominant |
| 6 | Redesigns without loss | Zwift, TrainerRoad | Gradual rollout, remove nothing without a replacement, transition period with the old layout |

## Proposal: the best menu structure

The navigation follows five intents instead of content types: start riding, ride freely, train with structure, ride together, see one's own history. Search, device status and settings sit above them as a fixed header.

**Five areas by user intent, search and devices always reachable** – main navigation (level 1) with the most important sub-items (level 2):

```
┌──────────────────────────────────────────────────────────────────────────┐
│        Always visible: Search · Device status · Settings · Profile       │
└──────────────────────────────────────────────────────────────────────────┘
  Today          Ride             Training         Events           Me
  (start riding) (ride freely)    (structured)     (together)       (my history)
  ─────────────  ───────────────  ───────────────  ───────────────  ───────────────
  Planned today  Worlds, routes   Calendar         Races            Activities
  Ride again     Real video       Workouts         Group rides      Progress, FTP
  Next event     Map and filters  Training plans   Challenges       Achievements, garage
  Weekly goal    Pacers, groups   AI suggestion    Clubs and teams  Account, subscription
┌ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ┐
  During the ride (at most 5 items): Devices · Display · Settings · Pause · End
└ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ┘
```

"Today" is the starting point (highlighted); Training bundles the calendar, workouts and plans, so planning does not split between web and app.

**Rules for the implementation**

1. **Today is the start screen.** At the top exactly one large card: the planned training or "Ride again", with a start button. Below it at most three rows (next event, weekly goal, recommendations), each one can be hidden.
2. **Two clicks to the start.** From every list: tap the entry → "Go". Pairing appears only at the start, never as a required step before browsing.
3. **One search for everything.** Routes, workouts, events and riders in one field; filters for duration, TSS, zone, gradient, country; sorting by popularity; a favourite star on every card.
4. **Calendar as the hub.** Every card (route, workout, event) has "Schedule". In the calendar itself: add, move, rest day, note, outdoor ride, undo; export to Google/Apple/Outlook.
5. **Settings in two levels.** Basic settings on one page, the rest behind "Advanced". Reachable before, during and after the ride.
6. **During the ride at most five items:** Devices, Customise display, Settings, Pause, End.
7. **Clickable progress.** Level, achievements and garage are destinations under "Me"; every widget leads to the matching list or to routes that are still missing.
8. **Gradual redesigns.** Never remove a feature without a replacement; the new layout can be switched for a while.

## Addition for ridrs: an equipment garage

Added on 2026-11-06, not part of the research above. **Implemented** the same day as [ADR 0060](../decisions/0060-equipment-garage-and-the-frozen-bicycle.md): one bicycle with its weight and a Shimano Di2 2 × 12 drivetrain (50-34 / 11-34) in three shifting modes, frozen for each ride, recorded and replayed; the garage as a menu entry of its own after Me (the maintainer's choice instead of "under Me"), apart from the achievements; the start card on Today names the bicycle. In the proposal, "garage" means a virtual collection next to achievements, as at Zwift. For ridrs a garage of the **equipment one rides with** is more useful, because it feeds the physics.

Markers: **[Fact]** verified against the code on 2026-11-06; **[Optional]** an idea for later; **[Leaning]** a preference the maintainer stated; not a decision.

- **[Fact]** `physics-bicycle` provides fixed parameters labelled `origin: 'default'`: mass 10 kg, rolling resistance coefficient 0.004. Nothing is configurable.
- **[Fact]** `control-virtual-gears` has one fixed table ([ADR 0055](../decisions/0055-virtual-gears-and-never-stale-series.md)): real gear 34 × 14, 24 virtual gears in a geometric series from 34 × 34 to 53 × 11, every ride starts in gear 12, and the gear does not carry over between rides.
- **[Fact]** Plugin settings exist as JSON documents ([ADR 0054](../decisions/0054-plugin-settings-and-remembered-devices.md)).
- **[Leaning]** First step: **one virtual bicycle** with
  - a name,
  - its **weight** (replaces the 10 kg default of `physics-bicycle`),
  - its **gearing**: the ratios of the virtual gears (for example chainrings × cassette, or a list of ratios) and the start gear (replaces the fixed table of `control-virtual-gears`).
- **[Optional]** In the menu: "Garage" under "Me", separate from achievements; the start card of "Today" shows the bicycle that is ridden.
- **[Optional]** Later: several bicycles with a quick switch before the start, tyres (rolling resistance), riding position (drag), the trainer and sensors linked to a bicycle, wear in kilometres per part from the saved rides.

## Sources

- [Zwift Forum: Home Screen Theater Card and Progress Card, Sept. 2026](https://forums.zwift.com/t/home-screen-theater-card-and-progress-card-september-2026/671249)
- [Zwift Forum: My List and Home Screen Updates, April 2024](https://forums.zwift.com/t/my-list-and-home-screen-updates-april-2024/629572)
- [Zwift Forum: Workouts – search function](https://forums.zwift.com/t/workouts-search-function/213167?page=2)
- [road.cc: Zwift changes its layout and people are very angry](https://road.cc/content/news/zwift-changes-its-layout-and-people-are-very-angry-292485)
- [Rouvy Support: Getting Started with the ROUVY App](https://support.rouvy.com/hc/en-us/articles/19606011647889)
- [Rouvy Support: In-app Settings](https://support.rouvy.com/hc/en-us/articles/13407949169681)
- [Rouvy Support: Customize Your Riding Screen](https://support.rouvy.com/hc/en-us/articles/34303641851921)
- [Cycling Weekly: Rouvy launches entirely new dashboard](https://www.cyclingweekly.com/fitness/give-us-another-try-rouvy-launches-entirely-new-dashboard-that-utilizes-ai-for-personalization)
- [Cycling Weekly: What is MyWhoosh?](https://www.cyclingweekly.com/fitness/what-is-mywhoosh-what-to-know-about-the-ucis-chosen-virtual-cycling-platform)
- [MyWhoosh: Link App v3](https://mywhoosh.com/mywhoosh-link-app-v3/)
- [TrainerRoad Support: TrainNow Overview](https://support.trainerroad.com/hc/en-us/articles/360057075531-TrainNow-Overview)
- [TrainerRoad Forum: Calendar Overhaul Feature Ideas](https://www.trainerroad.com/forum/t/calendar-overhaul-feature-ideas/82360)
- [Wahoo Support: Home page and Navigation Bar](https://support.wahoofitness.com/hc/en-us/articles/4405703679122-The-Home-page-and-Navigation-Bar-Windows-and-Mac)
- [Wahoo Forum: More Calendar Options](https://wahoox.forum.wahoofitness.com/t/more-calendar-options/22999)
- [TrainingPeaks Help: TrainingPeaks Virtual Menu](https://help.trainingpeaks.com/hc/en-us/articles/31339600374541-TrainingPeaks-Virtual-Menu)
- [TrainingPeaks Help: Custom Configurable UI](https://help.trainingpeaks.com/hc/en-us/articles/31340963364365-TrainingPeaks-Virtual-Custom-Configurable-UI)
- [FulGaz: Tips on searching FulGaz rides](https://feedback.fulgaz.com/articles/360044755831-tips-on-searching-fulgaz-rides)
- [road.cc: FulGaz training app review](https://road.cc/content/review/fulgaz-training-app-291725)
