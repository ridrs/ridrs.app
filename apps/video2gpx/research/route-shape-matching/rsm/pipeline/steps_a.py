# SPDX-License-Identifier: AGPL-3.0-or-later
"""Workers of steps 1 and 2: video motion (vendored vms) and far-feature rotation. Run inside a memguard'd subprocess."""
from __future__ import annotations

import json
import multiprocessing as mp
import pickle
import resource
import subprocess
import time
from pathlib import Path

import cv2
import numpy as np
from scipy.ndimage import median_filter

from rsm.angle import farfeat
from rsm.farrot import model, series as fser
from rsm.odometry import gating, heading
from rsm.odometry.vms_csv import load_pairs

from . import config as C, cuts as K, osm, resources as R, standstill as SS, tracks as T
from .common import Worker, ffmpeg_bin, ffprobe_bin, file_sig, hwaccel_enabled, hwaccel_name, jdump, jload, sha
from .vmsx import extract as EX, interpret as VI, motion as vm
from .vmsx.decode import probe


# ------------------------------------------------------------------ 1 motion
def motion(d: Path, P: dict, W: Worker):
    out = d / "motion"
    out.mkdir(exist_ok=True)
    csv = out / "motion.csv"

    def cb(n, total, phase):
        W.progress(0.0 if phase == "horizon" else 100.0 * n / max(total, 1), phase)

    # P["calibration"] (test bench only: a clip of a source, docs/CONCEPT_test_strategy.md B): the motion.json of the whole source, whose horizon
    # calibration is used instead of calibrating on the few seconds of the clip
    # and P["frame0"]: the index of the clip's first frame in the source, which seeds the traffic candidate fits as in the whole source
    cal = jload(Path(P["calibration"]))["horizon_calibration"] if P.get("calibration") else None
    s0 = int(P.get("frame0") or 0)
    if C.MOTION_FROM_EXTRACT and C.VMS["step"] == 1:
        stats = motion_from_extract(d, P, W, cal, s0)
    elif C.MOTION_PARALLEL and C.VMS["step"] == 1:
        stats = vm.analyse_parallel(P["video"], str(csv), height=C.VMS["height"], workers=R.policy()["workers"], on_progress=cb, log=W.log, calibration=cal, seed0=s0)
    else:
        stats = vm.analyse(P["video"], str(csv), height=C.VMS["height"], step=C.VMS["step"], on_progress=cb, calibration=cal, seed0=s0)
    jdump(out / "motion.json", stats)
    p = load_pairs(str(csv))
    if C.CUT_ON:                         # scene-cut candidates from the pairs just analysed (no extra decode); the rotation step adds its cue and decides
        cands = K.candidates(p.time, p.diff, p.inliers)
        jdump(out / "cuts.json", dict(version=K.VERSION, candidates=cands))
        if cands:
            W.log("info", f"scene cuts: {len(cands)} candidate frame pairs (frame-difference impulse), {sum(c['vms'] for c in cands)} with a failed road-flow fit")
    fl = gating.pair_flags(p)
    segs = gating.build_segments(p, fl, gating.GateParams())
    dur = float(stats["duration"])
    usable = float(sum(s.t1 - s.t0 for s in segs if s.usable))
    L, speeds = 0.0, []
    for s in segs:
        if not s.usable:
            continue
        tr = heading.integrate(p, s, fl, C.F360)
        L += float(tr.s[-1])
        v = np.diff(tr.s) / np.maximum(np.diff(tr.t), 1e-3)
        speeds.append(median_filter(v, size=31, mode="nearest"))
    v = np.concatenate(speeds) if speeds else np.zeros(1)
    summ = dict(duration_s=dur, fps=float(stats["fps"]), horizon=float(stats["horizon"]), usable_s=usable, usable_share=usable / dur, n_segments=int(sum(s.usable for s in segs)),
                nominal_km=L / 1000, v_nom_p50=float(np.percentile(v, 50)), v_nom_p90=float(np.percentile(v, 90)), vms_seconds=float(stats["seconds"]))
    jdump(out / "summary.json", summ)
    W.status("motion_coverage", C_level_cov(summ["usable_share"]), summ["usable_share"],
             f"{100 * summ['usable_share']:.0f} % of the video time has usable motion ({summ['n_segments']} segments)")
    wk, hk = osm.bbox_km(P["bbox"])
    diag = float(np.hypot(wk, hk))
    q = summ["nominal_km"] * C.K_HI / diag
    lev = "good" if q <= C.AREA_RATIO[0] else "difficult" if q <= C.AREA_RATIO[1] else "problem"
    W.status("area_size", lev, q, f"nominal route length {summ['nominal_km']:.1f} km x upper scale {C.K_HI} = {summ['nominal_km'] * C.K_HI:.0f} km against the area diagonal "
             f"{diag:.0f} km ({wk:.0f} x {hk:.0f} km)" + ("" if lev == "good" else ": the area may be too small, a bigger one avoids a cut route"))
    if lev != "good":
        W.log("warn", f"area check: ratio {q:.2f} (good <= {C.AREA_RATIO[0]}, problem > {C.AREA_RATIO[1]})")
    tr = truncation(float(p.time[-1]) + p.dt / 2 if len(p.time) else 0.0, *container_durations(P["video"]))
    if tr is not None:
        summ["truncated"] = tr
        jdump(out / "summary.json", summ)
        W.status("video_truncated", "problem", tr["decoded_s"] / tr["container_s"], f"the video file is damaged or incomplete: only {K.mmss(tr['decoded_s'])} of "
                 f"{K.mmss(tr['container_s'])} could be decoded; the route ends at {K.mmss(tr['decoded_s'])}")
        W.log("warn", f"video truncated: decoded {tr['decoded_s']:.0f} s of {tr['container_s']:.0f} s (container)")
    return summ


