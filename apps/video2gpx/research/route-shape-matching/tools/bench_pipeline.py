# SPDX-License-Identifier: AGPL-3.0-or-later
"""Benchmark and identity check of the pipeline (speed work, plan S0).

    scripts/heavy.sh .venv/bin/python tools/bench_pipeline.py --case clip --out work/bench/<name> [--baseline work/bench/<other>/bench.json]

It runs the pipeline as a subprocess (the code of --src, default: this checkout) and writes OUT/bench.json: step seconds, peak GB, CPU seconds of all
child processes, worker count, code hash and the identity manifest. With --baseline it compares the manifest with an earlier bench.json and exits 1 on
a difference. The manifest:

  L0 (identical): motion/motion.csv; rotation/win_video_base.npz (data, ok, n_pts, n_inl, why); rotation/tracks.pkl; rotation/vehicle.json without
     requested / effective; the in_hash of every step; route_search step_cell, f_eff, kappa; refine/result.npz; route_points.json points.
  L1: route_search scan: max abs difference <= 1e-3 nats and the same argmax.

Cases: clip = the first 300 s of Roanne (stream copy, made on first use), roanne = the whole video, madone = the 4K HDR VP9 video (analysis only).
Video-derived data: everything goes to --out, which must lie under work/ (git-ignored).
"""
from __future__ import annotations

import argparse
import hashlib
import json
import os
import pickle
import resource
import signal
import subprocess
import sys
import time
from pathlib import Path

import numpy as np

HERE = Path(__file__).resolve().parents[1]
VG = Path(__file__).resolve().parents[3] / "test-data" / "sources" / "vangestel"  # Van Gestel rides, git-ignored (docs/README.md)
ROANNE = dict(video=str(VG / "vallee-de-roanne/video.mp4"), bbox="44.50826,4.98126,44.86798,5.48725",
              pbf=str(Path(os.environ.get("RSM_OSM_DIR", "~/rsm-data/osm")).expanduser() / "rhone-alpes.osm.pbf"))
MADONE_DIR = Path(os.environ.get("RSM_VIDEOS", str(Path(__file__).resolve().parents[3] / "test-data" / "sources"))).expanduser() / "madone"
ANALYSIS = ("motion", "rotation")
L1_TOL = 1e-3


# ------------------------------------------------------------------ manifest
def _h(b: bytes) -> str:
    return hashlib.sha256(b).hexdigest()[:20]


def _arr(a) -> str:
    a = np.ascontiguousarray(np.asarray(a))
    return _h(str(a.dtype).encode() + str(a.shape).encode() + a.tobytes())


def manifest(d: Path) -> dict:
    """identity manifest of a run directory; parts whose files are missing are left out"""
    d = Path(d)
    m: dict = {}
    f = d / "motion" / "motion.csv"
    if f.exists():
        m["motion.csv"] = _h(f.read_bytes())
    f = d / "rotation" / "win_video_base.npz"
    if f.exists():
        z = np.load(f)
        for k in ("data", "ok", "n_pts", "n_inl", "why"):
            m[f"win.{k}"] = _arr(z[k])
    f = d / "rotation" / "tracks.pkl"
    if f.exists():
        tr = pickle.load(open(f, "rb"))
        m["tracks"] = _h("".join(_arr(t[k]) for t in tr for k in sorted(t)).encode() + str(len(tr)).encode())
    f = d / "rotation" / "vehicle.json"
    if f.exists():
        v = json.loads(f.read_text())
        m["vehicle.estimate"] = _h(json.dumps({k: x for k, x in v.items() if k not in ("requested", "effective")}, sort_keys=True).encode())
    hs = {}
    for g in sorted((d / "steps").glob("*.done.json")):
        hs[g.name.split(".")[0]] = json.loads(g.read_text()).get("in_hash")
    if hs:
        m["in_hash"] = hs
    f = d / "route_search" / "route.pkl"
    if f.exists():
        r = pickle.load(open(f, "rb"))
        m["route.scan"] = np.asarray(r["scan"], float).tolist()
        m["route.f_eff"], m["route.kappa"] = float(r["f_eff"]), float(r["kappa"])
        m["route.step_cell"] = _arr(r["step_cell"])
    f = d / "refine" / "result.npz"
    if f.exists():
        z = np.load(f, allow_pickle=False)
        m["refine"] = {k: _arr(z[k]) for k in sorted(z.files)}
    f = d / "route_points.json"
    if f.exists():
        m["route_points"] = _h(json.dumps(json.loads(f.read_text())["points"], sort_keys=True).encode())
    return m


