# SPDX-License-Identifier: AGPL-3.0-or-later
"""The frozen configuration. Nothing here is tuned per video. Provisional thresholds are marked PROVISIONAL (dev evidence only)."""
import numpy as np

STEPS = ["motion", "rotation", "map", "route_search", "plausibility", "refine", "gpx"]
MAX_WORKERS = 4
MEMGUARD = dict(max_gb=12.0, min_free=25.0)
HMM_CAP_GB = 4.0
GPX_HZ = 5              # fixed output raster of route.gpx and the Incyclist export: points per video second (the 1 s grid of the result stays for validation)

# --- vms (default flags, as the Amalfi far-yaw chain; the bikes' "refined" flags lost coverage on other horizons, FINDINGS "vms turn detection calibrated")
VMS = dict(height=360, step=1)
F360 = 449.0            # vms yaw -> rad (pooled GPS fit of the dev bikes)
CAMERA_H = 1.1          # nominal camera height of the nominal distance (kappa absorbs the rest)
F_REF = 449.0           # reference of the stored heading tracks (th = rad / (F_REF / f_eff))
F_FAR = 450.0           # fixed focal length of the far-feature window fit (the HMM re-bases it through f_eff)
FAR = dict(k_s=0.267, chunk_s=120.0, min_inl=30, band_step=35.0, n_bands=3)
ROT_BAND_OFF_VMS = -25.0  # first far band ends this many rows (at 360) below the FOE horizon of vms (motion.json horizon_vms); old projects without it: the free
                          # road-plane horizon with farfeat.Params.band_off (-5). work/rotation-exp: FOE-25 neutral on GPS clips, frac_far up where the old row was in the sky
ROT_BRIDGE_ON = True      # heading across vms speed gaps: gap sub-steps get far-feature-only heading increments (rotation/far_heading.npz); distance prior of gaps unchanged,
                          # scene cuts never bridged
ROT_BRIDGE_MIN_VALID = 0.8  # a gap sub-step gets a heading only if valid far windows cover at least this share of its time

# --- scan: always wide, never narrowed by the vehicle guess
F_LO, F_HI, N_F = 250.0, 600.0, 11          # step ratio 1.0915 (the Amalfi far run used 1.0866)
K_LO, K_HI, N_K = 0.8, 3.5, 8   # with the FOE horizon (commit 1cb27b1) kappa fell to about 0.75 x (bench foe1: bikes 0.80-1.06). K_LO 0.65 was tried (bench kap1): no
                                # kappa changed, and the map's memory pre-check (nominal x K_LO) refused Rousset (4.65 > 4 GB); lower kappas come from the edge extension
F_GRID = tuple(float(x) for x in F_LO * (F_HI / F_LO) ** (np.arange(N_F) / (N_F - 1)))
K_GRID = tuple(float(x) for x in K_LO * (K_HI / K_LO) ** (np.arange(N_K) / (N_K - 1)))
H = 30.0                 # nominal step; one cell = H * kappa m
D0 = 30.0
REFINE_K = (0.87, 0.93, 1.0, 1.075, 1.15)   # local refinement of the decoded (kappa, f_eff): factors on the coarse best
REFINE_F = (0.92, 1.0, 1.09)

# --- decoys: 3 foreign + 12 shuffle + 1 mirror + 3 foreign+shuffle = 19
N_FOREIGN, N_SHUFFLE, SEED0 = 3, 12, 100
DENSITY_WINDOW = (0.7, 1.4)         # foreign box road km within this factor of the real box; widened to RELAX if fewer than 3 are found
DENSITY_RELAX = (0.5, 2.0)
GAP_BOXES = 0.5                      # foreign boxes keep this many box sizes of distance from the user's bbox

