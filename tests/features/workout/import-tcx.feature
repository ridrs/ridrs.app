Feature: Import of TCX workouts
  The workouts of a Garmin TCX file are imported with their steps, repeats, durations and targets;
  extensions of the file are kept in the tcx extensions.

  Scenario: Steps, a repeat and their durations and targets
    Given a workout text file "sample.tcx":
      """
      <?xml version="1.0" encoding="UTF-8"?>
      <TrainingCenterDatabase xmlns="http://www.garmin.com/xmlschemas/TrainingCenterDatabase/v2" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">
        <Workouts>
          <Workout Sport="Biking">
            <Name>Test TCX</Name>
            <Step xsi:type="Step_t">
              <StepId>1</StepId>
              <Name>Warm up</Name>
              <Duration xsi:type="Time_t"><Seconds>600</Seconds></Duration>
              <Intensity>Active</Intensity>
              <Target xsi:type="Power_t">
                <PowerZone xsi:type="PredefinedPowerZone_t"><Number>2</Number></PowerZone>
              </Target>
            </Step>
            <Step xsi:type="Repeat_t">
              <StepId>2</StepId>
              <Repetitions>4</Repetitions>
              <Child xsi:type="Step_t">
                <StepId>3</StepId>
                <Duration xsi:type="Time_t"><Seconds>120</Seconds></Duration>
                <Intensity>Active</Intensity>
                <Target xsi:type="Power_t">
                  <PowerZone xsi:type="CustomPowerZone_t">
                    <Low xsi:type="PowerInWatts_t"><Value>250</Value></Low>
                    <High xsi:type="PowerInWatts_t"><Value>270</Value></High>
                  </PowerZone>
                </Target>
              </Child>
              <Child xsi:type="Step_t">
                <StepId>4</StepId>
                <Duration xsi:type="HeartRateBelow_t">
                  <HeartRate xsi:type="HeartRateInBeatsPerMinute_t"><Value>120</Value></HeartRate>
                </Duration>
                <Intensity>Resting</Intensity>
                <Target xsi:type="None_t"/>
              </Child>
            </Step>
            <Step xsi:type="Step_t">
              <StepId>5</StepId>
              <Duration xsi:type="UserInput_t"/>
              <Intensity>Resting</Intensity>
              <Target xsi:type="Cadence_t"><Low>85</Low><High>95</High></Target>
            </Step>
            <Notes>Be nice to your legs.</Notes>
          </Workout>
        </Workouts>
      </TrainingCenterDatabase>
      """
    When the workout text file is imported
    Then the import succeeds with 1 workout
    And the imported workout is named "Test TCX"
    And the imported workout has the description "Be nice to your legs."
    And in the imported workout, step "1" holds 2 power-zone
    And in the imported workout, step "1" has the name "Warm up"
    And in the imported workout, step "2" is a repeat of 4 times
    And in the imported workout, step "2.1" holds 250 to 270 watts
    And in the imported workout, step "2.2" lasts until the heart rate is below 120 bpm
    And in the imported workout, step "2.2" has the intensity "rest"
    And in the imported workout, step "3" lasts until the lap button
    And in the imported workout, step "3" holds 85 to 95 rpm

  Scenario: Extensions of the file are kept
    Given a workout text file "ext.tcx":
      """
      <TrainingCenterDatabase xmlns="http://www.garmin.com/xmlschemas/TrainingCenterDatabase/v2">
        <Workouts>
          <Workout Sport="Biking">
            <Name>Ext</Name>
            <Step xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xsi:type="Step_t">
              <StepId>1</StepId>
              <Duration xsi:type="Time_t"><Seconds>60</Seconds></Duration>
              <Intensity>Active</Intensity>
              <Target xsi:type="None_t"/>
            </Step>
            <Extensions><Vendor><Thing>1</Thing></Vendor></Extensions>
          </Workout>
        </Workouts>
      </TrainingCenterDatabase>
      """
    When the workout text file is imported
    Then the tcx extensions of the workout have "children[0].node.name" equal to "Extensions"

  Scenario: A running workout is refused
    Given a workout text file "run.tcx":
      """
      <TrainingCenterDatabase>
        <Workouts>
          <Workout Sport="Running"><Name>Run</Name></Workout>
        </Workouts>
      </TrainingCenterDatabase>
      """
    When the workout text file is imported
    Then the import is refused with the code "not-cycling"

  Scenario: A TCX file without workouts is refused
    Given a workout text file "activity.tcx":
      """
      <TrainingCenterDatabase><Activities/></TrainingCenterDatabase>
      """
    When the workout text file is imported
    Then the import is refused with the code "no-workout"

  Scenario: A broken file is refused with its reason
    Given a workout text file "broken.tcx":
      """
      <TrainingCenterDatabase><Workouts>
      """
    When the workout text file is imported
    Then the import is refused with the code "invalid-xml"
    And the import has a reason
