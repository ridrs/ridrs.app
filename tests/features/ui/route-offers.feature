@ui
Feature: The ride page lists the routes that plugins offer
  Plugins offer routes as data (docs/ideas/video-sources.md): a world offers its courses, a video
  source the videos of its catalog, each offer as a key of the app state `route.offer` (ADR 0068).
  The ride page watches the topic and lists every offer alike: worlds and routes, then real video.
  An offer that is not on this device yet says so and cannot be ridden; a download that cannot
  start says why at once; third-party content names its author, source and license in its details.
  A route's card shows its picture, what it is, its title, its distance and its climb, and leaves
  the rest to the details: country, duration and credits. The details open on the route's picture
  across the page, with Back at its top left, and draw the profile coloured by its gradients, each
  categorised summit marked with its category and, where the catalog names it, its name.

  Background:
    Given the ridrs plugins "activity-session, ui-main-screen, ui-main-menu, ui-main-top-bar, ui-tile-ride-start, ui-activity-screen, ui-landscape-demo, ui-area-ride, video-source-vangestel" running
    And the main screen is 1400 px wide
    And the ridrs UI is shown

  Scenario: The demo course and the Van Gestel videos are listed
    When I press "Ride"
    Then the section "Worlds and routes" lists "Demo course"
    And the section "Real video" lists 23 routes
    And the route "Col de Pennes - Climb it twice!" reads "46.1 km"
    And the route "Col de Pennes - Climb it twice!" reads "1216 m"
    And the route "Col de Pennes - Climb it twice!" does not read "France"
    And the route "Col de Pennes - Climb it twice!" does not read "min"
    And the route "Col de Pennes - Climb it twice!" shows a picture and an elevation profile

  Scenario: A route card leaves the credits to the route details
    When I press "Ride"
    Then the route "Col de Pennes - Climb it twice!" reads "Video"
    And the route "Col de Pennes - Climb it twice!" does not read "Fred Van Gestel"
    And the route "Col de Pennes - Climb it twice!" does not read "CC BY-NC-SA 4.0"

  Scenario: A video route names its author, source and license
    When I press "Ride"
    And I press "Col de Pennes - Climb it twice!"
    Then the route details read "By Fred Van Gestel, Van Gestel – Cycling pages, CC BY-NC-SA 4.0"
    And the route details read "Not on this device yet: 11.2 GB to download"
    And the route details offer no "Go" button

  Scenario: A route's details draw its profile and list its categorised climbs
    When I press "Ride"
    And I press "Rousset - 4 - Col de Rousset, Die"
    Then the route details draw the elevation profile of "Rousset - 4 - Col de Rousset, Die"
    And the route details list the climb "Cat 1: summit 1244 m at km 14.3"

  Scenario: A route's details open on its picture with Back
    When I press "Ride"
    And I press "Col de Pennes - Climb it twice!"
    Then the route details show the picture "col-de-pennes/thumbnail.jpg" across the top
    And the route details offer a "Back" button
    And the route details offer no "All routes" button
    When I press "Back"
    Then the section "Real video" lists "Col de Pennes - Climb it twice!"

  Scenario: A route's profile names its summits and colours its gradients
    When I press "Ride"
    And I press "Col de Pennes - Climb it twice!"
    Then the route's profile marks a "2" summit "Col de Pennes" at km 11.3
    And the route's profile marks a "2" summit "Col de Pennes" at km 32.6
    And the route's profile colours each stretch by its gradient
    And the route details list the climb "Col de Pennes"

  Scenario: A summit without a name is marked by its altitude
    When I press "Ride"
    And I press "Rousset - 4 - Col de Rousset, Die"
    Then the route's profile marks a "1" summit "1244 m" at km 14.3

  Scenario: A download that cannot start says why
    When I press "Ride"
    And I press "Col de Pennes - Climb it twice!"
    And I press "Download"
    Then the route details read "This app cannot download routes yet"
    And the route details offer no "Go" button

  Scenario: Go on the demo course rides the demo landscape
    When I press "Ride"
    And I press "Demo course"
    And I press "Go"
    Then the "activity" screen is shown
    And the ride was requested in the world "ui-landscape-demo/landscape"

  Scenario: Filters work across all offers
    When I press "Ride"
    And I press "Flat"
    Then the section "Worlds and routes" lists 0 routes
    And the section "Real video" lists "Marburg - Lahntal"
    And the section "Real video" does not list "Col de Pennes - Climb it twice!"
    When I press "Flat"
    And I press "Hilly"
    Then the section "Worlds and routes" lists "Demo course"
    And the section "Real video" lists "Col de Pennes - Climb it twice!"
    And the section "Real video" does not list "Marburg - Lahntal"

  Scenario: Without a video source there is no real video
    Given ridrs restarted without the plugin "video-source-vangestel"
    And I reload the UI
    When I press "Ride"
    Then the section "Worlds and routes" lists "Demo course"
    And the section "Real video" lists 0 routes
