Feature: Import of Zwift workout files (ZWO)
  A ZWO file is translated into the canonical workout format without loss and without
  conversion: power stays a percentage of FTP, a range is not a ramp, and everything the typed
  model has no field for is kept in the zwo extensions (ADR 0081).

  Scenario: A warm-up ramp and IntervalsT are imported as a ramp and a repeat of two steps
    Given a workout text file "ramp-and-intervals.zwo":
      """
      <workout_file>
        <author>Test Author</author>
        <name>Ramp and intervals</name>
        <description>A short test.</description>
        <sportType>bike</sportType>
        <workout>
          <Warmup Duration="600" PowerLow="0.5" PowerHigh="0.75"/>
          <IntervalsT Repeat="3" OnDuration="60" OffDuration="120" OnPower="1.2" OffPower="0.5"/>
          <Cooldown Duration="300" PowerLow="0.7" PowerHigh="0.4"/>
        </workout>
      </workout_file>
      """
    When the workout text file is imported
    Then the import succeeds with 1 workout
    And the imported workout is named "Ramp and intervals"
    And in the imported workout, step "1" ramps from 50 to 75 percent-ftp
    And in the imported workout, step "1" lasts 600 seconds
    And in the imported workout, step "1" has the intensity "warm-up"
    And in the imported workout, step "2" is a repeat of 3 times
    And in the imported workout, step "2.1" lasts 60 seconds
    And in the imported workout, step "2.1" holds 120 percent-ftp
    And in the imported workout, step "2.2" lasts 120 seconds
    And in the imported workout, step "2.2" holds 50 percent-ftp
    And in the imported workout, step "3" ramps from 70 to 40 percent-ftp
    And in the imported workout, step "3" has the intensity "cool-down"
    And the zwo extensions of step "2" have "element" equal to "IntervalsT"

  Scenario: Power stays a percentage of FTP and is never converted to watts
    Given a workout text file "steady.zwo":
      """
      <workout_file>
        <name>Steady</name>
        <workout>
          <SteadyState Duration="300" Power="0.75"/>
          <SolidState Duration="60" Power="0.07"/>
        </workout>
      </workout_file>
      """
    When the workout text file is imported
    Then the import succeeds with 1 workout
    And in the imported workout, step "1" holds 75 percent-ftp
    And in the imported workout, step "2" holds 7 percent-ftp

  Scenario: FreeRide, MaxEffort and cadence
    Given a workout text file "free.zwo":
      """
      <workout_file>
        <name>Free</name>
        <workout>
          <FreeRide Duration="300" FlatRoad="1"/>
          <MaxEffort Duration="20"/>
          <SteadyState Duration="120" Power="0.9" Cadence="90"/>
        </workout>
      </workout_file>
      """
    When the workout text file is imported
    Then in the imported workout, step "1" is free riding on a flat road
    And in the imported workout, step "2" is a max effort
    And in the imported workout, step "3" also targets 90 rpm

  Scenario: Text events become cues of their step
    Given a workout text file "cues.zwo":
      """
      <workout_file>
        <name>Cues</name>
        <workout>
          <SteadyState Duration="300" Power="0.6">
            <textevent timeoffset="10" message="Settle in"/>
          </SteadyState>
        </workout>
      </workout_file>
      """
    When the workout text file is imported
    Then in the imported workout, step "1" has the cue "Settle in" at 10 seconds

  Scenario: What the typed model has no field for is kept in the extensions
    Given a workout text file "unknown.zwo":
      """
      <workout_file>
        <name>Unknown</name>
        <vendorBlock mood="good"/>
        <workout>
          <SteadyState Duration="300" Power="0.6" show_avg="1" tint="blue"/>
        </workout>
      </workout_file>
      """
    When the workout text file is imported
    Then the import succeeds with 1 workout
    And the zwo extensions of step "1" have "attributes.tint" equal to "blue"
    And the zwo extensions of step "1" have "attributes.show_avg" equal to "1"
    And the zwo extensions of the workout have "children[0].node.name" equal to "vendorBlock"

  Scenario: A running workout is refused
    Given a workout text file "run.zwo":
      """
      <workout_file>
        <name>Run</name>
        <sportType>run</sportType>
        <workout><SteadyState Duration="300" Power="0.6"/></workout>
      </workout_file>
      """
    When the workout text file is imported
    Then the import is refused with the code "not-cycling"

  Scenario: A broken file is refused with its reason
    Given a workout text file "broken.zwo":
      """
      <workout_file><name>Broken</name><workout><SteadyState Duration="300" Power="0.6"></workout>
      """
    When the workout text file is imported
    Then the import is refused with the code "invalid-xml"
    And the import has a reason

  Scenario: A step without a duration is refused
    Given a workout text file "no-duration.zwo":
      """
      <workout_file><name>X</name><workout><SteadyState Power="0.6"/></workout></workout_file>
      """
    When the workout text file is imported
    Then the import is refused with the code "missing-attribute"
