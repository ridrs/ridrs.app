# SPDX-License-Identifier: AGPL-3.0-or-later
"""python -m rsm.pipeline run|retime  (and the internal _step / _memguard used for the worker subprocesses). Progress protocol: JSON lines on stdout (PIPELINE_CLI.md)."""
from __future__ import annotations

import argparse
import json
import os
import shutil
import signal
import subprocess
import sys
import time
from pathlib import Path

from . import VERSION, config as C
from .common import Worker, code_hash, emit, frozen_info, file_sig, jdump, jload, sha
from rsm.odometry.gating import GateParams as _GP
from rsm.pipeline.vmsx import extract as EX_ALT, interpret as VI_ALT, motion as M_ALT

GP_DEFAULT = _GP()    # the gate the steps use (rsm.odometry.gating): its rms limit decides which pairs make the tracks (rotation step on)

EXIT = dict(ok=0, internal=1, args=2, resource=3, data=4, cancelled=130)
SELF_CMD = [sys.executable] if getattr(sys, "frozen", False) else [sys.executable, "-m", "rsm.pipeline"]


def parse_args(argv):
    ap = argparse.ArgumentParser(prog="rsm.pipeline", description="video + area -> GPX")
    sub = ap.add_subparsers(dest="cmd", required=True)
    r = sub.add_parser("run")
    r.add_argument("--video", required=True)
    r.add_argument("--bbox", required=True, help="S,W,N,E in degrees")
    r.add_argument("--pbf", required=True, help="local .osm.pbf (Geofabrik extract) covering the bbox")
    r.add_argument("--out", required=True)
    r.add_argument("--vehicle", default="auto", choices=["auto", "bike", "motorcycle", "car"])
    r.add_argument("--offset-m", type=float, default=None, help="lateral driving-line offset (default: bike 1.5, car/motorcycle 1.6 m; one-way roads 0)")
    r.add_argument("--start-time", default=None, help="ISO 8601 time of video second 0 (default 2000-01-01T00:00:00Z)")
    r.add_argument("--traffic-side", default="auto", choices=["auto", "left", "right"])
    r.add_argument("--decoys", type=int, default=0, help="number of decoys for the plausibility test, 0 = off (default, step skipped), 19 = the full test")
    r.add_argument("--start-bbox", default=None, help="S,W,N,E of the start frame: the route must begin inside it (hard constraint, tolerance --start-tol-m)")
    r.add_argument("--end-bbox", default=None, help="S,W,N,E of the end frame: the route must end inside it")
    r.add_argument("--start-tol-m", type=float, default=C.START_TOL_M, help="tolerance of the start / end frame in m (default 150)")
    r.add_argument("--hint", default=None, help="route hint: .gpx (track or route) or .kml (LineString, gx:Track); only roads within --hint-buffer-m of it are used")
    r.add_argument("--hint-buffer-m", type=float, default=C.HINT_BUFFER_M, help="corridor half-width in m (default 300)")
    r.add_argument("--hint-fallback", default="auto", choices=["auto", "off"], help="auto: rerun route_search on the full search frame if the corridor result is poor")
    r.add_argument("--bike-paths", default=None, choices=list(C.BIKE_PATHS_MODES),
                   help="cycleways, paths and tracks for a bike: off = roads only, on = in the search map, fallback = a second search with them when the road result is "
                        "not confident (default: the config flags, today off)")
    r.add_argument("--align-mode", default=None, choices=list(C.ALIGN_MEAS_MODES),
                   help="how the dense heading alignment pins the time in refine: posterior = wherever it is sure (weighted), turns = only in turns >= 30 deg "
                        f"(default {C.ALIGN_MEAS_MODE})")
    r.add_argument("--anchors", default=None, help="user anchors: JSON file (or inline JSON) of [{t: video s, bbox: [S,W,N,E]}]; the camera is inside the frame at t (anchors.py)")
    r.add_argument("--intro-end", type=float, default=None, help="video second at which the intro ends, set by hand: replaces the intro found from the scene cuts "
                                                                  "(the route starts after it; app: \"Intro-Ende hier setzen\")")
    r.add_argument("--resume", action="store_true")
    r.add_argument("--from-step", default=None, choices=C.STEPS, help="with --resume: reuse the results of the steps before this one as they are and rerun it and all later steps")
    sub.add_parser("version")
    x = sub.add_parser("export", help="Incyclist GPX (trim, elevation) + JSON summary of a finished run")
    x.add_argument("--out", required=True, help="the finished run directory")
    x.add_argument("--dest", required=True, help="the GPX to write")
    x.add_argument("--summary", required=True, help="the JSON summary to write")
    x.add_argument("--dem-dir", default=None, help="directory of the Copernicus GLO-30 tiles (default RSM_DEM_DIR; none = no elevation)")
    x.add_argument("--trim", default="auto", choices=["auto", "off"])
    x.add_argument("--start-time", default=None, help="ISO time of video second 0; default: the first exported point is 2000-01-01T00:00:00Z")
    x.add_argument("--fps", type=float, default=None, help="exact video frame rate (for the start frame)")
    x.add_argument("--title", default=None)
    x.add_argument("--link", default=None)
    x.add_argument("--app-version", default=None)
    pr = sub.add_parser("profile", help="elevation profile along the whole decoded path (for the app's playback view)")
    pr.add_argument("--out", required=True, help="the finished run directory")
    pr.add_argument("--dest", required=True, help="the JSON to write")
    pr.add_argument("--dem-dir", default=None, help="directory of the Copernicus GLO-30 tiles (default RSM_DEM_DIR)")
    for nm, hl in (("dem-plan", "which extra elevation blocks (national / regional DEMs, Copernicus fill mask) the route needs, and their size (offline)"),
                   ("dem-fetch", "download the missing extra elevation blocks for the route (progress as JSON lines)")):
        q = sub.add_parser(nm, help=hl)
        q.add_argument("--out", required=True, help="the finished run directory")
        q.add_argument("--dem-dir", default=None, help="the DEM directory (Copernicus tiles at the top, extra sources in sub-directories; default RSM_DEM_DIR)")
        q.add_argument("--sources", default=None, help="comma-separated source names (default: every enabled, verified source; see demsrc.SOURCES)")
    ins = sub.add_parser("inspect-series", help="per-second series of a finished run (speed, rotation, curvature video vs map, quality) and its weak stretches with causes; read only")
    ins.add_argument("--out", required=True, help="the finished run directory")
    ins.add_argument("--dest", default=None, help="the JSON to write (default: OUT/inspect/series.json)")
    ins.add_argument("--window-m", type=float, default=None, help="curvature window in metres (default 30)")
    inf = sub.add_parser("inspect-frame", help="the points tracked for the frame pair and the far-feature window at video time T (motion / rotation overlay); read only")
    inf.add_argument("--out", required=True, help="the finished run directory")
    inf.add_argument("--t", required=True, type=float, help="video time in seconds")
    inf.add_argument("--video", default=None, help="the video (default: the one of the run)")
    inf.add_argument("--what", default="motion,rotation", help="comma-separated parts: motion, rotation")
    t = sub.add_parser("retime")
    t.add_argument("dir")
    t.add_argument("--start-time", required=True)
    rr = sub.add_parser("reroute", help="reroute a finished run through user-dragged waypoints (start/end/vias) and fit the timeline")
    rr.add_argument("--out", required=True, help="the finished run directory")
    rr_g = rr.add_mutually_exclusive_group(required=True)
    rr_g.add_argument("--waypoints", default=None, help="JSON file or inline JSON: {start, end, vias}")
    rr_g.add_argument("--reset", action="store_true", help="restore the original detected route before manual edits")
    s = sub.add_parser("_step")
    s.add_argument("step")
    s.add_argument("--dir", required=True)
    return ap.parse_args(argv)