# --- classes
CLASSES_MOTOR = ("motorway", "motorway_link", "trunk", "trunk_link", "primary", "primary_link", "secondary", "secondary_link", "tertiary", "tertiary_link", "unclassified")
CLASSES_BIKE = ("trunk", "trunk_link", "primary", "primary_link", "secondary", "secondary_link", "tertiary", "tertiary_link", "unclassified", "residential", "living_street")
# --- bike paths (2026-11-13, maintainer decision; PROVISIONAL rules, FINDINGS "Bike paths"). cycleway / path / track (and service, footway, pedestrian,
# bridleway with a bicycle permission), each way filtered by osm.way_ok, enter the search map ONLY (a) when the user chose the bike profile (--vehicle bike):
# CLASSES_BIKE_PATHS is then the search map, or (b) as a fallback: --vehicle auto estimated a bike and the road-only result is not confident -> route_search
# runs once more on map/graph_paths (edge_set "paths"), the better result wins. Motorcycle and car never. Everything else is unchanged (same graphs and results).
# If the map with paths exceeds HMM_CAP_GB, the path tiers of osm.bike_tier are given up from the highest (steps_b.fit_tiers).
# OFF by default (go/no-go 2026-11-13, DECISIONS A-B1): Mittenwald '5 Lakes' stayed no_route ~8.5 km off the komoot track with the fallback (tiers <= 1 under
# the memory cap, f_eff 148 outlier), at +50 min route_search; the regress cases are unchanged either way (all road results confident).
BIKE_PATHS_ON = False           # (a) explicit bike profile searches with paths
BIKE_PATHS_FALLBACK = False     # (b) second search with paths for an estimated bike whose road result is not confident
BIKE_PATH_CLASSES = ("cycleway", "path", "track", "service", "footway", "pedestrian", "bridleway")
CLASSES_BIKE_PATHS = CLASSES_BIKE + BIKE_PATH_CLASSES
BIKE_TRACK_GRADES = ("grade1", "grade2", "grade3", "")       # tracktype a bike may use without a bicycle tag ("" = untagged)
BIKE_BAD_SURFACE = ("mud", "sand", "rock", "rocks", "stone", "stones", "scree", "grass", "wood_chips", "ground_rough")
BIKE_MTB_MAX = 1.0                                            # mtb:scale above this needs a bicycle tag
BIKE_TIER_GRADES = ("grade1", "grade2")                      # osm.bike_tier: the tracks given up last
BIKE_TIER_SURFACE = ("asphalt", "paved", "concrete", "paving_stones", "compacted", "fine_gravel")
BIKE_PATH_RULES = "bikepath2"                                 # cache token of osm.way_ok / bike_tier: change it with the rules

# --- driving line
OFFSET_M = {"bike": 1.5, "motorcycle": 1.6, "car": 1.6}
OFFSET_SMOOTH_M = 4.0        # Gaussian on the unwrapped heading
OFFSET_MAX_FRAC = 0.6        # offset never exceeds this fraction of the local radius on the inner side

# --- verdict / status levels (PROVISIONAL)
VERDICT_CONFIDENT_MARGIN = 5.0     # nats per km; dev: bikes 13.1, 14.5, 2.5 (Rousset, partly wrong), Amalfi far 12.2
COVERAGE = (0.85, 0.50)            # usable video share: good >= .85, difficult >= .50, else problem
BIKE_YAW_NOISE = 0.0032            # rad, 4 m grid second-difference sd of the heading track at the reference scale (median of Grimone/Roanne/Rousset: .0017/.0032/.0039)
YAW_RATIO = (3.0, 8.0)             # good < 3x, difficult < 8x, else problem (Amalfi 4.5x)
PEAK_FLAT = (3.0, 1.0)             # nats/km of best minus median surface: good >= 3, difficult >= 1
AREA_RATIO = (1.5, 3.0)            # L_nom x K_HI / bbox diagonal: good <= 1.5, difficult <= 3, else problem

# --- verdict without decoys (PROVISIONAL; default, because the decoy step is off). confident needs ALL of: interior calibration peak (both axes) at >= PEAK_FLAT[0] nats/km above the
# surface median, mean posterior >= .9 with <= 5 % of the time below .5, usable motion >= COVERAGE[0], heading noise < YAW_RATIO[1]. no_route if ANY of: peak at the scan edge and flat
# (< PEAK_FLAT[1]), mean posterior < .5, usable motion < COVERAGE[1]. Everything else: uncertain.
NODECOY = dict(conf_mean=0.9, below_half=0.05, conf_mean_min=0.5)
DECOY_ORDER = ("foreign", "mirror", "foreign+shuffle", "shuffle")   # used when fewer than 19 decoys are requested

# --- area hints (start / end frame, route hint corridor)
START_TOL_M = 150.0        # tolerance of the start / end frame (the first seconds may be gaps)
HINT_BUFFER_M = 300.0      # corridor half-width of a route hint; the app allows 100 m - 2 km
HINT_BUFFER_RANGE = (100.0, 2000.0)
HINT_BRIDGE_MIN_M = 2000.0 # longest road connection added between separate corridor pieces: max(this, 5 buffers)
HINT_FALLBACK_AUTO = "auto"