#: share of the motion step's progress bar the extraction takes when it runs (it is about ten times longer than the interpretation)
EXTRACT_SHARE = 0.85


def extract_key(video: str, height: int) -> str:
    """what the stored extraction of a run depends on: the video file, the extraction settings and the OpenCV build (docs/CONCEPT_extraction.md §7)"""
    return sha(file_sig(video), EX.VERSION, EX.params(), int(height), cv2.__version__)


def motion_from_extract(d: Path, P: dict, W: Worker, cal: dict | None, s0: int) -> dict:
    """the motion statistics of `vm.analyse_parallel`, from run/extract/: extracted once (kept across reruns of the step), then interpreted"""
    h = C.VMS["height"]
    t0 = time.perf_counter()
    split = [EXTRACT_SHARE]                    # the bar: extraction 0..85 %, interpretation the rest (all of it when the extraction is reused)
    meta, reused = VI.ensure_extract(P["video"], d / "extract", extract_key(P["video"], h), height=h, workers=R.policy()["workers"], log=W.log,
                                     on_progress=lambda n, total, phase: W.progress(100.0 * split[0] * n / max(total, 1), phase))
    t_ex = time.perf_counter() - t0
    if reused:
        split[0] = 0.0
        W.log("info", f"motion: the stored extraction is reused ({meta['pairs']} pairs, extracted in {meta['seconds']:.0f} s)")

    def cb2(n, total, phase):
        W.progress(100.0 * (split[0] + (1 - split[0]) * (0.0 if phase == "horizon" else n / max(total, 1))), phase)

    stats = VI.analyse(d / "extract", str(d / "motion" / "motion.csv"), calibration=cal, seed0=s0, on_progress=cb2, running=P.get("horizon", "running") == "running",
                       spread_iqr=C.HZ_SPREAD_IQR, workers=R.policy()["workers"])
    sp = stats.get("horizon_spread")
    if sp and sp["running"]:
        W.log("info", f"horizon calibration scattered over {sp['iqr']:.0f} rows (limit {sp['limit']:.0f}): no fixed row fits the video, the running horizon is used")
    stats["video"] = P["video"]
    stats["extract"].update(reused=reused, wait_seconds=round(t_ex, 2))
    stats["seconds"] += t_ex
    return stats