# ------------------------------------------------------------------ worker side
def worker_main(step: str, d: Path) -> int:
    from . import steps_a, steps_b, steps_c, steps_d
    fn = dict(motion=steps_a.motion, rotation=steps_a.rotation, map=steps_b.map_step, route_search=steps_b.route_search, plausibility=steps_b.plausibility,
              refine=steps_c.refine, gpx=steps_d.gpx_step)[step]
    W = Worker()
    P = jload(d / "project.params.json")
    try:
        res = fn(d, P, W)
        emit({"type": "summary", "summary": res})
        return 0
    except MemoryError as e:
        emit({"type": "log", "level": "error", "message": f"memory: {e}"})
        return EXIT["resource"]
    except (FileNotFoundError, RuntimeError) as e:
        emit({"type": "log", "level": "error", "message": f"{type(e).__name__}: {e}"})
        return EXIT["data"]
    except Exception as e:  # noqa: BLE001
        import traceback
        emit({"type": "log", "level": "error", "message": f"{type(e).__name__}: {e}"})
        traceback.print_exc(file=sys.stderr)
        return EXIT["internal"]


# ------------------------------------------------------------------ parent side
def horizon_first(a, d: Path) -> str:
    """the horizon of the first pass: the chosen vehicle's; for --vehicle auto the running one (A24), or on --resume the one the run last used"""
    from .calib import horizon_mode
    if a.vehicle != "auto":
        return horizon_mode(a.vehicle)
    prev = d / "project.params.json"
    if a.resume and prev.exists():
        return jload(prev).get("horizon", "running")
    return "running"


