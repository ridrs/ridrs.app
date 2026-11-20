# SPDX-License-Identifier: AGPL-3.0-or-later
"""DEVELOPMENT-ONLY regression bench of rsm.pipeline (not frozen, not in the sidecar). Runs the cases of regress_cases.json and scores them into one table.

    scripts/heavy.sh .venv/bin/python -m rsm.bench.regress --tag base --code head                       # baseline: the pipeline of git HEAD
    scripts/heavy.sh .venv/bin/python -m rsm.bench.regress --tag a1 --code overlay --from-step route_search --seed-tag base --baseline base
    .venv/bin/python -m rsm.bench.regress --tag a1 --score-only --baseline base                          # re-score, light

--code head      a snapshot of git HEAD under work/regress/_code/head (the baseline; safe while the working tree is being edited)
--code overlay   that snapshot plus the working-tree files named in OVERLAY (the accuracy files), under work/regress/_code/<tag>
--code work      the working tree itself
Every case runs in work/regress/<tag>/<case>/. The steps before --from-step are copied from --seed-tag (or, for motion and rotation, from the case's `seed` run), so only
the changed steps run. The steps are started as `python -m rsm.pipeline _step` workers, one after the other (the checkpoints of the CLI are not used: the bench decides
what is reused). Every pipeline run is heavy: use scripts/heavy.sh. Output: work/regress/<tag>/table.md and table.json; with --baseline the differences to that table.
--displaced runs route_search on three search frames that do NOT contain the route (verdict check, plan A4) into work/regress/<tag>/<case>@<dir>/."""
from __future__ import annotations

import argparse
import json
import os
import shutil
import subprocess
import sys
import time
from pathlib import Path

import numpy as np

from . import stepcache as SC

HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[1]
WORK = ROOT / "work" / "regress"
CACHE = WORK / "_cache"
STEPS = ["motion", "rotation", "map", "route_search", "plausibility", "refine", "gpx"]
# working-tree files laid over the HEAD snapshot by --code overlay (the files of the accuracy work; steps_a, cli, common ... stay at HEAD)
OVERLAY = ["rsm/pipeline/" + f for f in ("steps_b.py", "steps_c.py", "steps_d.py", "offset.py", "verdict.py", "align.py", "local.py", "osm.py", "hints.py", "config.py", "calib.py", "lane.py",
                                         "line.py")] + ["rsm/network/graph.py", "rsm/hmm_cal/dp.py"]


# development data (see docs/README.md): test-data/ of this app (git-ignored), other videos and OSM extracts
for _k, _d in (("V2G_TEST_DATA", str(Path(__file__).resolve().parents[4] / "test-data")), ("RSM_VIDEOS", str(Path(__file__).resolve().parents[4] / "test-data" / "sources")), ("RSM_OSM_DIR", "~/rsm-data/osm")):
    os.environ.setdefault(_k, os.path.expanduser(_d))


def _x(s: str) -> str:
    return os.path.expanduser(os.path.expandvars(s))


def cases(only=None) -> list[dict]:
    cs = json.loads((HERE / "regress_cases.json").read_text())["cases"]
    return [c for c in cs if not only or c["name"] in only]


def box(b) -> dict:
    return dict(south=b[0], west=b[1], north=b[2], east=b[3])


def params(c: dict) -> dict:
    pbf = Path(_x(c["pbf"])) if os.path.isabs(_x(c["pbf"])) else ROOT / c["pbf"]
    P = dict(video=str(Path(_x(c["video"])).resolve()), bbox=box(c["bbox"]), pbf=str(pbf), vehicle=c.get("vehicle", "auto"), offset_m=None, start_time=None, traffic_side="auto", decoys=0,
             start_tol_m=150.0, hint_buffer_m=300.0, hint_fallback="auto")
    if c.get("start_bbox"):
        P["start_bbox"] = box(c["start_bbox"])
    P.update(c.get("params", {}))
    return P