def container_durations(path: str) -> tuple[float | None, float | None]:
    """(stream duration, format duration) as the file claims them; None where missing or unreadable"""
    try:
        j = json.loads(subprocess.run([ffprobe_bin(), "-v", "error", "-select_streams", "v:0", "-show_entries", "stream=duration:format=duration", "-of", "json", path],
                                      check=True, capture_output=True, text=True, timeout=60).stdout)
    except Exception:
        return None, None
    num = lambda x: float(x) if x not in (None, "N/A") else None
    return num((j.get("streams") or [{}])[0].get("duration")), num((j.get("format") or {}).get("duration"))


def truncation(decoded_s: float, stream_s: float | None, format_s: float | None) -> dict | None:
    """the decode ended well before the duration the file claims (damaged / incomplete download): Gotthard decoded 964 of 2486 s, no status said so"""
    claims = [x for x in (stream_s, format_s) if x is not None and x > 0]
    if not claims:
        return None
    full = max(claims)
    if full - decoded_s <= max(C.TRUNC_MIN_S, C.TRUNC_FRAC * full):
        return None
    return dict(decoded_s=round(decoded_s, 2), container_s=round(full, 2))


def C_level_cov(x):
    return T.level(x, C.COVERAGE[0], C.COVERAGE[1])


# ------------------------------------------------------------------ 2 rotation
FIELDS = ["A", "B", "C", "e", "sA", "sB", "sC", "corrAC", "sigma", "xspread"]
WHY = ["", "few corners", "few inliers", "narrow"]
_G: dict = {}


def ffmpeg_frames(path, info, height, first_frame, n_frames, k, threads=2, hwaccel=True):
    width = round(info.width * height / info.height / 2) * 2
    ss = max(0.0, (first_frame - 0.5) / info.fps)
    cmd = [ffmpeg_bin(), "-v", "error", "-nostdin"]
    hw = hwaccel_name() if hwaccel else None
    cmd += ["-hwaccel", hw] if hw else ["-threads", str(threads)]
    cmd += ["-ss", f"{ss:.4f}", "-i", path, "-an", "-vf", f"select='not(mod(n\\,{k}))',scale={width}:{height}:flags=area,format=gray", "-fps_mode", "passthrough",
            "-frames:v", str(n_frames), "-f", "rawvideo", "-pix_fmt", "gray", "-"]
    size = width * height
    with subprocess.Popen(cmd, stdout=subprocess.PIPE, bufsize=size * 4) as proc:
        while True:
            buf = proc.stdout.read(size)
            if len(buf) < size:
                break
            yield np.frombuffer(buf, np.uint8).reshape(height, width)
        proc.stdout.close()
        proc.wait()


def band_ends(horizon, H, p, step, n_bands):
    sc = H / 360
    r1 = max(horizon + p.band_off * sc, p.band_min_rows * sc)
    return [float(min(r1 + i * step * sc, 0.62 * H)) for i in range(n_bands)]


def _chunk(args):
    import cv2
    cv2.setNumThreads(1)
    w0, w1 = args
    G = _G
    info, k, H, f, p = G["info"], G["k"], G["H"], G["f"], G["p"]
    W = round(info.width * H / info.height / 2) * 2
    masks = []
    for e in band_ends(G["horizon"], H, p, G["band_step"], G["n_bands"]):
        m = np.zeros((H, W), np.uint8)
        mx = int(0.02 * W)
        m[:int(e), mx:W - mx] = 255
        masks.append(m)
    rng = np.random.default_rng(1000 + w0)
    out = np.full((w1 - w0, len(masks), len(FIELDS) + 4), np.nan)
    out[:, :, len(FIELDS):] = [0, 0, 0, 1]
    prev, n_dec = None, 0
    for j, fr in enumerate(ffmpeg_frames(G["video"], info, H, w0 * k, w1 - w0 + 1, k)):
        n_dec += 1
        if prev is not None:
            i = j - 1
            for b, mask in enumerate(masks):
                tr = farfeat.track_pair(cv2, mask, prev, fr, p, H / 360)
                if tr is None:
                    continue
                q0, fl = tr
                x, y = q0[:, 0] - W / 2, q0[:, 1] - H / 2
                wf = model.fit_window(x, y, fl, f, scale=H / 360, rng=rng, min_inl=G["min_inl"], min_xspread=0.0)
                out[i, b, :len(FIELDS)] = [getattr(wf, a) for a in FIELDS]
                out[i, b, len(FIELDS):] = [wf.ok, wf.n_pts, wf.n_inl, WHY.index(wf.why) if wf.why in WHY else 2]
        prev = fr
    return w0, out, n_dec