def compare(base: dict, new: dict, keys=None) -> list[str]:
    """differences between two manifests (empty list = identical by the L0 / L1 rules). Only keys present in both are compared, plus a note for missing ones."""
    out = []
    for k in sorted(set(base) | set(new)):
        if keys is not None and k not in keys:
            continue
        if k not in base or k not in new:
            out.append(f"{k}: only in {'baseline' if k in base else 'new'}")
            continue
        a, b = base[k], new[k]
        if k == "route.scan":
            A, B = np.array(a, float), np.array(b, float)
            if A.shape != B.shape:
                out.append(f"route.scan: shape {A.shape} != {B.shape}")
                continue
            ok = np.isfinite(A) & np.isfinite(B)
            if not np.array_equal(np.isfinite(A), np.isfinite(B)):
                out.append("route.scan: different finite cells")
            dmax = float(np.abs(A[ok] - B[ok]).max()) if ok.any() else 0.0
            if dmax > L1_TOL:
                out.append(f"route.scan: max abs difference {dmax:.3g} > {L1_TOL}")
            if ok.any() and np.nanargmax(np.where(ok, A, -np.inf)) != np.nanargmax(np.where(ok, B, -np.inf)):
                out.append("route.scan: different argmax")
        elif k == "in_hash":
            for s in sorted(set(a) & set(b)):
                if a[s] != b[s]:
                    out.append(f"in_hash.{s}: {a[s]} != {b[s]}")
        elif isinstance(a, dict):
            for s in sorted(set(a) | set(b)):
                if a.get(s) != b.get(s):
                    out.append(f"{k}.{s}: differs")
        elif a != b:
            out.append(f"{k}: differs")
    return out


# ------------------------------------------------------------------ cases
def make_clip(dst: Path, seconds: int = 300, src: str | None = None) -> Path:
    if not dst.exists():
        dst.parent.mkdir(parents=True, exist_ok=True)
        tmp = dst.with_suffix(".tmp" + dst.suffix)
        subprocess.run([os.environ.get("RSM_FFMPEG", "ffmpeg"), "-v", "error", "-nostdin", "-y", "-i", src or ROANNE["video"], "-t", str(seconds), "-an", "-c", "copy", str(tmp)], check=True)
        os.replace(tmp, dst)
    return dst


def case(name: str) -> dict:
    if name == "roanne":
        return dict(ROANNE)
    if name == "clip":
        return dict(ROANNE, video=str(make_clip(HERE / "work/bench/roanne_300s.mp4")))
    if name == "madone":
        v = sorted(MADONE_DIR.glob("video.webm"))
        if not v:
            raise SystemExit(f"no Madone video in {MADONE_DIR}")
        return dict(video=str(v[0]), bbox="43.70,7.33,43.85,7.55", pbf=ROANNE["pbf"], until="rotation")
    if name == "madone-clip":
        v = sorted(MADONE_DIR.glob("video.webm"))
        if not v:
            raise SystemExit(f"no Madone video in {MADONE_DIR}")
        return dict(video=str(make_clip(HERE / "work/bench/madone_300s.webm", src=str(v[0]))), bbox="43.70,7.33,43.85,7.55", pbf=ROANNE["pbf"], until="rotation")
    raise SystemExit(f"unknown case {name}")