# ------------------------------------------------------------------ code
def code_dir(mode: str, tag: str) -> Path:
    if mode == "work":
        return ROOT
    repo = subprocess.run(["git", "rev-parse", "--show-toplevel"], cwd=ROOT, capture_output=True, text=True, check=True).stdout.strip()
    rel = str(ROOT.relative_to(Path(repo).resolve()))
    dst = WORK / "_code" / ("head" if mode == "head" else tag)
    if mode == "head" and (dst / "rsm").exists():
        return dst
    if dst.exists():
        shutil.rmtree(dst)
    dst.mkdir(parents=True)
    ar = subprocess.Popen(["git", "archive", f"HEAD:{rel}", "rsm"], cwd=repo, stdout=subprocess.PIPE)
    subprocess.run(["tar", "-x", "-C", str(dst)], stdin=ar.stdout, check=True)
    ar.wait()
    head = subprocess.run(["git", "rev-parse", "--short", "HEAD"], cwd=repo, capture_output=True, text=True).stdout.strip()
    used = []
    if mode == "overlay":
        for f in OVERLAY:
            if (ROOT / f).exists():
                shutil.copy2(ROOT / f, dst / f)
                used.append(f)
    (dst / "CODE.json").write_text(json.dumps(dict(mode=mode, head=head, overlay=used, made=time.strftime("%Y-%m-%dT%H:%M:%S")), indent=1))
    return dst


# ------------------------------------------------------------------ run
def copy_step(src: Path, dst: Path, sid: str) -> bool:
    if not (src / sid).is_dir() or not (src / "steps" / f"{sid}.done.json").exists():
        return False
    if (dst / sid).exists():
        shutil.rmtree(dst / sid)
    shutil.copytree(src / sid, dst / sid)
    (dst / "steps").mkdir(exist_ok=True)
    shutil.copy2(src / "steps" / f"{sid}.done.json", dst / "steps" / f"{sid}.done.json")
    return True


def run_step(code: Path, d: Path, sid: str, log) -> dict:
    env = dict(os.environ, PYTHONUNBUFFERED="1", PYTHONDONTWRITEBYTECODE="1", RSM_DATA_DIR=str(WORK / "_data"), RSM_SCAN_MEMO="1")
    t0 = time.time()
    (d / "logs").mkdir(exist_ok=True)
    with open(d / "logs" / f"{sid}.err.log", "w") as err:
        p = subprocess.Popen([sys.executable, "-m", "rsm.pipeline", "_step", sid, "--dir", str(d)], cwd=code, env=env, stdout=subprocess.PIPE, stderr=err, text=True, bufsize=1)
        summary, statuses = None, []
        with open(d / "events.jsonl", "a") as evf:
            for line in p.stdout:
                try:
                    ev = json.loads(line)
                except ValueError:
                    continue
                if ev.get("type") != "progress":
                    evf.write(line)
                if ev.get("type") == "status":
                    statuses.append(ev)
                elif ev.get("type") == "summary":
                    summary = ev["summary"]
                elif ev.get("type") == "log" and ev.get("level") in ("warn", "error"):
                    log(f"    {sid} {ev['level']}: {ev['message'][:200]}")
        rc = p.wait()
    rec = dict(id=sid, in_hash="bench", seconds=round(time.time() - t0, 1), peak_gb=None, summary=summary, statuses=statuses, finished=time.strftime("%Y-%m-%dT%H:%M:%S"))
    if rc != 0:
        raise RuntimeError(f"step {sid} failed (exit {rc}); see {d / 'logs' / (sid + '.err.log')}")
    (d / "steps" / f"{sid}.done.json").write_text(json.dumps(rec, indent=1, default=float))
    return rec