class Run:
    def __init__(self, a):
        self.a = a
        self.d = Path(a.out).resolve()
        self.proc = None
        self.cancelled = False

    def step_event(self, sid, i, state, pct=None, eta=None, reused=False):
        e = {"type": "step", "id": sid, "index": i, "of": len(C.STEPS), "state": state}
        if reused:
            e["reused"] = True                   # the result of an earlier run was reused (resume)
        if pct is not None:
            e["pct"] = round(pct, 1)
        if eta is not None:
            e["eta_s"] = int(eta)
        emit(e)

    def hashes(self, P):
        from . import anchors as AN
        from . import align as AL
        from .hints import cost_hash_part as HI_COST
        from .hints import frame_cost_hash_part as HI_FRAMES
        h, prev = {}, ""
        hint_map = [["hint", P["hint_hash"], P["hint_buffer_m"]]] if P.get("hint") else []
        cons = [["frames", P.get("start_bbox"), P.get("end_bbox"), P["start_tol_m"]]] if (P.get("start_bbox") or P.get("end_bbox")) else []
        cons += [["fallback", P["hint_fallback"]]] if P.get("hint") else []
        bike_cal = [["bike_cal", C.CAL_VMAX_BIKE, C.K_GRID_BIKE]] if (C.CAL_VMAX_BIKE != C.CAL_VMAX or C.K_GRID_BIKE != C.K_GRID) else []   # F2/F5 only when switched on
        bp = P.get("bike_paths")                 # F1: only a run with bike paths gets a new map hash (off and the default keep the old one while the config flags are off)
        paths_map = [["bike_paths", bp, C.BIKE_PATH_RULES]] if bp in ("on", "fallback") or (bp is None and (C.BIKE_PATHS_ON or C.BIKE_PATHS_FALLBACK)) else []
        decoy_map = [["decoys_map1"]] if int(P.get("decoys", 0)) > 0 else []
        odo = [["odo1", C.ODO_FAIL_USABLE, C.ODO_FAIL_WIN_S, C.ODO_FAIL_MIN_S, C.ODO_FAIL_MERGE_S, C.ODO_NB_S, C.ODO_GAP_MU_X, C.ODO_GAP_REL, C.ODO_GAP_UPPER, C.GAP_SYS_REL,
                C.ODO_LOW_USABLE, C.ODO_LOW_WIN_S, C.ODO_LOW_REL]] if C.ODO_FAIL_ON else []
        odo += [["vmp2", C.VEH_K_MOTOR, C.VEH_V90_MOTOR, C.VEH_K_BIKE, C.VEH_V90_BIKE, C.VERDICT_MOTOR_SAME]] if C.VERDICT_MOTOR_POST else []   # verdict posterior on the motor roads (steps_b.motor_posterior)   # odometry failure handling (odofail.py): all route-side steps
        ext = [["isl1", C.LOCAL_EXT_CLASSES_MOTOR, C.LOCAL_EXT_CLASSES_BIKE, C.LOCAL_EXT_MIN_S, C.LOCAL_EXT_BUF_M, C.LOCAL_EXT_NATS_PER_KM, C.LOCAL_ISL_CONF, C.LOCAL_ISL_USABLE,
                C.LOCAL_ISL_MIN_LM, C.LOCAL_ISL_CURVE_M, C.LOCAL_ISL_CURVE_DEG, C.LOCAL_ISL_REACH_X, C.LOCAL_ISL_REACH_MAX_M, C.LOCAL_ISL_K, C.LOCAL_ISL_ALT_WIN, C.LOCAL_ISL_SHAPE_REL, C.LOCAL_ISL_SCALES,
                C.LOCAL_ISL_SCALE_SD]] if C.LOCAL_ISL_ON else []   # island refinement with more road classes (islands.py): refine on only
        bridge = [["bridge_rot1", C.ROT_BRIDGE_MIN_VALID]] if C.ROT_BRIDGE_ON else []   # heading across vms speed gaps (odofail.build): all route-side steps
        still = [["still1", C.STILL_WIN_S, C.STILL_GATE_REL, C.STILL_GATE_FAR, C.STILL_BASE_S, C.STILL_NPAIR, C.STILL_THR_PX, C.STILL_GRID, C.STILL_CELL_SHARE, C.STILL_ALL,
                   C.STILL_UP, C.STILL_MIN_S, C.STILL_EDGE_S, C.STILL_SAMPLE_S]] if C.STILL_ON else []   # sure standstill (standstill.py): detected in rotation, held in refine
        parts = dict(motion=[file_sig(P["video"]), C.VMS, C.F360, "motion2", "pick_rel1", M_ALT.ALT_TRIGGER_REL, "alt_thr_rel1", M_ALT.ALT_NOISE_REF, M_ALT.ALT_THR_SLOPE,
                             ["hz_run1", M_ALT.HZ_EVERY, M_ALT.HZ_WINDOW, M_ALT.HZ_SPAN, M_ALT.HZ_MIN_FOES, M_ALT.HZ_MAX_DEV], ["hz_gate1", M_ALT.HZ_GATE_SPAN],
                             *([["extract1", EX_ALT.VERSION, EX_ALT.params(), VI_ALT.params()]] if C.MOTION_FROM_EXTRACT else []),
                             *([["hz_fixed1"], ["hz_spread1", C.HZ_SPREAD_IQR]] if P.get("horizon", "running") != "running" else [])],
                     rotation=[C.FAR, C.F_FAR, C.F_REF, "rotation2", C.ROT_BAND_OFF_VMS,
                               *([["rot_extract1", VI_ALT.params()]] if (C.MOTION_FROM_EXTRACT and C.ROT_FROM_EXTRACT) else []),
                               *([["a25", C.X0_MIN_S, C.X0_MAX_RMS, C.X0_MIN_PAIRS]] if C.ROT_X0_ROAD else []), ["gate_rms_rel1", GP_DEFAULT.max_rms_px, GP_DEFAULT.max_rms_rel],
                               *([["same1", C.CUT_SAME_SHARE, C.CUT_SAME_WIN_S, C.CUT_SAME_H]] if (C.CUT_ON and C.CUT_SAME_ON) else []),
                               *([["intro_user1", P["intro_end"]]] if P.get("intro_end") is not None else []),
                               *([["strong2", C.CUT_STRONG_IMPULSE, C.CUT_STRONG_FACTOR, C.CUT_STRONG_MIN_DIFF, C.CUT_STRONG_AROUND, C.CUT_STRONG_NB_SHARE]] if C.CUT_ON else []),
                               *([["cuts4", C.CUT_CAND_FACTOR, C.CUT_CAND_MIN_DIFF, C.CUT_CAND_IMPULSE, C.CUT_CAND_DROP_IMPULSE, C.CUT_CAND_DROP_DIFF, C.CUT_CAND_DROP_AROUND,
                                   C.CUT_CAND_ROAD_MIN_S, C.CUT_CAND_ROAD_MAX_S, C.CUT_CAND_ROT_PTS_SHARE, C.CUT_CAND_ROT_PTS_MIN_MED, C.CUT_CAND_ROT_INL_SHARE,
                                   C.CUT_CAND_ROT_INL_MIN_MED, C.CUT_CAND_ROT_MAX_S, C.CUT_CAND_MERGE_S, C.CUT_DEDUP_S, C.CUT_TRANS_HALF_S, C.CUT_TRANS_FPS, C.CUT_TRANS_H,
                                   C.CUT_HARD_WIN_S, C.CUT_HARD_MIN_DIFF, C.CUT_HARD_IMP_MED, C.CUT_HARD_IMP_MAX, C.CUT_FADE_MAX_STD, C.CUT_FADE_DARK_MEAN, C.CUT_FADE_BRIGHT_MEAN,
                                   C.CUT_DISS_MIN_DIFF, C.CUT_DISS_MAX_EDIP, C.CUT_DISS_MAX_DEVC, C.CUT_DISS_MAX_DEVA, C.CUT_DISS_MIN_CGCOS, C.CUT_DISS_MIN_BOTHP,
                                   C.CUT_DISS_MAX_AIQR, C.CUT_DISS_MAX_PAN_PX, C.CUT_DISS_MIN_BIDIR, C.CUT_DISS_MIN_MEAN]] if (C.CUT_ON and C.CUT_TRANS_ON) else []), *still],
                     map=[P["bbox"], file_sig(P["pbf"]), P["vehicle"], C.CLASSES_BIKE, C.CLASSES_MOTOR, C.HMM_CAP_GB, "map1", *hint_map, *paths_map, *decoy_map],
                     route_search=[C.F_GRID, C.K_GRID, C.REFINE_K, C.REFINE_F, C.H, "search1", C.CUT_PRIOR_SD_M, *(["free_jump1"] if C.CUT_FREE_JUMP else []), *cons, *bike_cal, *odo, *bridge, *AN.hash_part(P), *HI_COST(P), *HI_FRAMES(P)],
                     plausibility=[C.N_FOREIGN, C.N_SHUFFLE, C.SEED0, C.VERDICT_CONFIDENT_MARGIN, P["decoys"], "plaus1"],
                     refine=["refine4", "bridge1", "bikepath_free1", *HI_COST(P), *(["hold1"] if C.STILL_ON else []), *(["shape1"] if C.FUSE_SHAPE_STEPS else []), *([["align_post1", C.ALIGN_POST_BAND_M, C.ALIGN_POST_FLOOR_M, C.ALIGN_POST_INFL, C.ALIGN_POST_MAX_SD_M, C.ALIGN_POST_GATE_M]] if AL.meas_mode(P) == "posterior" else []), "raster1", C.GPX_HZ, C.LOCAL_MINOR_NATS_PER_KM, C.LOCAL_ON, C.LOCAL_BUF_M, C.LOCAL_D0, C.LOCAL_EXTRA, C.LOCAL_SAME_M, file_sig(P["pbf"]), C.GAP_MEASURED_SHARE, C.ALIGN_ON, C.ALIGN_DS,
                             C.ALIGN_SMOOTH_M, C.ALIGN_REL, C.ALIGN_SIG0_DEG, C.ALIGN_BETA, C.ALIGN_NU, C.ALIGN_VMAX, C.ALIGN_MEAS_SD_M, C.ALIGN_MEAS_EVERY_M, C.ALIGN_MAX_DEV_M, C.ALIGN_TURN_DEG, C.ALIGN_TURN_HALF_M, C.POST_STRAIGHT_EVERY_M, C.POST_STRAIGHT_INFL,
                             "accept1", C.LOCAL_ACCEPT_ON, C.LOCAL_ACCEPT_MIN_S, C.LOCAL_ACCEPT_NATS, C.LOCAL_ACCEPT_R_M, C.LOCAL_KEPT_CONF, C.LM_MIN_DEG, C.LM_WIN_M, C.LM_TOL_DEG, C.LM_TOL_REL, C.LM_EXT_M, *ext],
                     gpx=[P["decoys"], C.NODECOY, C.PEAK_FLAT, C.COVERAGE, C.YAW_RATIO, P["offset_m"], P["traffic_side"], P["vehicle"], C.OFFSET_M, C.OFFSET_SMOOTH_M, "gpx1", *(["still_pts1"] if C.STILL_ON else []), "raster1", C.GPX_HZ])
        for sid in C.STEPS:
            prev = sha(parts[sid], prev)
            h[sid] = prev
        # start_time is not part of any hash: retime is free
        return h

    def run_worker(self, sid, i) -> tuple[int, dict | None, list]:
        d = self.d
        cmd = SELF_CMD + ["_memguard", "--max-gb", str(C.MEMGUARD["max_gb"]), "--min-free", str(C.MEMGUARD["min_free"]), "--"] + SELF_CMD + ["_step", sid, "--dir", str(d)]
        (d / "logs").mkdir(exist_ok=True)
        err = open(d / "logs" / f"{sid}.err.log", "w")
        t0 = time.time()
        self.proc = subprocess.Popen(cmd, stdout=subprocess.PIPE, stderr=err, text=True, bufsize=1, start_new_session=True, env=dict(os.environ, PYTHONUNBUFFERED="1"))
        summary, statuses, last_pct, p0 = None, [], 0.0, None
        for line in self.proc.stdout:
            line = line.strip()
            try:
                ev = json.loads(line)
            except ValueError:
                if line:
                    emit({"type": "log", "level": "info", "message": line[:500]})
                continue
            ty = ev.get("type")
            if ty == "progress":
                pct = float(ev["pct"])
                if pct < last_pct - 20:                  # a second pass of the step (hint fallback) starts again at 0
                    p0, last_pct = None, 0.0
                last_pct = max(last_pct, pct)
                el = time.time() - t0
                if p0 is None:
                    p0, t_p0 = pct, time.time()
                done_ = pct - p0
                self.step_event(sid, i, "running", pct, (time.time() - t_p0) * (100 - pct) / done_ if done_ >= 2 else None)
            elif ty == "status":
                statuses.append(ev)
                emit(ev)
            elif ty == "log":
                emit(ev)
            elif ty == "summary":
                summary = ev["summary"]
        rc = self.proc.wait()
        err.close()
        peak = None
        try:
            for ln in (d / "logs" / f"{sid}.err.log").read_text().splitlines():
                if "peak group RSS" in ln:
                    peak = float(ln.rsplit("peak group RSS", 1)[1].split("GB")[0])
        except (OSError, ValueError):
            pass
        if rc == 137:
            emit({"type": "log", "level": "error", "message": f"step {sid} stopped by the memory guard (limit {C.MEMGUARD['max_gb']} GB group RSS or {C.MEMGUARD['min_free']} % system free); see logs/{sid}.err.log"})
            rc = EXIT["resource"]
        return rc, dict(summary=summary, seconds=time.time() - t0, peak_gb=peak), statuses

    def cancel(self, *_):
        self.cancelled = True
        if self.proc and self.proc.poll() is None:
            try:
                os.killpg(self.proc.pid, signal.SIGTERM)
            except ProcessLookupError:
                pass

    def run(self) -> int:
        a, d = self.a, self.d
        for p in (a.video, a.pbf):
            if not Path(p).exists():
                emit({"type": "log", "level": "error", "message": f"file not found: {p}"})
                return EXIT["args"]
        try:
            bbox = __import__("rsm.pipeline.osm", fromlist=["x"]).parse_bbox(a.bbox)
        except ValueError as e:
            emit({"type": "log", "level": "error", "message": str(e)})
            return EXIT["args"]
        from .memguard import free_percent
        fp = free_percent()
        if fp is not None and fp < C.MEMGUARD["min_free"] + 5:
            emit({"type": "log", "level": "error", "message": f"system memory: only {fp:.0f} % free (the guard stops jobs below {C.MEMGUARD['min_free']} %); close other applications and retry"})
            return EXIT["resource"]
        from . import hints as HI
        osm_ = __import__("rsm.pipeline.osm", fromlist=["x"])
        extra = {}
        try:
            for key, val in (("start_bbox", a.start_bbox), ("end_bbox", a.end_bbox)):
                if val:
                    fb = osm_.parse_bbox(val)
                    if fb["east"] < bbox["west"] or fb["west"] > bbox["east"] or fb["north"] < bbox["south"] or fb["south"] > bbox["north"]:
                        raise ValueError(f"--{key.replace('_', '-')} lies outside the search area --bbox")
                    extra[key] = fb
            if a.hint:
                if not Path(a.hint).is_file():
                    raise ValueError(f"file not found: {a.hint}")
                lines = HI.read_hint(a.hint)
                lo, hi = C.HINT_BUFFER_RANGE
                if not lo <= a.hint_buffer_m <= hi:
                    raise ValueError(f"--hint-buffer-m must be between {lo:.0f} and {hi:.0f}")
                hb = HI.lines_bounds(lines)
                if hb[2] < bbox["south"] or hb[0] > bbox["north"] or hb[3] < bbox["west"] or hb[1] > bbox["east"]:
                    raise ValueError("the route hint lies outside the search area --bbox")
                extra.update(hint=str(Path(a.hint).resolve()), hint_hash=HI.file_hash(a.hint))
            if a.anchors:                        # user anchors: the search area grows to include their frames (only then the map step reruns)
                from . import anchors as AN
                extra["anchors"] = AN.load(a.anchors)
                nb = AN.grow_bbox(bbox, extra["anchors"])
                if nb:
                    emit({"type": "log", "level": "warn", "message": "a user anchor lies outside the search area; the area is grown to include it"})
                    bbox = nb
            if a.from_step and not a.resume:
                raise ValueError("--from-step needs --resume")
            if a.intro_end is not None and not a.intro_end > 0:
                raise ValueError("--intro-end must be a positive video second")
        except ValueError as e:
            emit({"type": "log", "level": "error", "message": str(e)})
            return EXIT["args"]
        d.mkdir(parents=True, exist_ok=True)
        P = dict(video=str(Path(a.video).resolve()), bbox=bbox, pbf=str(Path(a.pbf).resolve()), vehicle=a.vehicle, offset_m=a.offset_m, start_time=a.start_time, traffic_side=a.traffic_side, decoys=max(0, a.decoys),
                 start_tol_m=a.start_tol_m, hint_buffer_m=a.hint_buffer_m, hint_fallback=a.hint_fallback, **extra)
        if a.intro_end is not None:
            P["intro_end"] = float(a.intro_end)
        if a.bike_paths is not None:
            P["bike_paths"] = a.bike_paths
        if a.align_mode is not None:
            P["align_mode"] = a.align_mode
        P["horizon"] = horizon_first(a, d)
        jdump(d / "project.params.json", P)
        signal.signal(signal.SIGTERM, self.cancel)
        signal.signal(signal.SIGINT, self.cancel)
        H = self.hashes(P)
        (d / "steps").mkdir(exist_ok=True)
        results, statuses_all = {}, []
        after_search = C.STEPS[C.STEPS.index("route_search") + 1]
        from_step, second, k = a.from_step, False, 0
        while k < len(C.STEPS):
            i, sid = k + 1, C.STEPS[k]
            k += 1
            if sid == after_search and a.vehicle == "auto" and not second and (d / "route_search" / "vehicle_final.json").exists():
                CB = __import__("rsm.pipeline.calib", fromlist=["x"])
                want = CB.horizon_mode(jload(d / "route_search" / "vehicle_final.json")["vehicle"], CB.calibration_spread(d))
                if want != P["horizon"]:                 # the second pass: the horizon of the calibrated vehicle, from the stored extraction
                    emit({"type": "log", "level": "info", "message": f"the calibration says {'a motor vehicle' if want == 'running' else 'a bike'}: motion to route_search "
                                                                     f"run once more with the {want} horizon (from the stored extraction, no video decode)"})
                    # preserve pass-1 far-band windows across the rotation/ wipe: horizon_vms is unchanged between running and fixed horizon
                    win_src = d / "rotation" / "win_video_base.npz"
                    if win_src.exists():
                        shutil.copy2(win_src, d / "_pass1_win_video_base.npz")
                    P["horizon"], second, from_step, k = want, True, None, 0
                    jdump(d / "project.params.json", P)
                    H = self.hashes(P)
                    results, statuses_all = {}, []
                    continue
            done_f = d / "steps" / f"{sid}.done.json"
            dd = d / sid
            if sid == "plausibility" and P["decoys"] == 0:
                done_f.unlink(missing_ok=True)
                jdump(done_f, dict(id=sid, in_hash=H[sid], skipped=True, seconds=0, peak_gb=None, summary=None, statuses=[]))
                self.step_event(sid, i, "skipped", 100.0)
                results[sid] = jload(done_f)
                continue
            forced = bool(from_step) and i >= C.STEPS.index(from_step) + 1
            if from_step and not forced:       # before --from-step: reuse as it is, never recompute
                if not done_f.exists():
                    self.step_event(sid, i, "failed")
                    emit({"type": "log", "level": "error", "message": f"step {sid} has no result to reuse; run again without --from-step {from_step}"})
                    return EXIT["args"]
                if jload(done_f).get("in_hash") != H[sid]:
                    emit({"type": "log", "level": "warn", "message": f"the inputs of step {sid} changed but its result is reused as requested (--from-step {from_step})"})
            if a.resume and done_f.exists() and not forced and (from_step or jload(done_f).get("in_hash") == H[sid]):
                rec = jload(done_f)
                self.step_event(sid, i, "skipped", 100.0, reused=True)
                for s in rec.get("statuses", []):
                    emit(s)
                statuses_all += rec.get("statuses", [])
                results[sid] = rec
                continue
            if done_f.exists():
                done_f.unlink()
            # keep the partial output of an interrupted step only if it was made from the same inputs (decoys are resumed one by one)
            mark = dd / ".in_hash"
            if dd.exists() and (forced or not (a.resume and mark.exists() and mark.read_text() == H[sid])):
                shutil.rmtree(dd)
            dd.mkdir(exist_ok=True)
            mark.write_text(H[sid])
            self.step_event(sid, i, "running", 0.0)
            rc, info, sts = self.run_worker(sid, i)
            if self.cancelled:
                self.step_event(sid, i, "failed")
                emit({"type": "log", "level": "warn", "message": "cancelled; run again with --resume to continue"})
                return EXIT["cancelled"]
            if rc != 0:
                self.step_event(sid, i, "failed")
                emit({"type": "log", "level": "error", "message": f"step {sid} failed (exit {rc}); see {d / 'logs' / (sid + '.err.log')}"})
                return rc
            rec = dict(id=sid, in_hash=H[sid], seconds=round(info["seconds"], 1), peak_gb=info["peak_gb"], summary=info["summary"], statuses=sts, finished=time.strftime("%Y-%m-%dT%H:%M:%S"))
            jdump(done_f, rec)
            results[sid] = rec
            statuses_all += sts
            self.step_event(sid, i, "done", 100.0)
        proj = jload(d / "project.json")
        pl = proj["verdict_detail"]
        dec = dict(rank=pl["rank"], decoys=pl["n"], margin_nats_per_km=pl["margin"], best_decoy=pl["best_decoy_name"]) if "rank" in pl else dict(decoys=0, reasons=pl["reasons"], signals=pl["signals"])
        summary = dict(**dec, verdict_basis=pl["basis"], vehicle=proj["effective"]["vehicle"], offset_m=proj["effective"]["offset_m"],
                       traffic_side=proj["effective"]["traffic_side"], f_eff=results["route_search"]["summary"]["f_eff"], kappa=results["route_search"]["summary"]["kappa"],
                       hints_used=proj.get("hints_used"), horizon=P["horizon"], second_pass=second, anchors=(results["route_search"].get("summary") or {}).get("anchors"), pipeline_hash=proj.get("pipeline_hash"), confidence_mean=results["refine"]["summary"]["conf_mean"], route_km=results["refine"]["summary"]["path_km"],
                       step_seconds={s: results[s]["seconds"] for s in C.STEPS}, step_peak_gb={s: results[s]["peak_gb"] for s in C.STEPS})
        emit({"type": "result", "verdict": pl["verdict"], "verdict_basis": pl["basis"], "gpx": str(d / "route.gpx"), "project": str(d / "project.json"), "route_points": str(d / "route_points.json"), "summary": summary})
        return 0