# ------------------------------------------------------------------ run
def run_pipeline(src: Path, argv: list[str], env: dict, until: str | None, log: Path, kill_after: tuple[str, float] | None = None) -> dict:
    """run `python -m rsm.pipeline <argv>` with the code in src; -> dict(rc, wall, events of type step/prewarm, stopped)"""
    cmd = [sys.executable, "-m", "rsm.pipeline", *argv]
    t0 = time.time()
    p = subprocess.Popen(cmd, cwd=str(src), stdout=subprocess.PIPE, text=True, bufsize=1, env=env, start_new_session=True)
    steps, stopped, first_run = {}, False, {}
    with open(log, "a") as lf:
        lf.write(f"# {' '.join(cmd)}\n")
        for line in p.stdout:
            lf.write(line)
            try:
                ev = json.loads(line)
            except ValueError:
                continue
            if ev.get("type") == "step":
                sid = ev["id"]
                if ev["state"] == "running":
                    first_run.setdefault(sid, time.time())
                    if kill_after and kill_after[0] == sid and ev.get("pct", 0) >= kill_after[1] and not stopped:
                        stopped = True
                        os.killpg(p.pid, signal.SIGTERM)
                if ev["state"] in ("done", "skipped", "failed"):
                    steps[sid] = dict(state=ev["state"], wall=round(time.time() - first_run.get(sid, time.time()), 1))
                    if until and sid == until and ev["state"] in ("done", "skipped") and not stopped:
                        stopped = True
                        os.killpg(p.pid, signal.SIGTERM)
    rc = p.wait()
    return dict(rc=rc, wall=round(time.time() - t0, 1), steps=steps, stopped=stopped)


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--case", required=True, choices=["clip", "roanne", "madone", "madone-clip"])
    ap.add_argument("--out", required=True, help="bench directory under work/ (run/, data/, bench.json, events.jsonl)")
    ap.add_argument("--src", default=str(HERE), help="directory that holds the rsm package to run (default: this checkout)")
    ap.add_argument("--mode", default="run", choices=["run", "analyze", "analyze+run"], help="run: one `run`; analyze: `analyze` only; analyze+run: `analyze`, then `run --resume`")
    ap.add_argument("--until", default=None, help="stop the run after this step is done (old code has no `analyze`): e.g. rotation")
    ap.add_argument("--baseline", default=None, help="bench.json to compare the manifest with; exit 1 on a difference")
    ap.add_argument("--data-dir", default=None, help="RSM_DATA_DIR (default OUT/data: cold map cache)")
    ap.add_argument("--keep", action="store_true", help="keep OUT/run and resume it (default: start from scratch)")
    ap.add_argument("--env", action="append", default=[], help="KEY=VALUE for the pipeline process (repeatable)")
    ap.add_argument("--arg", action="append", default=[], help="extra argument for `run` (repeatable), e.g. --arg=--vehicle --arg=bike")
    a = ap.parse_args(argv)
    out = Path(a.out).resolve()
    if "work" not in out.parts:
        raise SystemExit("--out must lie under work/ (video-derived data is never committed)")
    c = case(a.case)
    until = a.until or c.get("until")
    run_d, data = out / "run", Path(a.data_dir).resolve() if a.data_dir else out / "data"
    if not a.keep:
        import shutil
        for p in (run_d, *( [] if a.data_dir else [data])):
            shutil.rmtree(p, ignore_errors=True)
        (out / "events.jsonl").unlink(missing_ok=True)
    out.mkdir(parents=True, exist_ok=True)
    env = dict(os.environ, RSM_DATA_DIR=str(data), PYTHONUNBUFFERED="1", **dict(e.split("=", 1) for e in a.env))
    src = Path(a.src).resolve()
    full = ["--video", c["video"], "--bbox", c["bbox"], "--pbf", c["pbf"], "--out", str(run_d), *a.arg]
    cpu0 = resource.getrusage(resource.RUSAGE_CHILDREN)
    t0 = time.time()
    runs = []
    if a.mode == "run":
        runs.append(run_pipeline(src, ["run", *full, *(["--resume"] if a.keep else [])], env, until, out / "events.jsonl"))
    else:
        runs.append(run_pipeline(src, ["analyze", "--video", c["video"], "--out", str(run_d), *(["--resume"] if a.keep else [])], env, None, out / "events.jsonl"))
        if a.mode == "analyze+run" and runs[-1]["rc"] == 0:
            runs.append(run_pipeline(src, ["run", *full, "--resume"], env, until, out / "events.jsonl"))
    wall = time.time() - t0
    cpu1 = resource.getrusage(resource.RUSAGE_CHILDREN)
    ok = all(r["rc"] == 0 or r["stopped"] for r in runs)
    steps = {}
    for g in sorted((run_d / "steps").glob("*.done.json")):
        j = json.loads(g.read_text())
        steps[j["id"]] = dict(seconds=j.get("seconds"), peak_gb=j.get("peak_gb"), skipped=bool(j.get("skipped")))
    code = subprocess.run([sys.executable, "-c", "from rsm.pipeline.common import code_hash; from rsm.pipeline import config as C; print(code_hash()[0], C.MAX_WORKERS)"],
                          cwd=str(src), capture_output=True, text=True).stdout.split()
    bench = dict(case=a.case, mode=a.mode, until=until, src=str(src), code_hash=code[0] if code else None, workers=int(code[1]) if len(code) > 1 else None, ok=ok,
                 wall_s=round(wall, 1), cpu_children_s=round(cpu1.ru_utime + cpu1.ru_stime - cpu0.ru_utime - cpu0.ru_stime, 1),
                 analysis_s=round(sum(steps[s]["seconds"] or 0 for s in ANALYSIS if s in steps), 1), steps=steps, runs=runs, env=a.env,
                 finished=time.strftime("%Y-%m-%dT%H:%M:%S"), manifest=manifest(run_d))
    (out / "bench.json").write_text(json.dumps(bench, indent=1))
    print(json.dumps({k: bench[k] for k in ("case", "mode", "code_hash", "ok", "wall_s", "cpu_children_s", "analysis_s", "steps")}, indent=1))
    if not ok:
        print("FAILED: the pipeline did not finish", file=sys.stderr)
        return 2
    if a.baseline:
        base = json.loads(Path(a.baseline).read_text())
        diff = compare(base["manifest"], bench["manifest"], keys=set(base["manifest"]) & set(bench["manifest"]))
        missing = sorted(set(base["manifest"]) - set(bench["manifest"]))
        print(f"baseline {a.baseline} (code {base.get('code_hash')}): wall {base['wall_s']} s -> {bench['wall_s']} s, analysis {base.get('analysis_s')} s -> {bench['analysis_s']} s")
        if missing:
            print("not compared (missing in the new run): " + ", ".join(missing))
        if diff:
            print("MANIFEST DIFFERS:\n  " + "\n  ".join(diff), file=sys.stderr)
            return 1
        print(f"manifest identical ({len(set(base['manifest']) & set(bench['manifest']))} parts)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