def extract_of_run(d: Path, mj: dict, k: int) -> bool:
    """the rotation step may fit from run/extract/: on (ROT_FROM_EXTRACT), the motion step interpreted this very extraction (its key), and the
    extraction's rotation windows are k frames long"""
    f = d / "extract" / "extract.json"
    if not (C.ROT_FROM_EXTRACT and mj.get("extract") and f.exists()):
        return False
    m = jload(f)
    return m.get("key") == mj["extract"].get("key") and int(m.get("k", -1)) == int(k)


def road_x0(csv_path: str) -> float | None:
    """A25: the focus-of-expansion column (px from the image centre at 360 rows) of the road fit, the median -c/s over the clean pairs
    (C.X0_MIN_S, C.X0_MAX_RMS); None with fewer than C.X0_MIN_PAIRS of them"""
    q = np.genfromtxt(csv_path, delimiter=",", names=True, filling_values=np.nan)
    s, c, rms = (np.atleast_1d(q[n]) for n in ("s", "c", "rms_px"))
    ok = np.isfinite(s) & np.isfinite(c) & (s > C.X0_MIN_S) & (rms <= C.X0_MAX_RMS)
    if ok.sum() < C.X0_MIN_PAIRS:
        return None
    return float(np.median(-c[ok] / s[ok]))