def run_case(c: dict, tag: str, code: Path, from_step: str | None, seed_tag: str | None, log=print, d: Path | None = None, P: dict | None = None, until: str = "gpx",
             cache: bool = True) -> Path:
    """cache (default, block A of docs/CONCEPT_fast_testing.md): every step is taken from the step cache when its key (code closure, config values, params,
    previous step) is there, else run and stored. --from-step / --seed-tag switch back to the old hand-chosen reuse."""
    d = d or WORK / tag / c["name"]
    d.mkdir(parents=True, exist_ok=True)
    (d / "steps").mkdir(exist_ok=True)
    P = P or params(c)
    for f in ((P["video"],) if until in ("motion", "rotation") else (P["video"], P["pbf"])):
        if not Path(f).exists():
            raise FileNotFoundError(f)
    (d / "project.params.json").write_text(json.dumps(P, indent=1))
    if cache and not from_step and not seed_tag:
        return _run_cached(c, d, P, code, log, until)
    first = STEPS.index(from_step) if from_step else 0
    todo = []
    for i, sid in enumerate(STEPS[:STEPS.index(until) + 1]):
        if sid == "plausibility":
            (d / "steps" / f"{sid}.done.json").write_text(json.dumps(dict(id=sid, in_hash="bench", skipped=True, seconds=0, peak_gb=None, summary=None, statuses=[])))
            continue
        have = (d / sid).is_dir() and (d / "steps" / f"{sid}.done.json").exists()
        if (i < first if from_step else True) and not todo:
            if have:
                continue
            srcs = [WORK / seed_tag / c["name"]] if seed_tag else []
            if sid in ("motion", "rotation"):
                srcs += ([ROOT / c["seed"]] if c.get("seed") else []) + [x for x in sorted(WORK.glob(f"*/{c['name']}")) if x != d]
            if any(copy_step(s, d, sid) for s in srcs):
                log(f"  {sid}: reused")
                continue
        todo.append(sid)                                       # from the first step that runs, every later step runs too
    for sid in todo:
        if (d / sid).exists():
            shutil.rmtree(d / sid)
        (d / sid).mkdir()
        rec = run_step(code, d, sid, log)
        log(f"  {sid}: {rec['seconds']:.0f} s")
    return d


def _run_cached(c: dict, d: Path, P: dict, code: Path, log, until: str) -> Path:
    steps = STEPS[:STEPS.index(until) + 1]
    keys = SC.step_keys(code, P, steps)
    for sid in steps:
        if sid == "plausibility":
            (d / "steps" / f"{sid}.done.json").write_text(json.dumps(dict(id=sid, in_hash="bench", skipped=True, seconds=0, peak_gb=None, summary=None, statuses=[])))
            continue
        if SC.fetch(CACHE, c["name"], sid, keys[sid], d):
            log(f"  {sid}: cached ({keys[sid]})")
            continue
        if (d / sid).exists():
            shutil.rmtree(d / sid)
        (d / sid).mkdir()
        rec = run_step(code, d, sid, log)
        SC.store(CACHE, c["name"], sid, keys[sid], d)
        log(f"  {sid}: {rec['seconds']:.0f} s (stored {keys[sid]})")
    return d


def adopt(c: dict, src: Path, steps: list[str], code: Path, log=print) -> list[str]:
    """put the finished steps of an earlier run (src = work/regress/<tag>/<case> or a seed run) into the step cache under the keys of the CURRENT code.
    The caller asserts that these steps are what the current code would compute (for example motion / rotation of f4seed). Only a leading chain of
    steps can be adopted (a later step's key depends on the earlier ones)."""
    P = params(c)
    keys = SC.step_keys(code, P, STEPS)
    done = []
    for sid in STEPS:
        if sid not in steps:
            break
        if sid == "plausibility":
            continue
        if not ((src / sid).is_dir() and (src / "steps" / f"{sid}.done.json").exists()):
            log(f"  {c['name']} {sid}: not in {src}")
            break
        SC.store(CACHE, c["name"], sid, keys[sid], src, note=f"adopted from {src}")
        done.append(sid)
    return done


# ------------------------------------------------------------------ scoring
class PathView:
    def __init__(self, sg, xy):
        self.sg, self.xy = sg, xy

    def xy_at(self, s):
        s = np.clip(np.asarray(s, float), 0, self.sg[-1])
        return np.column_stack([np.interp(s, self.sg, self.xy[:, 0]), np.interp(s, self.sg, self.xy[:, 1])])


