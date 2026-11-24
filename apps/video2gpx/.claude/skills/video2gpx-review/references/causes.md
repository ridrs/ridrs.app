# Cause catalogue for video2gpx findings

Use a cause id from this list in `verdicts.json`, `make_test.py --cause` and the report, so that findings from many videos can be
grouped and counted. If nothing fits, add a new id under the right family. Say so in the report, and propose adding it to this file.

Module paths are relative to `apps/video2gpx/research/route-shape-matching/rsm/pipeline/` in the runner worktree. Read the code there
before you name a fix: the config comments often already say why a value was chosen, and which case it would break.

## How to get from a symptom to a cause

1. **Which step first went wrong?** Work forward through the steps, and stop at the first step whose output is wrong:
   - the motion step (speed and yaw from vms): use `series.png` and `overlay_*.png`;
   - the rotation step (far features);
   - the map (is the true road in the graph at all? Check `nodes.json`, and the map image for missing roads);
   - the route search (wrong road picked, or the calibration is off);
   - refine (the local pass, alignment, standstills);
   - the GPX / driving line.

   A wrong step makes every later step look wrong too. Fixing a later step only hides the error.
2. **Measure, do not guess.** Every cause needs a value next to its limit. For example: "inliers 12 against 40 typical on this video",
   "video yaw 9 °/s, map yaw 1.5 °/s over 20 s", "true road missing in OSM: a way exists in the frame, none in graph_real".
   `series.json` has `limits` with the thresholds that the pipeline itself uses.
3. **Check the counter-case.** If you claim a cause, look at a place in the same video where the same condition holds and the result is
   right (the control spots K01… help here). A cause that is also present where everything works is at most a contributing factor.

## Families and ids

### odometry: speed or distance from the image motion (vms, steps_a.motion, vmsx/, odofail.py, standstill.py)
| id | typical evidence | where to look |
|---|---|---|
| `odometry.low_texture` | few corners or inliers on the road (wet, snow, new tarmac, night, glare) | `C.VMS`, vmsx motion ROI |
| `odometry.traffic` | the flow is dominated by vehicles; `traffic.state` replaced or failed in the overlay | A17/A18 gating in `rsm.odometry.gating`, `C.STILL_*` |
| `odometry.roi_occlusion` | handlebar, dashboard, or bonnet in the ROI; points sit on the vehicle | horizon / ROI in `motion.json` |
| `odometry.scale_drift` | fused speed against nominal drifts; distance along the route too long or too short (landmarks late or early) | calibration kappa, `refine` fusion |
| `odometry.failure_span` | `odofail` spans, usable share below `limits.usable` | `odofail.py`, `C.ODO_*` |
| `odometry.false_standstill` | the position is held while the frames move (or the reverse) | `standstill.py`, `C.STILL_*` |

### rotation: heading change (far features, steps_a.rotation, align.py)
| id | typical evidence | where to look |
|---|---|---|
| `rotation.few_far_features` | `far_ok` low, why = "few corners" / "few inliers" (sky, fog, sea horizon, tunnel) | `C.FAR`, band layout |
| `rotation.tunnel_wall_bias` | in tunnels or galleries the vms points sit on one wall, so the yaw is biased against the map | vms point weighting, tunnel flag in route_search |
| `rotation.vms_far_disagree` | yaw_vms and yaw_far differ by more than `limits.yaw_noise_x` × the usual | fusion weights |
| `rotation.camera_motion` | head-mounted camera, the rider looks around, gimbal pans | yaw outliers that have no counterpart in the map |

### map: OSM data and the road graph (osm.py, steps_b.map_step, classes in config)
| id | typical evidence | where to look |
|---|---|---|
| `map.missing_road` | the road is visible in the video but is not in `graph_real` (check nodes / map image; compare with OSM online only if the user allows it) | road classes `CLASSES_*`, bike paths, `access` filters |
| `map.class_excluded` | the road exists in OSM, but its class or access is filtered out (service, track, private, construction) | `osm.py` class rules |
| `map.geometry` | the OSM geometry is coarse or offset (curve radius wrong, roundabout as a point) | map κ against video κ on a correct route |
| `map.parallel_roads` | parallel streets, dual carriageways, frontage roads | `parallel_street` status, local pass |
| `map.tunnel_tagging` | a tunnel in the video, but the OSM edge has no `tunnel` tag (or the reverse) | the tunnel flag in the series, the elevation correction |

