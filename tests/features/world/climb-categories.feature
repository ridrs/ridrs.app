Feature: The climbs of a route are categorised like the Tour's
  The catalog tool of a video source names the climbs of each route and, for fun, draws its
  elevation profile as a picture beside the catalog; the app draws its own (ADR 0070). A climb
  runs from its foot to its summit; a dip of less than 50 m does not end it, a false flat before
  the foot does not belong to it, and a climb that averages less than 3 % starts where the rest
  of it averages 3 %. Its score is its length in m times its average gradient in %, the common
  stand-in for the Tour's categories: Cat 4 from 8,000, Cat 3 from 16,000, Cat 2 from 32,000,
  Cat 1 from 64,000 and HC from 80,000. A climb flatter than 3 % or shorter than 500 m has no
  category. A climb takes its name from the route's notes: a place named within 300 m of its
  summit, else the last note announcing an ascent from 500 m before its foot to its summit.

  Scenario Outline: A climb's category follows its score: <category>
    Given a route that runs
      | for         | rising  |
      | 2 km        | 0 m     |
      | <length> km | <gain> m |
      | 2 km        | 0 m     |
    When its climbs are categorised
    Then it has 1 climb
    And climb 1 is "<category>" from km 2.0 to km <summit> with <gain> m at <grade> %

    Examples:
      | category | length | gain | summit | grade |
      | 4        | 2      | 100  | 4.0    | 5.0   |
      | 3        | 3      | 200  | 5.0    | 6.7   |
      | 2        | 6      | 400  | 8.0    | 6.7   |
      | 1        | 12     | 700  | 14.0   | 5.8   |
      | HC       | 15     | 900  | 17.0   | 6.0   |

  Scenario: A small rise has no category
    Given a route that runs
      | for  | rising |
      | 2 km | 0 m    |
      | 1 km | 60 m   |
      | 2 km | 0 m    |
    When its climbs are categorised
    Then it has 0 climbs

  Scenario: A climb flatter than 3 % has no category
    Given a route that runs
      | for   | rising |
      | 10 km | 250 m  |
    When its climbs are categorised
    Then it has 0 climbs

  Scenario: A short dip does not split a climb
    Given a route that runs
      | for    | rising |
      | 5 km   | 300 m  |
      | 0.5 km | -30 m  |
      | 5 km   | 300 m  |
      | 2 km   | 0 m    |
    When its climbs are categorised
    Then it has 1 climb
    And climb 1 is "2" from km 0.0 to km 10.5 with 570 m at 5.4 %

  Scenario: A false flat before the foot does not belong to the climb
    Given a route that runs
      | for   | rising |
      | 10 km | 100 m  |
      | 6 km  | 400 m  |
    When its climbs are categorised
    Then it has 1 climb
    And climb 1 is "2" from km 10.0 to km 16.0 with 400 m at 6.7 %

  Scenario: A long gentle approach is cut where the climb averages 3 %
    Given a route that runs
      | for   | rising |
      | 15 km | 300 m  |
      | 2 km  | 140 m  |
    When its climbs are categorised
    Then it has 1 climb
    And climb 1 is "3" from km 7.0 to km 17.0 with 300 m at 3.0 %

  Scenario: A descent between two climbs makes two climbs
    Given a route that runs
      | for  | rising |
      | 5 km | 400 m  |
      | 5 km | -300 m |
      | 3 km | 200 m  |
    When its climbs are categorised
    Then it has 2 climbs
    And climb 1 is "2" from km 0.0 to km 5.0 with 400 m at 8.0 %
    And climb 2 is "3" from km 10.0 to km 13.0 with 200 m at 6.7 %

  Scenario: The profile picture marks each summit and colours each km by its gradient
    Given a route that runs
      | for  | rising |
      | 2 km | 0 m    |
      | 3 km | 150 m  |
      | 2 km | -40 m  |
    When its profile picture is drawn
    Then the picture marks a summit "4" at 650 m at km 5.0
    And the picture colours km 1 as "below 2 %"
    And the picture colours km 3 as "4–6 %"
    And the picture shows no name or logo of the Tour de France

  Scenario: A climb is named after the note at its summit
    Given a route that runs
      | for  | rising |
      | 2 km | 0 m    |
      | 3 km | 150 m  |
      | 2 km | -40 m  |
    And the route's notes
      | at      | text                                  |
      | km 2.1  | Climb (3 km, ca. 5%)                  |
      | km 4.0  | 1 kilometer to the top                |
      | km 5.08 | Col de Test (alt. 650m)               |
    When its climbs are categorised
    Then climb 1 is named "Col de Test"

  Scenario: A climb without a named summit is named after the note announcing it
    Given a route that runs
      | for  | rising |
      | 2 km | 0 m    |
      | 3 km | 150 m  |
      | 2 km | -40 m  |
    And the route's notes
      | at     | text                                                  |
      | km 1.8 | Next 3 km:\nTesthöhe - ascent ca. 5 % (max. 9 %)      |
      | km 5.0 | Top of ascent\n650 meters above sea level             |
    When its climbs are categorised
    Then climb 1 is named "Testhöhe"

  Scenario: A climb without a note near it has no name
    Given a route that runs
      | for  | rising |
      | 2 km | 0 m    |
      | 3 km | 150 m  |
      | 2 km | -40 m  |
    And the route's notes
      | at     | text      |
      | km 0.5 | Somewhere |
    When its climbs are categorised
    Then climb 1 has no name

  Scenario: A climb is named after the route's peaks list
    Given a route that runs
      | for  | rising |
      | 2 km | 0 m    |
      | 3 km | 150 m  |
      | 2 km | -40 m  |
    And the route's peaks
      | Col de Test |
    When its climbs are categorised
    Then climb 1 is named "Col de Test"

  Scenario: The climbs of the Van Gestel catalog are named where its notes name them
    When I read the route "col-de-pennes" of the Van Gestel catalog
    Then the route has a climb "2" to 1018 m at km 11.3 named "Col de Pennes"
    When I read the route "rimberg-kronenberg" of the Van Gestel catalog
    Then the route has a climb "4" to 379 m at km 6.1 named "Rimberg"
    And the route has a climb "4" to 411 m at km 10.2 named "Kronenberg"

  Scenario: Every video of the Van Gestel catalog lists its peaks and names its climbs
    When I read the route "col-de-rousset" of the Van Gestel catalog
    Then the route has a climb "1" to 1244 m at km 14.3 named "Col de Rousset"
    When I read the route "menee-1" of the Van Gestel catalog
    Then the route has a climb "4" to 627 m at km 4.9 named "Le Collet"
    When I read the route "valdrome-2" of the Van Gestel catalog
    Then the route has a climb "2" to 1122 m at km 10.7 named "Col de Rossas"
    And every video of the Van Gestel catalog has a peaks file matching its climbs

  Scenario: The Col de Rousset of the Van Gestel catalog is a Cat 1 climb
    When I read the route "col-de-rousset" of the Van Gestel catalog
    Then the route has a climb "1" to 1244 m at km 14.3
    And the route has a profile picture