def base_row(d: Path) -> dict:
    pj = json.loads((d / "project.json").read_text())
    rs = pj["steps"]["route_search"]["summary"]
    rf = pj["steps"]["refine"]["summary"]
    sig = pj["verdict_detail"].get("signals", {})
    dl = pj.get("driving_line", {})
    row = dict(verdict=pj["verdict"], f_eff=rs["f_eff"], kappa=rs["kappa"], score_per_km=rs["score_per_km"], conf_mean=rs["conf_mean"], peak_interior=sig.get("peak_interior"),
               route_km=rf.get("path_km"), min_g=dl.get("min_length_element"), loops=dl.get("has_loops"), line=dl.get("layer", "fixed") + ("+L2" if dl.get("l2") else ""),
               seconds={s: pj["steps"][s].get("seconds") for s in ("route_search", "refine", "gpx") if s in pj["steps"]})
    st = {s["signal"]: s for sid in STEPS for s in pj["steps"].get(sid, {}).get("statuses", [])}
    for k in ("calibration_choice", "parallel_street"):
        if k in st:
            row[k] = st[k]["message"]
    if "prior_decided_share" in rf:
        row["prior_decided_share"] = rf["prior_decided_share"]
    return row


def score_gps(c: dict, d: Path) -> dict:
    """GPS scoring as rsm.pipeline.validate.roanne / work/blind/score.py: the GPS is used for scoring only. Lag between GPS and video clock: work/vangestel/align_<name>.json
    if it exists (dev videos), else estimated from the yaw rates (blind rule, span 5 s)."""
    from rsm.bench import gps_truth as GT
    from rsm.refine import evaluate
    R = np.load(d / "refine" / "result.npz")
    crs = str(R["crs"])
    rp = json.loads((d / "route_points.json").read_text())["points"]
    tv, gxy_of, lag = GT.video_time_gps(c["gps"], crs, d / "motion" / "motion.csv")
    path = PathView(R["sg"], R["xy"])
    t_all, ext = R["t"], R["extrap"]
    sel = (t_all >= tv[0]) & (t_all <= tv[-1]) & ~ext
    tt, s = t_all[sel], R["s"][sel]
    g = gxy_of(tt)
    s_gps, cross = evaluate.project_dp(path, g, s)
    d_pos = np.hypot(*(path.xy_at(s) - g).T)
    road = (cross <= 20.0) & (np.abs(s_gps - s) <= 300.0)
    err = s - s_gps
    out = dict(n_scored=int(len(tt)), lag=lag, correct_road=float(road.mean()), off_road_seconds=_runs(tt[~road]))
    if road.any():
        a = np.abs(err[road])
        sc = evaluate.signed_cross(path, s_gps, g)                                   # GPS offset from the centre line, + = left of travel
        off = np.array([p["offset_m"] for p in rp])[sel]                             # applied driving-line offset, + = right
        out.update(along_median=float(np.median(a)), along_p90=float(np.percentile(a, 90)), along_w10=float((a <= 10).mean()), along_w30=float((a <= 30).mean()),
                   along_signed_median=float(np.median(err[road])),
                   cross_centre_median=float(np.median(np.abs(sc[road]))), cross_line_median=float(np.median(np.abs(sc[road] + off[road]))),
                   cross_signed_median=float(np.median(sc[road])), cross_line_signed_median=float(np.median(sc[road] + off[road])))
        np.savez_compressed(d / "gps_score.npz", t=tt, s=s, s_gps=s_gps, signed_cross=sc, road=road, offset=off, err=err, gx=g[:, 0], gy=g[:, 1])
    return out


def _runs(t, gap=2.0) -> list:
    """[t0, t1] runs of the seconds in t"""
    out = []
    for x in np.asarray(t, float):
        if out and x - out[-1][1] <= gap:
            out[-1][1] = float(x)
        else:
            out.append([float(x), float(x)])
    return out


