@phase-10
Feature: A recording from before the surface no longer replays
  ridrs is in early alpha: recordings are not kept compatible across format changes yet.
  Since the road under the rider has a surface, a recording whose physics states have
  none is not a valid recording any more, and the replay says so instead of guessing.

  Scenario: An older recording is rejected
    Given the recording fixture "before-terrain-preview.ridrs", made before the terrain preview existed
    When the recording is replayed
    Then the replay failed with "invalid-recording"