# --- adaptive calibration grid: if the best cell lies on the edge of the f_eff x kappa grid, extend that edge in log steps of the same ratio, up to the hard limits
F_EXT = (150.0, 900.0)     # hard limits of f_eff
K_EXT = (0.4, 7.0)         # hard limits of the distance scale kappa (lower 0.5 until 2026-11-14, see K_LO)
EXT_STEPS = 2              # new grid rows / columns per extension of an edge
EXT_MAX = 3                # at most this many extension rounds

# --- local pass (start of the refine step): after the route search, the route is decoded again in a corridor around it with ALL drivable road classes
# (residential streets too, which the search map leaves out to stay small) and finer steps, so town junctions and turns close together can be followed.
# FINDINGS "Madone in the app: turn-by-turn check in Menton".
LOCAL_ON = True
LOCAL_BUF_M = 300.0          # corridor half-width around the found route
LOCAL_D0 = 15.0              # nominal step of the local pass (search: D0 = 30); one cell = LOCAL_D0 * kappa m. 10 m fails on a synthetic town: a real turn spreads over 20-30 m of heading, the map junction is a sharp kink
LOCAL_EXTRA = ("residential", "living_street", "road", "unclassified")   # added to the vehicle's search classes
LOCAL_MINOR_NATS_PER_KM = 15.0   # road-class prior of the local pass: cost per km on classes outside the vehicle's search classes
LOCAL_SAME_M = 30.0          # a local route point within this distance of the search route counts as unchanged

# --- standstills (refine step): a gap between two vms tracks whose pairs are mostly well fitted gets its MEASURED distance instead of the mean of the speeds
# around it (a stop at a light was filled with up to 130 m never driven). FINDINGS "Timing in town".
GAP_MEASURED_SHARE = 0.7

# --- damaged / incomplete video (motion step): status video_truncated if the decode ends this much before the duration the file claims
TRUNC_MIN_S = 10.0
# --- verdict when the calibration contradicts the vehicle estimate (route_search, steps_b.motor_posterior): auto said bike, kappa says motor vehicle ->
# posterior for the verdict from the motor roads of the same map, if the route there is the same
VERDICT_MOTOR_POST = True
# --- vehicle from the calibration (steps_b.vehicle_from_calibration: vehicle_final.json and the verdict rule above). Until 2026-11-14 kappa alone (>= 1.5 motor,
# <= 1.3 bike); with the FOE horizon kappa no longer separates them (bench foe1: Amalfi car 1.06 = Rousset / CdP / Pennes bikes), so the real speed
# (90th percentile of the nominal speed x kappa) joins. Dev evidence foe1: bikes kappa 0.80-1.06 and real p90 7.0-9.5 m/s; Madone car 1.73 / 10.8,
# Amalfi car 1.06 / 11.1. PROVISIONAL (8 cases).
VEH_K_MOTOR = 1.3             # motor vehicle if kappa >= this ...
VEH_V90_MOTOR = 10.5          # ... or real p90 speed >= this (m/s)
VEH_K_BIKE = 1.1              # bike if kappa <= this AND ...
VEH_V90_BIKE = 9.8            # ... real p90 speed <= this (m/s); otherwise the estimate stays
VERDICT_MOTOR_SAME = 0.9
TRUNC_FRAC = 0.02

# --- odometry failure handling (all route-side steps, rsm.pipeline.odofail; GOTTHARD_DIAGNOSIS 2.4/2.5, section 7). A stretch where the usable share of the vms
# pairs stays low is a failure (sun ahead, smooth asphalt), not a slow car (a standstill fits well: usable 0.8-0.9): it becomes a gap with a prior from both sides.
ODO_FAIL_ON = True
ODO_FAIL_USABLE = 0.5        # failure: usable share in +-ODO_FAIL_WIN_S below this ...
ODO_FAIL_WIN_S = 5.0
ODO_FAIL_MIN_S = 10.0        # ... for at least this long (runs closer than ODO_FAIL_MERGE_S merged)
ODO_FAIL_MERGE_S = 5.0
ODO_FAIL_RMS_PX = 2.0        # the failure share counts rms-only rejections up to this as usable (the old gate; gating rejects above 0.8 px since 2026-11-17)
ODO_NB_S = 30.0              # failure gap: nominal speed = mean of the good pairs' speeds in this window before and after it
ODO_GAP_MU_X = 1.0           # factor on that speed
ODO_GAP_REL = 0.6            # total relative sd of a failure gap (systematic)
ODO_GAP_UPPER = 2.0          # failure gap: this many times more sub-steps than nominal metres / d0 (reach about 2.4 x this x the prior: wide upper tail)
GAP_SYS_REL = 0.3            # total relative sd of every other gap, independent of the step length (was 0.3 x sqrt(n) per sub-step capped at 1)
ODO_LOW_USABLE = 0.6         # emitting steps with a usable share in +-ODO_LOW_WIN_S below this ...
ODO_LOW_WIN_S = 10.0
ODO_LOW_REL = 1.0            # ... get this relative distance sd (the HMM default is 0.2)