def score_landmarks(c: dict, d: Path) -> dict:
    """lateness of the route at landmarks with a known video second: time at which the route passes the path point nearest to the landmark (searched within +-150 s) minus the truth"""
    from pyproj import Transformer
    L = json.loads((HERE / "regress_landmarks.json").read_text())[c["name"]]
    R = np.load(d / "refine" / "result.npz")
    tr = Transformer.from_crs(4326, str(R["crs"]), always_xy=True)
    t, s = R["t"], R["s"] + 1e-6 * np.arange(len(R["s"]))
    rows = []
    for lm in L:
        x, y = tr.transform(lm["lon"], lm["lat"])
        m = np.abs(t - lm["t"]) <= 150
        a0, a1 = int(max(s[m].min() - 1, 0)), int(min(s[m].max() + 2, len(R["sg"])))
        dd = np.hypot(R["xy"][a0:a1, 0] - x, R["xy"][a0:a1, 1] - y)
        j = int(np.argmin(dd))
        rows.append(dict(name=lm["name"], late_s=float(np.interp(R["sg"][a0 + j], s, t) - lm["t"]), dist_m=float(dd[j])))
    late = np.array([r["late_s"] for r in rows])
    return dict(landmarks=rows, landmark_mean_abs_s=float(np.abs(late).mean()), landmark_max_abs_s=float(np.abs(late).max()))


def score_checkpoints(c: dict, d: Path, L: list | None = None) -> dict:
    """distance between the route's position at the video second of each checkpoint (read from the frames, regress_landmarks.json) and the checkpoint;
    a checkpoint is hit when the distance is within its tolerance tol_m (default 50 m)"""
    from pyproj import Transformer
    L = L if L is not None else json.loads((HERE / "regress_landmarks.json").read_text())[c["name"]]
    R = np.load(d / "refine" / "result.npz")
    tr = Transformer.from_crs(4326, str(R["crs"]), always_xy=True)
    pos = PathView(R["sg"], R["xy"]).xy_at(np.interp([cp["t"] for cp in L], R["t"], R["s"]))
    rows = []
    for cp, p in zip(L, pos):
        x, y = tr.transform(cp["lon"], cp["lat"])
        dist = float(np.hypot(p[0] - x, p[1] - y))
        tol = float(cp.get("tol_m", 50.0))
        rows.append(dict(name=cp["name"], t=cp["t"], dist_m=dist, tol_m=tol, ok=dist <= tol))
    dd = np.array([r["dist_m"] for r in rows])
    return dict(checkpoints=rows, cp_ok=f"{sum(r['ok'] for r in rows)}/{len(rows)}", cp_median_m=float(np.median(dd)), cp_max_m=float(dd.max()))


def score_amalfi(c: dict, d: Path) -> dict:
    from rsm.pipeline import validate
    r = validate.amalfi(d)
    return dict(tunnels=f"{r['tunnels']['hits']}/{r['tunnels']['n']}", tunnel_p_shift=r["tunnels"]["p_shift"], vietri_m=r["vietri_window_m"], erchie_m=r["erchie_window_m"])


def same_route(d: Path, ref: Path, tol: float = 50.0) -> dict:
    """share of the seconds where the per-second position of run d lies within tol m of the path of run ref (route identity), and within tol m of ref's position at that second"""
    from pyproj import Transformer
    from scipy.spatial import cKDTree
    A, B = np.load(d / "refine" / "result.npz"), np.load(ref / "refine" / "result.npz")
    pa = PathView(A["sg"], A["xy"]).xy_at(A["s"])
    bxy, pb = B["xy"], PathView(B["sg"], B["xy"]).xy_at(B["s"])
    if str(A["crs"]) != str(B["crs"]):
        tr = Transformer.from_crs(str(B["crs"]), str(A["crs"]), always_xy=True)
        bxy = np.column_stack(tr.transform(bxy[:, 0], bxy[:, 1]))
        pb = np.column_stack(tr.transform(pb[:, 0], pb[:, 1]))
    ok = ~A["extrap"]
    dist = cKDTree(bxy).query(pa[ok])[0]
    n = min(len(pa), len(pb))
    both = ok[:n] & ~B["extrap"][:n]
    dt = np.hypot(*(pa[:n] - pb[:n]).T)[both]
    return dict(same_road_share=float((dist <= tol).mean()), same_position_share=float((dt <= tol).mean()) if both.any() else float("nan"),
                position_diff_median_m=float(np.median(dt)) if both.any() else float("nan"))