def main(argv=None) -> int:
    argv = sys.argv[1:] if argv is None else list(argv)
    if argv and argv[0] == "_memguard":
        from .memguard import main as mg
        return mg(argv[1:])
    a = parse_args(argv)
    if a.cmd == "_step":
        return worker_main(a.step, Path(a.dir))
    if a.cmd == "version":
        emit(dict(type="version", **frozen_info()))
        return 0
    if a.cmd == "retime":
        from .steps_d import retime
        try:
            emit({"type": "result", **retime(Path(a.dir), a.start_time)})
            return 0
        except (FileNotFoundError, ValueError) as e:
            emit({"type": "log", "level": "error", "message": str(e)})
            return EXIT["args"]
    if a.cmd == "reroute":
        from .reroute import reroute, reset_reroute
        try:
            res = reset_reroute(Path(a.out)) if a.reset else reroute(Path(a.out), a.waypoints)
            emit({"type": "result", **res})
            return 0
        except (FileNotFoundError, ValueError) as e:
            emit({"type": "log", "level": "error", "message": str(e)})
            return EXIT["args"]
        except RuntimeError as e:
            emit({"type": "log", "level": "error", "message": str(e)})
            return EXIT["data"]
    if a.cmd == "profile":
        from .export import elevation_profile
        from .dem import env_dem_dir
        d = Path(a.out)
        if not (d / "refine" / "result.npz").exists() or not (d / "project.json").exists():
            emit({"type": "log", "level": "error", "message": f"no finished run in {d} (refine/result.npz, project.json)"})
            return EXIT["args"]
        try:
            dd = a.dem_dir or env_dem_dir()
            r = elevation_profile(d, Path(a.dest), Path(dd) if dd else None)
        except ValueError as e:
            emit({"type": "log", "level": "error", "message": f"{type(e).__name__}: {e}"})
            return EXIT["data"]
        emit({"type": "result", "profile": a.dest, **r})
        return 0
    if a.cmd in ("inspect-series", "inspect-frame"):
        from . import insight
        d = Path(a.out)
        if not (d / "refine" / "result.npz").exists() or not (d / "motion" / "motion.csv").exists():
            emit({"type": "log", "level": "error", "message": f"no finished run in {d} (refine/result.npz, motion/motion.csv)"})
            return EXIT["args"]
        try:
            if a.cmd == "inspect-series":
                r = insight.series(d, **({} if a.window_m is None else dict(window_m=a.window_m)))
                dest = Path(a.dest) if a.dest else d / "inspect" / "series.json"
                dest.parent.mkdir(parents=True, exist_ok=True)
                tmp = Path(str(dest) + ".tmp")
                tmp.write_text(json.dumps(r, separators=(",", ":")))
                os.replace(tmp, dest)
                emit({"type": "result", "series": str(dest), "n": r["n"], "stretches": len(r["stretches"]), "seconds": r["seconds"], "bytes": dest.stat().st_size})
            else:
                emit({"type": "result", **insight.frame(d, a.t, a.video, tuple(x for x in a.what.split(",") if x))})
        except (ValueError, FileNotFoundError, KeyError) as e:
            emit({"type": "log", "level": "error", "message": f"{type(e).__name__}: {e}"})
            return EXIT["data"]
        return 0
    if a.cmd in ("dem-plan", "dem-fetch"):
        from . import demsrc as S
        from .dem import env_dem_dir
        from .export import path_lonlat
        d = Path(a.out)
        dd = a.dem_dir or env_dem_dir()
        if not (d / "refine" / "result.npz").exists() or not (d / "project.json").exists() or not dd:
            emit({"type": "log", "level": "error", "message": f"need a finished run in {d} and a DEM directory"})
            return EXIT["args"]
        names = [n for n in a.sources.split(",") if n] if a.sources else None
        lat, lon = path_lonlat(d)
        if a.cmd == "dem-plan":
            p = S.plan(lat, lon, Path(dd), names)
            emit({"type": "result", "sources": p["sources"], "missing_blocks": p["missing_blocks"], "missing_bytes": p["missing_bytes"], "exact": p["exact"]})
            return 0
        prog = lambda k, n, b, it: emit({"type": "progress", "index": k, "of": n, "bytes": b, "source": it["source"], "block": it["block"]})
        r = S.fetch(lat, lon, Path(dd), names, progress=prog)
        emit({"type": "result", **r})
        return 0
    if a.cmd == "export":
        from .export import export
        from .dem import env_dem_dir
        d = Path(a.out)
        if not (d / "refine" / "result.npz").exists() or not (d / "project.json").exists():
            emit({"type": "log", "level": "error", "message": f"no finished run in {d} (refine/result.npz, project.json)"})
            return EXIT["args"]
        try:
            dd = a.dem_dir or env_dem_dir()
            summ = export(d, Path(a.dest), Path(a.summary), Path(dd) if dd else None, fps=a.fps, trim=a.trim, start_time=a.start_time, title=a.title, link=a.link, creator_app=a.app_version)
        except ValueError as e:
            emit({"type": "log", "level": "error", "message": f"{type(e).__name__}: {e}"})
            return EXIT["data"]
        emit({"type": "result", "gpx": a.dest, "summary_file": a.summary, "summary": summ})
        return 0
    return Run(a).run()