# --- dense heading alignment (refine step): monotone 1-D Viterbi of the 4 m video heading samples against the heading of the FIXED decoded path (smoothed
# across junction nodes), 2 m grid along the path. Its positions in turns (incl. junction kinks) are added as measurements to the smoother.
ALIGN_ON = True
ALIGN_DS = 2.0               # m, grid along the path
ALIGN_SMOOTH_M = 18.0        # m, Gaussian on the path heading (across nodes); dev: stable for 10-30
ALIGN_REL = 0.4              # relative sd of the advance per 4 m nominal sample
ALIGN_SIG0_DEG = 1.5         # emission sd floor (deg) ...
ALIGN_BETA = 0.15            # ... plus this fraction of the path heading change
ALIGN_NU = 3.0               # Student-t
ALIGN_VMAX = 15.0            # m/s, widest advance over an unmeasured gap (at least; 2.5 x the median speed if higher)
ALIGN_MEAS_SD_M = 4.0        # sd of an aligned position as a measurement in the smoother
ALIGN_MEAS_EVERY_M = 20.0    # one measurement per this many metres of path
ALIGN_MAX_DEV_M = 400.0      # the alignment is rejected (old measurements used) if it leaves the HMM route by more than this
ALIGN_TURN_DEG = 30.0        # aligned positions are used as measurements only where the path heading changes by this much ...
ALIGN_TURN_HALF_M = 20       # ... within +- this many metres (on straights the alignment has no heading information)
ALIGN_POST_BAND_M = 150.0    # m, band around the Viterbi path for the alignment posterior (align.band_posterior); 0 = no posterior
ALIGN_MEAS_MODE = "posterior"  # default of `run --align-mode` (app "Kurvenabgleich"): "turns" = measurements only in turns (A7); "posterior" = every
                               # ALIGN_MEAS_EVERY_M where the alignment posterior is narrow, weighted by its sd (A20)
ALIGN_MEAS_MODES = ("posterior", "turns")
ALIGN_POST_FLOOR_M = 3.0     # posterior mode: measurement sd = sqrt(sd_post^2 + floor^2) x ALIGN_POST_INFL ...
ALIGN_POST_INFL = 1.5        # ... (neighbouring samples share the same heading evidence, so each is inflated)
ALIGN_POST_MAX_SD_M = 5.0    # ... and dropped if the posterior sd itself is larger: a straight, no heading information (Roanne valley 8-12 m and 7 m late;
                             #     the gentle curves of Madone 4-6 m)
ALIGN_POST_GATE_M = 60.0     # ... and dropped if the alignment is this far from the HMM route

# --- posterior on straights (refine step, Fable fix 3): on a straight the cell posterior carries no heading information; thinned and inflated there so the
# distance factor rho keeps the value of the last curve instead of being pulled back to the global kappa
POST_STRAIGHT_EVERY_M = 200.0   # one posterior measurement per this many metres of straight path (0 = off: every step as before)
POST_STRAIGHT_INFL = 2.0        # sd factor of those measurements
FUSE_SHAPE_STEPS = True        # fusion: inside a step the distance follows the vms track's own time profile (steps_c.shaped_D), not a straight line in time

# --- calibration candidates (route search; PROVISIONAL). A cell of the f_eff x kappa scan is physically implausible if the video would need more lateral
# acceleration or speed there than a road vehicle has. Dev evidence: the five true calibrations (Roanne, Pontaix, Amalfi, Madone with and without start frame)
# have a 95th percentile of 0.4 to 2.1 m/s2 and a 99th percentile of the speed of 9 to 14 m/s; the Madone runaway (f_eff 148, kappa 6.6) has 9 m/s2 and 31 m/s.
CAL_ALAT_MAX = 5.0         # m/s2, 95th percentile of |yaw rate x speed| over 20 m of track
CAL_VMAX = 45.0            # m/s, 99th percentile of the speed (same for all vehicles: the vehicle guess is only a soft prior)
CAL_N_CAND = 3             # at most this many calibration candidates are decoded, and the others only if the first is not confident