def scene_cuts(d: Path, out: Path, tracks: list[dict], ta, tb, ok, n_inl, W: Worker, video: str | None = None, intro_user: float | None = None, n_pts=None) -> list[dict]:
    """final cut decision (classical frame-difference impulse + multi-type visual transition detection, rsm.pipeline.cuts) and the plan applied to the tracks:
    jumps at cuts, inserted shots dropped, start rule. Writes rotation/cuts.json; status lines only for a video with cuts."""
    f = d / "motion" / "cuts.json"
    stored = jload(f) if f.exists() else None
    csv = d / "motion" / "motion.csv"
    pairs = None
    if stored is not None and (stored.get("version") == K.VERSION or not csv.exists()):
        cands = stored["candidates"]
    else:                                # motion step of an older run (no cuts.json, or one of an older detector): the candidates from its csv
        pairs = load_pairs(str(csv))
        cands = K.candidates(pairs.time, pairs.diff, pairs.inliers)
    cands = K.far_cue(cands, ta, tb, ok, n_inl)
    cuts = K.decide(cands)
    extra: list[dict] = []
    if C.CUT_TRANS_ON and video and csv.exists():
        if pairs is None:
            pairs = load_pairs(str(csv))
        extra = K.transition_candidates(pairs.time, pairs.diff, pairs.inliers, ta, tb, ok, n_pts, n_inl)
    rejected = []
    if (cuts or extra) and video:        # same-scene veto on classical cuts + visual verification of hard/fade/dissolve candidates
        cuts, rejected = K.verify_transitions(video, cuts, extra, ffmpeg_bin())
        for c in rejected:
            W.log("info", f"scene cut candidate at {K.mmss(c['t'])} rejected: the frames before and after show the same scene "
                  f"({100 * c['same']['share']:.0f} % of the points fit, limit {100 * C.CUT_SAME_SHARE:.0f} %; a flash or an exposure jump)")
    tracks, info = K.plan(tracks, cuts, intro_user=intro_user)
    jdump(out / "cuts.json", dict(version=K.VERSION, cuts=cuts, rejected=rejected, candidates=cands, transition_candidates=extra, **info,
                                  params=dict(impulse=C.CUT_IMPULSE, strong_impulse=C.CUT_STRONG_IMPULSE, strong_factor=C.CUT_STRONG_FACTOR, strong_min_diff=C.CUT_STRONG_MIN_DIFF, strong_around=C.CUT_STRONG_AROUND, strong_nb_share=C.CUT_STRONG_NB_SHARE, inl_share=C.CUT_INL_SHARE, merge_s=C.CUT_MERGE_S, min_piece_s=C.CUT_MIN_PIECE_S, intro_s=C.CUT_INTRO_S,
                                              jump_m=C.CUT_JUMP_M, same_on=C.CUT_SAME_ON, same_share=C.CUT_SAME_SHARE, same_win_s=C.CUT_SAME_WIN_S, trans_on=C.CUT_TRANS_ON)))
    if info["intro_end"] is not None and info["intro_source"] == "user":
        W.status("intro_skipped", "good", info["intro_end"], f"intro up to {K.mmss(info['intro_end'])} skipped: the route starts at the intro end set by hand")
        W.log("info", f"intro end set by hand at {info['intro_end']:.2f} s (detected: "
              + (f"{max(t for t in info['cut_times'] if t < C.CUT_INTRO_S):.2f} s)" if any(t < C.CUT_INTRO_S for t in info["cut_times"]) else "none)"))
    elif intro_user is not None and info.get("intro_rule_skipped"):
        W.log("warn", f"the intro end set by hand ({intro_user:.2f} s) is after the last tracked motion: it is not applied")
    if not cuts:
        return tracks
    ins = info["inserted"]
    W.status("scene_cuts", "difficult", len(cuts), f"the video is edited: {len(cuts)} cuts (at " + ", ".join(K.mmss(c["t"]) for c in cuts[:8])
             + (f" and {len(cuts) - 8} more" if len(cuts) > 8 else "") + "); the route jumps there instead of riding through"
             + (f"; {len(ins)} inserted shots between cuts dropped (" + ", ".join(f"{K.mmss(x['t0'])}-{K.mmss(x['t1'])}" for x in ins[:5]) + ")" if ins else ""))
    if info["intro_end"] is not None and info["intro_source"] == "cuts":
        W.status("intro_skipped", "good", info["intro_end"], f"intro up to {K.mmss(info['intro_end'])} skipped: the route starts after the last cut of the first "
                 f"{C.CUT_INTRO_S / 60:.0f} minutes")
    kinds = ", ".join(f"{sum(c.get('kind', 'hard') == k for c in cuts)} {k}" for k in ("hard", "dissolve", "fade") if any(c.get("kind", "hard") == k for c in cuts))
    W.log("info", f"scene cuts: {len(cuts)} confirmed ({kinds}) from {len(cands)} spike + {len(extra)} transition candidates; {info['dropped_tracks']} tracks dropped (intro, inserted shots)")
    return tracks