def score_case(c: dict, d: Path, log=print) -> dict:
    row = dict(case=c["name"])
    try:
        row.update(base_row(d))
        kind = c.get("score", "none")
        if kind == "gps":
            row.update(score_gps(c, d))
        elif kind == "landmarks":
            row.update(score_landmarks(c, d))
        elif kind == "checkpoints":
            row.update(score_checkpoints(c, d))
        elif kind == "amalfi":
            row.update(score_amalfi(c, d))
        if c.get("same_route_as") and (d.parent / c["same_route_as"] / "refine" / "result.npz").exists():
            row.update({f"vs_{c['same_route_as']}_{k}": v for k, v in same_route(d, d.parent / c["same_route_as"]).items()})
    except Exception as e:  # noqa: BLE001  a failed case is a row of the table, not the end of the bench
        row["error"] = f"{type(e).__name__}: {e}"
        log(f"  score error: {row['error']}")
    return row


# ------------------------------------------------------------------ table
COLS = [("verdict", "verdict", "{}"), ("f_eff", "f_eff", "{:.0f}"), ("kappa", "kappa", "{:.2f}"), ("conf_mean", "post", "{:.3f}"), ("correct_road", "road %", "{:.1%}"),
        ("along_median", "along med m", "{:.2f}"), ("along_p90", "p90 m", "{:.1f}"), ("along_w10", "<=10 m", "{:.0%}"), ("along_w30", "<=30 m", "{:.0%}"),
        ("cross_centre_median", "cross centre m", "{:.2f}"), ("cross_line_median", "cross line m", "{:.2f}"), ("cross_line_signed_median", "GPS-line signed m", "{:+.2f}"),
        ("landmark_mean_abs_s", "lm mean s", "{:.1f}"), ("landmark_max_abs_s", "lm max s", "{:.1f}"), ("cp_ok", "cp ok", "{}"), ("cp_median_m", "cp med m", "{:.0f}"), ("cp_max_m", "cp max m", "{:.0f}"), ("line", "line", "{}"), ("min_g", "min g", "{:.2f}")]


def fmt_table(rows: list[dict], base: dict | None = None) -> str:
    out = ["| case | " + " | ".join(h for _, h, _ in COLS) + " | notes |", "|---|" + "---|" * (len(COLS) + 1)]
    for r in rows:
        cells = []
        b = (base or {}).get(r["case"], {})
        for k, _, f in COLS:
            v = r.get(k)
            if v is None:
                cells.append("")
                continue
            s = f.format(v)
            bv = b.get(k)
            if bv is not None and isinstance(v, (int, float)) and not isinstance(v, bool) and isinstance(bv, (int, float)) and abs(v - bv) > 1e-9:
                s += f" ({f.format(bv)})"
            elif bv is not None and isinstance(v, str) and v != bv:
                s += f" ({bv})"
            cells.append(s)
        notes = [r[k] for k in ("error",) if k in r]
        notes += [f"{k[3:]} {v:.1%}" for k, v in r.items() if k.startswith("vs_") and k.endswith("same_road_share")]
        notes += [f"vs baseline: same road {r['vs_base_same_road_share']:.1%}, position diff median {r['vs_base_position_diff_median_m']:.1f} m"] if "vs_base_same_road_share" in r else []
        notes += [f"tunnels {r['tunnels']}, Vietri {r['vietri_m']:.0f} m, Erchie {r['erchie_m']:.0f} m"] if "tunnels" in r else []
        notes += [f"prior-decided {r['prior_decided_share']:.1%}"] if "prior_decided_share" in r else []
        notes += ["checkpoints (s: m, ! = outside tol): " + ", ".join(f"{cp['t']:g}: {cp['dist_m']:.0f}" + ("" if cp["ok"] else "!") for cp in r["checkpoints"])] if r.get("checkpoints") else []
        if r.get("off_road_seconds"):
            notes.append("off road: " + ", ".join(f"{a:.0f}-{b_:.0f}" for a, b_ in r["off_road_seconds"][:6]) + (" ..." if len(r["off_road_seconds"]) > 6 else ""))
        out.append(f"| {r['case']} | " + " | ".join(cells) + " | " + "; ".join(notes) + " |")
    return "\n".join(out) + "\n"