# --- refine additions of the accuracy work (2026-11-12; PROVISIONAL, evidence in FINDINGS "Regression bench")
# A2 (heading range instead of net turn in the alignment) was measured and NOT shipped: no change on any case, Madone roundabout still 8.7 s (FINDINGS)
# more road classes for the open parts of the island refinement (islands.py, LOCAL_ISL_* below)
LOCAL_EXT_CLASSES_MOTOR = ("residential", "living_street", "road", "unclassified", "service", "pedestrian")
LOCAL_EXT_CLASSES_BIKE = ("service", "pedestrian", "track", "cycleway", "path", "footway")
LOCAL_EXT_MIN_S = 10.0        # open parts shorter than this are not re-decided
LOCAL_EXT_BUF_M = 500.0       # a bridge searches within this distance of the search and local routes
LOCAL_EXT_NATS_PER_KM = 15.0  # extra road-class prior on the classes added here (on top of LOCAL_MINOR_NATS_PER_KM)
# island refinement (islands.py, GOTTHARD_DIAGNOSIS 4 / 7): islands stay, bridges and tails are re-decided with the LOCAL_EXT classes; uses LOCAL_EXT_* above
LOCAL_ISL_ON = False
LOCAL_ISL_CONF = 0.9          # island: local posterior at least this ...
LOCAL_ISL_USABLE = 0.5        # ... odometry usable share (+-ODO_LOW_WIN_S) at least this (concept: 0.8; Gotthard HDR has 0.5-0.6 on the whole valley road at posterior 1.0) ...
LOCAL_ISL_MIN_LM = 2          # ... and at least this many turn landmarks ...
LOCAL_ISL_CURVE_M = 300.0     # ... or this much curved road (steps turning by >= LOCAL_ISL_CURVE_DEG)
LOCAL_ISL_CURVE_DEG = 3.0
LOCAL_ISL_REACH_X = 1.5       # tail: free end searched within nominal distance x kappa x this of the anchor ...
LOCAL_ISL_REACH_MAX_M = 6000.0  # ... at most this far
LOCAL_ISL_K = 3               # diverse alternatives per part (besides search, local and the free decode) ...
LOCAL_ISL_ALT_WIN = 0.3       # ... each avoiding the roads of the routes found before during this share of the part
LOCAL_ISL_SHAPE_REL = 1.0     # one more hypothesis decoded with this relative distance sd on every step (the turns choose the roads)
LOCAL_ISL_SCALES = (0.7, 0.85, 1.0, 1.2, 1.45, 1.75)   # distance scale of a part (profiled), relative to kappa
LOCAL_ISL_SCALE_SD = 0.3      # log-normal prior on that scale
LOCAL_END_TOL_M = 300.0       # the local pass starts within this distance of the start of the search route (0 = free, as before)
# Acceptance test of the local pass (Gotthard diagnosis, docs/GOTTHARD_DIAGNOSIS.md): where the local route leaves the search route for at least
# LOCAL_ACCEPT_MIN_S, it is kept only if it leaves no more strong turns of the video unexplained than the search route AND beats the search route
# (local decode forced along it) by LOCAL_ACCEPT_NATS; otherwise the local pass follows the search route there and the stretch is marked uncertain.
LOCAL_ACCEPT_ON = True
LOCAL_ACCEPT_MIN_S = 30.0     # shorter differences (junction fixes, roundabouts, parallel streets) are not tested
LOCAL_ACCEPT_NATS = 5.0       # score margin the local route needs over the search route in a tested stretch
LOCAL_ACCEPT_R_M = 60.0       # the forced decode stays within this distance of the search route (every second local step)
LOCAL_KEPT_CONF = 0.5         # confidence cap on a stretch where the search route was kept against the local pass
LM_MIN_DEG = 45.0             # turn landmark: heading change of the video of at least this much ...
LM_WIN_M = 60.0               # ... within this real distance (nominal window = LM_WIN_M / kappa)
LM_TOL_DEG = 35.0             # a route explains a landmark if its road turns by the same angle within max(LM_TOL_DEG, LM_TOL_REL x angle)
LM_TOL_REL = 0.35
LM_EXT_M = 30.0               # the road turn is also measured over a window grown by this much on both sides (timing of the step)
PRIOR_DECIDED_CONF = 0.5      # A3: confidence cap where only the road-class prior chose between two parallel streets
PRIOR_DECIDED_MIN_S = 5.0     # A3: shorter differences between the decode with and without the prior are not reported
PRIOR_DECIDED_SAME_M = 10.0   # A3: the two decodes differ where they are farther apart than this (parallel streets are 15 to 40 m apart; LOCAL_SAME_M = 30 missed Madone)