def rotation(d: Path, P: dict, W: Worker):
    out = d / "rotation"
    out.mkdir(exist_ok=True)
    mj = jload(d / "motion" / "motion.json")
    info = probe(P["video"])
    F = C.FAR
    k = max(2, int(round(F["k_s"] * info.fps)))
    n_win = int(info.duration * info.fps / k) - 1
    cw = max(10, int(round(F["chunk_s"] * info.fps / k)))
    chunks = [(s, min(s + cw, n_win)) for s in range(0, n_win, cw)]
    hz, off = farfeat.band_horizon(mj, C.ROT_BAND_OFF_VMS, farfeat.Params.band_off)   # FOE horizon of vms (old projects: free road-plane fit)
    p = farfeat.Params(min_inl=F["min_inl"], band_off=off)
    ends = band_ends(hz, 360, p, F["band_step"], F["n_bands"])
    t0 = time.time()
    ex = d / "extract"
    want_source = "extract" if extract_of_run(d, mj, k) else "video"
    stashed = d / "_pass1_win_video_base.npz"
    reused_win = None
    if stashed.exists():
        try:
            with np.load(stashed) as z0:
                m0 = json.loads(str(z0["meta"]))
            if (int(m0.get("k", -1)) == int(k) and int(m0.get("n_windows", -1)) == int(n_win)
                    and m0.get("source") == want_source and m0.get("band_ends") == ends
                    and float(m0.get("f", -1)) == float(C.F_FAR)):
                import shutil
                shutil.move(str(stashed), str(out / "win_video_base.npz"))
                reused_win = m0
                W.log("info", f"rotation: reused {n_win} far-feature windows from pass 1 (same horizon {hz:.1f})")
                W.progress(95.0, "bands")
        except Exception:
            pass
        stashed.unlink(missing_ok=True)
    if reused_win is not None:
        return rotation_series(d, P, W, reused_win)
    if want_source == "extract":              # the windows from the stored `rot` stream of the motion step's extraction: no decode
        arr = VI.rotation_windows(VI.Points(ex, streams=("rot",)), ends, p, C.F_FAR, F["min_inl"], n_win, cw, FIELDS, WHY, workers=min(C.MAX_WORKERS, len(chunks)),
                                  on_progress=lambda n, total, phase: W.progress(95.0 * n / max(total, 1), phase))
        source = "extract"
    else:
        if mj.get("extract"):
            W.log("warn", "rotation: the motion step's extraction is missing or another one (run/extract/); the far bands are tracked in the video")
        _G.update(video=P["video"], info=info, k=k, H=360, f=C.F_FAR, p=p, horizon=hz, min_inl=F["min_inl"], band_step=F["band_step"], n_bands=F["n_bands"])
        procs = min(C.MAX_WORKERS, len(chunks))
        res = []
        with mp.get_context("fork").Pool(procs) as pool:
            for r in pool.imap_unordered(_chunk, chunks, chunksize=1):
                res.append(r)
                W.progress(95.0 * len(res) / len(chunks), "tracking")
        res.sort(key=lambda x: x[0])
        arr = np.concatenate([x[1] for x in res])
        source = "video"
    idx = np.arange(0, n_win)
    NF = len(FIELDS)
    meta = dict(video="video", f=C.F_FAR, k=k, fps=info.fps, horizon=hz, band_off=off, n_windows=int(n_win), n_ok=int(np.nansum(arr[:, 0, NF])), wall_s=time.time() - t0,
                band_ends=ends, source=source)
    np.savez(out / "win_video_base.npz", idx=idx, ta=idx * k / info.fps, tb=(idx + 1) * k / info.fps, fields=np.array(FIELDS), data=arr[:, :, :NF], ok=arr[:, :, NF].astype(bool),
             n_pts=arr[:, :, NF + 1], n_inl=arr[:, :, NF + 2], why=arr[:, :, NF + 3], meta=json.dumps(meta))
    return rotation_series(d, P, W, meta)


def standstill(d: Path, P: dict, W: Worker):
    """sure standstills (standstill.py) from the motion and rotation results and the video: rotation/standstill.json. Part of the image side, so that
    no route-side step reads the video."""
    f = d / "rotation" / "standstill.json"
    if f.exists():
        f.unlink()                               # never a stale result of an earlier run
    if not (C.STILL_ON and P.get("video") and (d / "motion" / "motion.json").exists()):
        return
    ss = SS.detect(d, P["video"], lambda x: W.progress(97.0 + 2.0 * min(1.0, x), "standstill"))
    mm = lambda t: f"{int(t) // 60}:{int(t) % 60:02d}"
    if ss["spans"]:
        W.status("standstill", "good", float(sum(b - a for a, b in ss["spans"])), f"the camera stands in {len(ss['spans'])} places although the picture moves "
                 "(passing traffic): " + ", ".join(f"{mm(a)}-{mm(b)}" for a, b in ss["spans"][:6]) + (f" and {len(ss['spans']) - 6} more" if len(ss["spans"]) > 6 else "")
                 + "; there the position is held")
    W.log("info", f"standstill test: {ss['n_candidates']} candidate windows in {ss['n_runs']} runs, {ss['n_tested']} tested, {len(ss['spans'])} sure spans, "
                  f"{ss['seconds']:.0f} s")