def write_table(tag: str, rows: list[dict], baseline: str | None):
    f = WORK / tag / "table.json"
    old = {r["case"]: r for r in json.loads(f.read_text())["rows"]} if f.exists() else {}
    old.update({r["case"]: r for r in rows})
    order = [c["name"] for c in cases()]
    rows = sorted(old.values(), key=lambda r: (order.index(r["case"].split("@")[0]) if r["case"].split("@")[0] in order else 99, r["case"]))
    base = None
    if baseline and (WORK / baseline / "table.json").exists():
        base = {r["case"]: r for r in json.loads((WORK / baseline / "table.json").read_text())["rows"]}
    code = WORK / "_code" / tag / "CODE.json"
    f.write_text(json.dumps(dict(tag=tag, baseline=baseline, made=time.strftime("%Y-%m-%dT%H:%M:%S"), code=json.loads(code.read_text()) if code.exists() else None, rows=rows), indent=1, default=float))
    head = f"# regress {tag}" + (f" (values of the baseline `{baseline}` in brackets where they differ)" if base else "") + "\n\n"
    (WORK / tag / "table.md").write_text(head + fmt_table(rows, base))
    return rows, base


# ------------------------------------------------------------------ displaced frames (A4)
def displaced(c: dict, factor: float = 1.5) -> dict:
    """three search frames of the same size that do not contain the route: shifted by `factor` frame sizes east, west and north or south (inside the extract is checked by the map step)"""
    s, w, n, e = c["bbox"]
    h, b = n - s, e - w
    return {"E": [s, w + factor * b, n, e + factor * b], "W": [s, w - factor * b, n, e - factor * b], "N": [s + factor * h, w, n + factor * h, e], "S": [s - factor * h, w, n - factor * h, e]}