# --- lane model (driving line L1, rsm.pipeline.lane; PROVISIONAL: European practice, corrected towards the P16 medians; a model, never a measurement)
LANE_WIDTH_DEFAULT = {"motorway": 7.5, "trunk": 7.5, "primary": 7.0, "secondary": 6.0, "tertiary": 5.5, "unclassified": 4.0, "residential": 5.0, "living_street": 4.0,
                      "service": 3.5, "track": 3.0, "roundabout": 7.0, "oneway": 3.5, "other": 4.0}   # m carriageway; *_link uses its base class unless listed
LANE_WIDTH_DEFAULT.update({"motorway_link": 4.0, "trunk_link": 4.0, "primary_link": 4.0, "secondary_link": 4.0, "tertiary_link": 4.0})
LANE_WIDTH_DEFAULT.update({"cycleway": 2.5, "path": 2.0, "footway": 2.0, "bridleway": 2.0, "pedestrian": 5.0})   # bike-path classes (BIKE_PATHS_ON)
LANE_LANE_W = {"motorway": 3.75, "trunk": 3.75, "primary": 3.5, "secondary": 3.25, "other": 3.0}    # m per lane when only `lanes` is tagged
LANE_SD_M = (0.5, 0.7, 1.2)      # sd of the lateral position: tagged width, lanes, class default (P16: +-1.2 m)
LANE_NARROW_M = 4.5              # two-way roads narrower than this have no own half for motor vehicles
LANE_MARGIN_M = {"bike": 0.6, "motorcycle": 0.8, "car": 1.2}   # vehicle centre to the road edge, at least
LANE_BIKE_EDGE_M = (0.9, 0.6)    # bike: distance from the own edge (roads >= 4 m, narrower roads)
LANE_BIKE_CYCLELANE_M = 0.75     # bike on a painted cycle lane: its centre from the edge
LANE_MOTO_SHIFT_M = 0.3          # motorcycle: towards the road centre from the car's lane centre
LANE_RAMP_M = 30.0               # transitions between edges ramp over this length
LINE_DEFAULT = "fixed"           # FROZEN 2026-11-13 (maintainer): driving-line work stopped, default unchanged. --line auto resolves to this layer ("model" = L1 lane model [+ L2 if LINE_L2_ON], "fixed" = the old constant offset)
# --- driving line layer L2 (offset.solve_line; PROVISIONAL, a model of how people ride; shipped only if the GPS bend test V3 passes, FINDINGS "Driving line")
LINE_L2_ON = False           # set after the V3 test
LINE_A_REF = 2.0             # m/s2: lateral acceleration scale of the curvature weight
LINE_W_P = 1.0               # 1/m2: pull towards the preferred lane position (0.1 gave slow, ill-conditioned solves with ramps of 200 m; dev synthetic bend)
LINE_W_D1 = 0.01             # smoothness of d
LINE_KINK_HALF_M = 15.0      # junction kinks: heading change over +- this ...
LINE_KINK_DEG = 30.0         # ... at least this -> the lane pull is lowered (the line rounds the corner)
LINE_KINK_WP_FACTOR = 0.3
LINE_MAX_ITER = 3000         # ADMM iterations of the solver (at most) ...
LINE_TOL_M = 1e-4            # ... until x and z agree to this
LINE_ADMM_RHO = 1.0          # ADMM penalty