def rotation_series(d: Path, P: dict, W: Worker, meta: dict | None = None):
    """second half of the rotation step, from the far-feature windows (rotation/win_video_base.npz) on: series, tracks, scene cuts, vehicle guess.
    `meta`: the windows' meta as the first half made it (None: as stored in the npz)."""
    out = d / "rotation"
    ms = jload(d / "motion" / "summary.json")
    z = np.load(out / "win_video_base.npz")
    meta = json.loads(str(z["meta"])) if meta is None else meta
    fser.WORK = out          # load_windows reads WORK / win_<name>_<tag>.npz
    x0 = road_x0(str(d / "motion" / "motion.csv")) if C.ROT_X0_ROAD else None      # A25; None: estimate_x0 of the series, as before
    S = fser.build("video", str(d / "motion" / "motion.csv"), tag="base", x0=x0)
    S.meta["x0_source"], S.meta["x0_road"] = ("road" if x0 is not None else "straight windows"), x0
    W.progress(97.0, "series")
    tr = T.far_tracks(str(d / "motion" / "motion.csv"), S)
    if C.CUT_ON:
        tr = scene_cuts(d, out, tr, z["ta"], z["tb"], z["ok"], z["n_inl"], W, P["video"], intro_user=P.get("intro_end"), n_pts=z["n_pts"])
    pickle.dump(tr, open(out / "tracks.pkl", "wb"))
    cut_sp = [(float(c.get("t_first", c["t"])), float(c.get("t_last", c["t"]))) for c in jload(out / "cuts.json")["cuts"]] if (C.CUT_ON and (out / "cuts.json").exists()) else []
    T.save_far_heading(out / "far_heading.npz", T.far_heading(S, cut_sp))     # far-only heading for the vms speed gaps (odofail.build, ROT_BRIDGE_ON)
    standstill(d, P, W)
    st = T.steps_of(tr)
    yn = T.yaw_noise(tr)
    ratio = yn / C.BIKE_YAW_NOISE
    feats = dict(yaw_noise=yn, yaw_ratio=ratio, frac_vms=float(S.meta["frac_vms"] + S.meta["frac_none"]), frac_far=float(1 - S.meta["frac_vms"] - S.meta["frac_none"]),
                 lean_p95_deg=float(S.meta["lean_abs_deg_p50_p95_max"][1]), v_nom_p50=ms["v_nom_p50"], v_nom_p90=ms["v_nom_p90"], usable_share=ms["usable_share"], nominal_km_tracks=float(st.km))
    est = T.estimate_vehicle(feats)
    eff = P["vehicle"] if P["vehicle"] != "auto" else est["vehicle"]
    est.update(requested=P["vehicle"], effective=eff)
    jdump(out / "vehicle.json", est)
    jdump(out / "summary.json", dict(meta=meta, series=S.meta, features=feats, steps=int(st.T), step_km=float(st.km), peak_rss_gb=resource.getrusage(resource.RUSAGE_SELF).ru_maxrss / 2 ** 30))
    lev = T.level(ratio, C.YAW_RATIO[0], C.YAW_RATIO[1], higher_is_better=False)
    W.status("rotation_quality", lev, ratio, f"heading noise {ratio:.1f}x the bike level; far-feature fit in {100 * feats['frac_far']:.0f} % of the windows"
             + ("" if lev == "good" else " (typical for a motorcycle or a shaky mount)"))
    W.log("info", f"vehicle: estimated {est['vehicle']} ({est['n_votes']} votes), requested {P['vehicle']}, effective {eff}")
    W.progress(100.0, "done", force=True)
    return dict(vehicle=eff, estimated=est["vehicle"], yaw_ratio=ratio)