### search: route search and calibration (steps_b, calib.py, hints.py, anchors.py)
| id | typical evidence | where to look |
|---|---|---|
| `search.ambiguous` | several roads fit about equally well (`ambiguous` cause, `p_search` low) | HMM transition and emission, decoys |
| `search.calibration` | f_eff or kappa at the scan edge, flat peak, implausible distance scale | `calibration_peak` status, `CAL_*`, adaptive grid |
| `search.wrong_branch` | a turn is taken one junction too early or too late (curve quanta shifted in time) | turn matching, alignment |
| `search.area` | bbox too small or too large, route cut at the edge (`area_size` status) | bbox rule of video2gpx-yt.sh / atlas |
| `search.hint` | the route hint pulls away from the true road (an approximate OSRM route of the atlas), or the corridor is too narrow | `hint_buffer_m`, `hint_fallback` |
| `search.uturn_loop` | the decoded path runs backwards and forwards again (a loop around a split carriageway or a junction triangle) where the frames show no turn. The path chord over 40 m drops below 15 m. The extra metres absorb a distance mismatch, often at a standstill. | `rsm/hmm/grid.py`: `pen_uturn` applies only to the twin edge of the same way. A reversal through a node onto ANOTHER one-way way is free. Found 2026-11-19, Nice–Monaco S10/S07/S12 |
| `search.start` | the wrong start (intro not cut, start frame missing, a car park or ferry at the start) | `intro_end`, `cuts.py`, `start_bbox` |

### refine: local pass, alignment, posterior (steps_c, local.py, align.py, islands.py)
| id | typical evidence | where to look |
|---|---|---|
| `refine.local_pass` | the local pass moved the route onto a wrong side street, or did not move it off one | `LOCAL_*`, the acceptance test |
| `refine.alignment` | the right road, but the along-track position is late or early by more than 50 m | `ALIGN_*`, dense heading alignment |
| `refine.posterior_low` | the position is right (checked in the video) but `conf` is low: the posterior underrates a correct result | posterior on straights, `ALIGN_POST_*` |
| `refine.island` | a short wrong island inside a correct route | `islands.py` |

### video: properties of the video itself (cuts.py, intro)
| id | typical evidence | where to look |
|---|---|---|
| `video.cut` | a scene cut, time-lapse, or skipped part (the frames jump) | `cuts.py`, `CUT_*` |
| `video.intro_outro` | intro, outro, drone shots, or a map overlay are counted as driving | intro detection |
| `video.speedup` | the video is played faster than real time, and the speed scale changes | kappa, scale drift |
| `video.quality` | heavy compression, low resolution, rain on the lens, night | motion inliers in general |

### confidence: correct result, but marked uncertain
Use `refine.posterior_low` when the posterior itself is the problem. Use the more specific ids below when the cause is the evidence:
| id | typical evidence |
|---|---|
| `confidence.no_information` | a straight without junctions: there is nothing to tell positions apart, so low conf is honest. Recommend presenting it differently, not "fixing" it. |
| `confidence.standstill` | a stop: there is no distance to match (cause `slow`). This is honest. |
| `confidence.edge_split` | the conf saw-tooth on a straight. It falls to about 0 30–100 m before every node the path passes straight through, and is back at 1 just after it, while `s_sd` stays constant. `conf` = `p_vit` = the posterior mass of the Viterbi cell's directed EDGE (`rsm/hmm/dp.py` `forward_backward`, `steps_c.grid_flags`), so mass on the next edge of the same road counts as doubt. Found 2026-11-19, Nice–Monaco S02–S07 |
| `confidence.underrated_turns` | clear turns in the video and the map agree, yet conf stays low: the posterior or the emission is too pessimistic |

## Typical fixes by family (starting points, not answers)

- **odometry / rotation:** a better feature selection or weighting. Detect the condition (tunnel, wall bias, traffic), and lower the
  weight of the bad source instead of trusting it. Test these on clip tests of 60–120 s: they need only the motion and rotation steps.
- **map:** add the road classes or access rules, or accept the missing road as a gap. Test on a snippet whose bbox has the true road.
- **search / refine:** change the emission or transition rules, the acceptance tests, or the thresholds. Test on snippet cases with
  `run_tests.py --seed <tag> --from-step route_search` (or `refine`), which take seconds to minutes.
- **confidence:** recalibrate the posterior. Test with the uncertain-correct cases (their focus conf must rise, their checkpoints must stay).