# --- Bavaria fixes F1/F2/F3/F5 (2026-11-13, docs/BAVARIA_DIAGNOSIS.md "Fixes"; PROVISIONAL). Overrides of the bike-path block above are made here (append-only file).
# F1: `run --bike-paths off|on|fallback` (params key `bike_paths`). on = CLASSES_BIKE_PATHS is the search map of a bike (explicit or estimated); fallback = a second
# route_search with paths when the road result is not confident; off = roads only. Without the option the flags BIKE_PATHS_ON (explicit bike) / BIKE_PATHS_FALLBACK
# (estimated bike) above decide, as before. Motorcycle and car never get paths.
BIKE_PATHS_MODES = ("off", "on", "fallback")
# F3: `service` ways without a bicycle tag enter the PATH maps (never the road set, which has no service class) unless closed (access / vehicle no|private, as for
# every path class) or a car-park / drive-through / driveway / emergency lane. Bavaria: 1.65 km of the loop, mostly motor_vehicle=agricultural;forestry.
BIKE_SERVICE_UNTAGGED = False   # NO-GO 2026-11-13: hint-corridor clip run confident -> uncertain with it (docs/BAVARIA_DIAGNOSIS.md "Fixes")
BIKE_SERVICE_EXCLUDED = ("parking_aisle", "drive-through", "driveway", "emergency_access")
BIKE_PATH_RULES = "bikepath3" if BIKE_SERVICE_UNTAGGED else "bikepath2"   # cache token of osm.way_ok (overrides the value above)
# F2: speed limit of the calibration plausibility check for a bike (vehicle estimate or explicit profile): 99th percentile of the speed at most this. The dev bikes
# have 9-14 m/s at their true calibration; Bavaria's runaway corner (f_eff 148, kappa 2.0) needs 26 m/s. Motorcycle / car keep CAL_VMAX.
CAL_VMAX_BIKE_ON = 20.0          # the tested value
CAL_VMAX_BIKE = CAL_VMAX         # NO-GO 2026-11-13 (off): no change on the Bavaria clip; switch on with CAL_VMAX_BIKE_ON
# F5: the base kappa scan of a bike starts one grid step lower (K_LO / step ratio = 0.65): the Bavaria clip's true kappa is 0.75-0.8, at the old lower edge. The column
# is scanned only if its HMM arrays fit HMM_CAP_GB (the map's memory pre-check stays at K_LO). Motorcycle / car: K_GRID as before.
K_GRID_BIKE_ON = (K_LO / (K_GRID[1] / K_GRID[0]),) + K_GRID   # the tested grid
K_GRID_BIKE = K_GRID             # NO-GO 2026-11-13 (off): no gain on the clip, chose k 0.65 wrongly in the corridor+fallback run

# --- scene cuts (F4, 2026-11-13; PROVISIONAL, evidence: Bavaria '5 Lakes' 10 of 10 reference cuts, docs/BAVARIA_DIAGNOSIS.md; rsm.pipeline.cuts, PIPELINE_CLI "Cuts")
CUT_ON = True               # off: no cut is detected or handled (every gap is continuous riding, as before)
CUT_IMPULSE = 2.0           # a cut pair's frame difference over the largest of the +-3 pairs around it (a cut changes ONE pair; bumps, flashes, pans several)
CUT_INL_SHARE = 0.25        # model cue: the pair keeps fewer than this share of the median inliers around it (vms road flow or far-feature rotation)
# strong-impulse gate (user, 2026-11-16; Cayolle HDR intro cuts 0:41.67 / 0:49.25, Clue du Pérouré 0:50.33; tests/test_cuts.py): a hard cut can stay under the
# main spike gate (gating's cut flag: 4 x the running median and 25) when the shot before it is busy (Clue 50.33: ratio 2.6, impulse 2.4) or the jump is
# moderate (Cayolle 49.25: 24.8). It is still a candidate when the road-flow fit COLLAPSES at exactly that pair: fewer than cuts.MIN_INLIERS points there,
# at least CUT_STRONG_AROUND inliers around it (a well-fitting ride) and every pair of the +-3 around it keeps CUT_STRONG_NB_SHARE of that (a flash or a bump
# breaks several pairs: Gotthard HDR 40:00 neighbours at 11 %). The same-scene veto still decides. Chosen against a variant with impulse/ratio 3 (misses
# Clue) and one without the neighbour test (keeps the Gotthard flash out only by 98.5 < 100 inliers around): measured on all motion.csv, PIPELINE_CLI "Cuts".
CUT_STRONG_IMPULSE = 2.3    # over the largest of the +-3 pairs around it (main gate: CUT_IMPULSE)
CUT_STRONG_FACTOR = 2.3     # over its running median (main gate 4)
CUT_STRONG_MIN_DIFF = 15.0  # absolute frame difference (main gate 25)
CUT_STRONG_AROUND = 100.0   # median road-flow inliers of the +-25 pairs around it
CUT_STRONG_NB_SHARE = 0.2   # each of the +-3 pairs around it keeps at least this share of CUT_STRONG_AROUND's median
CUT_MERGE_S = 0.5           # cut pairs closer than this are one cut
CUT_MIN_PIECE_S = 20.0      # a piece between two cuts shorter than this is an inserted shot (title, close-up): dropped
CUT_INTRO_S = 120.0         # start rule (maintainer): cuts in the first CUT_INTRO_S s -> the route starts after the last of them
CUT_JUMP_M = 1500.0         # a cut is bridged by a free jump forward along the graph of up to about this many nominal metres (2 cells per sub-step)
CUT_PRIOR_SD_SOFT_M = 400.0 # the soft stay prior (half-normal along the graph, sd in m nominal x kappa): ORIGIN UNEXPLAINED (an edit of the F4 work nobody can account for,
                            # docs/DECISIONS.md A13); kept as an option and as the way back (set CUT_PRIOR_SD_M = CUT_PRIOR_SD_SOFT_M). Cost of a jump of d m: d^2 / (2 sd^2) nats