def run_displaced(c: dict, tag: str, code: Path, log=print) -> list[dict]:
    rows = []
    for name, bb in displaced(c).items():
        if len([r for r in rows if "verdict" in r]) >= 3:
            break
        d = WORK / tag / f"{c['name']}@{name}"
        cc = dict(c, bbox=bb)
        cc.pop("start_bbox", None)
        row = dict(case=f"{c['name']}@{name}")
        try:
            if not (d / "steps" / "route_search.done.json").exists():
                for sid in ("motion", "rotation"):
                    d.mkdir(parents=True, exist_ok=True)
                    (d / "steps").mkdir(exist_ok=True)
                    if not any(copy_step(s_, d, sid) for s_ in [WORK / tag / c["name"]] + sorted(WORK.glob(f"*/{c['name']}"))):
                        raise RuntimeError(f"no {sid} of {c['name']} to reuse")
                run_case(cc, tag, code, "map", None, log, d=d, until="route_search")
            import pickle
            sys.path.insert(0, str(code))
            from rsm.pipeline import verdict as V
            rs = pickle.load(open(d / "route_search" / "route.pkl", "rb"))
            v = V.verdict_from(rs, json.loads((d / "motion" / "summary.json").read_text()), json.loads((d / "rotation" / "summary.json").read_text())["features"])
            row.update(verdict=v["verdict"], f_eff=rs["f_eff"], kappa=rs["kappa"], conf_mean=rs["conf_mean"], score_per_km=rs["score_per_km"], reasons=v["reasons"])
        except Exception as e:  # noqa: BLE001
            row["error"] = f"{type(e).__name__}: {e}"
        log(f"  {row['case']}: {row.get('verdict', row.get('error'))}")
        rows.append(row)
    return rows


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(prog="rsm.bench.regress")
    ap.add_argument("--tag", required=True)
    ap.add_argument("--code", default="overlay", choices=["head", "overlay", "work"])
    ap.add_argument("--only", default=None, help="comma-separated case names")
    ap.add_argument("--from-step", default=None, choices=STEPS, help="run from this step on (earlier steps are reused); default: run what is missing")
    ap.add_argument("--seed-tag", default=None, help="tag whose finished steps before --from-step are copied")
    ap.add_argument("--baseline", default=None, help="tag to compare with")
    ap.add_argument("--score-only", action="store_true")
    ap.add_argument("--displaced", action="store_true", help="verdict check on displaced search frames (route_search only)")
    ap.add_argument("--keep-code", action="store_true", help="reuse work/regress/_code/<tag> as it is")
    ap.add_argument("--no-cache", action="store_true", help="do not use the step cache (work/regress/_cache)")
    ap.add_argument("--adopt", default=None, help="tag (or path pattern with {case}) whose finished steps go into the step cache under the current keys")
    ap.add_argument("--adopt-steps", default="motion,rotation,map", help="leading steps to adopt (default motion,rotation,map)")
    a = ap.parse_args(argv)
    only = a.only.split(",") if a.only else None
    log = lambda m: print(time.strftime("%H:%M:%S"), m, flush=True)
    code = None
    if not a.score_only:
        code = WORK / "_code" / a.tag if (a.keep_code and (WORK / "_code" / a.tag / "rsm").exists()) else code_dir(a.code, a.tag)
        (WORK / "_data").mkdir(parents=True, exist_ok=True)
    if a.adopt:
        root = code or ROOT
        for c in cases(only):
            src = Path(a.adopt.format(case=c["name"])) if "{case}" in a.adopt else WORK / a.adopt / c["name"]
            log(f"adopt {c['name']} from {src}: {', '.join(adopt(c, src, a.adopt_steps.split(','), root, log)) or 'nothing'}")
        return 0
    rows = []
    for c in cases(only):
        log(f"case {c['name']}")
        if a.displaced:
            rows += run_displaced(c, a.tag, code, log)
            continue
        d = WORK / a.tag / c["name"]
        if not a.score_only:
            try:
                run_case(c, a.tag, code, a.from_step, a.seed_tag, log, cache=not a.no_cache)
            except (RuntimeError, FileNotFoundError) as e:
                log(f"  FAILED: {e}")
                rows.append(dict(case=c["name"], error=f"{type(e).__name__}: {e}"))
                continue
        if not (d / "project.json").exists():
            continue
        row = score_case(c, d, log)
        if a.baseline and (WORK / a.baseline / c["name"] / "refine" / "result.npz").exists() and "error" not in row:
            row.update({f"vs_base_{k}": v for k, v in same_route(d, WORK / a.baseline / c["name"]).items()})
        rows.append(row)
    if a.displaced:
        f = WORK / a.tag / "displaced.json"
        old = {r["case"]: r for r in json.loads(f.read_text())} if f.exists() else {}
        old.update({r["case"]: r for r in rows})
        f.write_text(json.dumps(list(old.values()), indent=1, default=float))
        n_conf = sum(r.get("verdict") == "confident" for r in old.values())
        log(f"displaced frames: {len(old)} runs, {n_conf} confident (pre-registered rule: none)")
        return 0
    rows, base = write_table(a.tag, rows, a.baseline)
    print(fmt_table(rows, base))
    return 0


if __name__ == "__main__":
    sys.exit(main())