CUT_PRIOR_SD_M = 1.0e5      # MAINTAINER DECISION 2026-11-13: FLAT jump (sd >> CUT_JUMP_M: every start up to about CUT_JUMP_M forward costs the same). Bavaria clip:
                            # flat 84 % within 30 m / median 3 m, soft (400) 21 % / 188 m; Amalfi identical. 0 would force the same place.
CUT_FUSE_SD_M = 1.0e5       # smoother: sd of the position jump across a cut (no distance prior)
# same-scene veto (user, 2026-11-16: "the frame before and after the cut should be easily detected as very similar"; a jump needs a higher bar). A confirmed
# cut is decoded once more: the frame before its jump pair and the frame after it, brightness-normalised, points tracked (LK, forward-backward) and fitted
# by one similarity (RANSAC). If at least CUT_SAME_SHARE of the corners fit, it is the same scene (a sun flash / exposure jump): NOT a cut.
# Measured (LK share): Gotthard HDR sun flashes 3:12 0.46, 3:14 0.38; real cuts Bavaria (12 pairs) <= 0.09 (5421.76 s, cut to another forest track),
# Amalfi 4 and Gotthard / Madone intro 0.00.
CUT_SAME_ON = True
CUT_SAME_SHARE = 0.2
CUT_SAME_WIN_S = 0.12       # frames decoded +- this around the cut; the jump pair is the largest frame difference in it
CUT_SAME_H = 270            # rows of the decoded grey frames (width 16:9 x this)

# --- sure standstill (standstill.py, work/standstill): the camera stands while other vehicles pass. Detected at the end of rotation, used by every
# route-side step (odofail.build: the tracks are split there, the gap gets a measured ~0 distance and far-only heading) and by the fusion of refine (the position
# is HELD inside a span: no distance, no measurements). PROVISIONAL: thresholds from 306 labelled windows of four videos (Amalfi, Verdon, Gotthard, Bavaria),
# P 0.94 / R 0.98, no held-out video yet.
STILL_ON = True
STILL_WIN_S = 0.5            # decision windows
STILL_GATE_REL = 0.4         # candidate: median vms rel_speed of the window below this x the video median (also 0: vms itself says standing) ...
STILL_GATE_FAR = 0.005       # ... and the far-only heading change of the window below this (track units; no far fit counts as 0)
STILL_BASE_S = 0.3           # cell test: frame pairs this far apart (0.1 s: slow creep looks static; 0.5 s: passing objects cost recall)
STILL_NPAIR = 3              # pairs per window (start, +1/6 s, +2/6 s), median of their shares
STILL_THR_PX = 0.35          # a track fits "camera only sways / turns" (global similarity, RANSAC) within this, px at 360 rows
STILL_GRID = (8, 6)          # cells (x, y); a cell with >= 3 tracks is STATIC when >= STILL_CELL_SHARE of them fit
STILL_CELL_SHARE = 0.6
STILL_ALL = 0.5              # sure standstill: share of static cells >= this over the frame ...
STILL_UP = 0.75              # ... and >= this above the vms horizon (buildings, trees, sky line carry the signal)
STILL_MIN_S = 1.0            # spans shorter than this are dropped
STILL_EDGE_S = 2.0           # every window within this of a candidate run's ends is tested; inside a longer run one window every STILL_SAMPLE_S
STILL_SAMPLE_S = 5.0

# --- speed (2026-11-16): the motion step spreads its frame pairs over resources.policy() workers (<= MAX_WORKERS) in chunks of vmsx.motion.CHUNK_S with one
# ffmpeg seek each; motion.csv is byte-identical (overlap frames checked by hash, sequential fallback). Not part of the motion hash: same result.
# Col de la Cayolle, 98 min 1080p50 AV1: 1429 s sequential, 640 s with 4 workers (2.2x).
MOTION_PARALLEL = True
