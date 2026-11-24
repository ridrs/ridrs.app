#!/usr/bin/env python3
# SPDX-License-Identifier: AGPL-3.0-or-later
"""Run the snippet suite (video2gpx-runs/_testsuite/*/case.json) against a pipeline checkout and score it.

    $PY run_tests.py [--rsm DIR] [--only a,b] [--kind error] [--tag NAME] [--save-baseline] [--seed TAG --from-step STEP] [--list]

--rsm   the route-shape-matching directory whose code is tested (default: the runner worktree). To test a fix, point it at the
        worktree that has the fix; its .venv (or the runner's) is used.
--seed TAG --from-step refine   copy the finished run of tag TAG and rerun only from that step (the change must not touch earlier steps).

Each case runs `rsm.pipeline run` on its clip under scripts/heavy.sh (one heavy job at a time, memguard) and is scored:
checkpoints hit (distance <= tol_m at the checkpoint second), focus confidence, verdict, wall time. PASS = all checkpoints hit.
Results: _testsuite/_results/<tag>.md and .json, plus a comparison with each case's baseline.json.
"""
from __future__ import annotations

import argparse
import datetime as dt
import json
import os
import shutil
import subprocess
import sys
import time
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).parent))
from _lib import RUNS, SUITE, Path1D, jdump, jload, rsm_dir, transformer  # noqa: E402


def code_tag(rsm: Path) -> str:
    g = lambda *a: subprocess.run(["git", "-C", str(rsm), *a], capture_output=True, text=True).stdout.strip()
    h = g("rev-parse", "--short", "HEAD") or "nogit"
    dirty = "-dirty" if g("status", "--porcelain", "--untracked-files=no", "--", ".") else ""
    return f"{h}{dirty}-{dt.datetime.now():%m%d-%H%M}"


def score(case: dict, out: Path) -> dict:
    R = np.load(out / "refine" / "result.npz")
    path = Path1D(R["sg"], R["xy"])
    tr = transformer(str(R["crs"]), to_wgs=False)
    rows = []
    for cp in case["checkpoints"]:
        p = path.xy_at(np.interp([cp["t"]], R["t"], R["s"]))[0]
        x, y = tr.transform(cp["lon"], cp["lat"])
        d = float(np.hypot(p[0] - x, p[1] - y))
        tol = float(cp.get("tol_m", 50))
        rows.append(dict(name=cp["name"], t=cp["t"], dist_m=round(d, 1), tol_m=tol, ok=d <= tol, conf=round(float(np.interp(cp["t"], R["t"], R["conf"])), 3),
                         start_frame=bool(cp.get("start_frame"))))
    f0, f1 = case.get("focus") or [0, case["duration_s"]]
    sel = (R["t"] >= f0) & (R["t"] <= f1)
    pj = jload(out / "project.json")
    scored = [r for r in rows if not r["start_frame"]] or rows
    # backtrack: the shortest chord over 40 m of decoded path inside the focus window (a U-turn or loop makes it small)
    s0, s1 = np.interp([f0, f1], R["t"], R["s"])
    sg = np.arange(max(s0 - 20, R["sg"][0]), min(s1 + 20, R["sg"][-1]), 2.0)
    chord = None
    if len(sg) > 21:
        q = path.xy_at(sg)
        chord = round(float(np.min(np.hypot(*(q[20:] - q[:-20]).T))), 1)
    for w in (case.get("expect") or {}).get("no_backtrack_windows", []):
        # [t0, t1] or [t0, t1, max_turn_deg]: chord >= 15 m AND (if given) the path's total |turn| in the window <= max_turn_deg
        # (the video's turn there plus a margin; catches loops whose way back lies 10-25 m beside the way out)
        w0, w1 = w[0], w[1]
        a0, a1 = np.interp([w0, w1], R["t"], R["s"])
        g = np.arange(max(a0 - 20, R["sg"][0]), min(a1 + 20, R["sg"][-1]), 2.0)
        ch = round(float(np.min(np.hypot(*(path.xy_at(g)[20:] - path.xy_at(g)[:-20]).T))), 1) if len(g) > 21 else None
        g1 = np.arange(a0, a1, 1.0)
        tot = round(float(np.abs(np.degrees(np.diff(np.unwrap(np.radians(path.heading_at(g1, 2.0)))))).sum()), 0) if len(g1) > 2 else 0.0
        mx = float(w[2]) if len(w) > 2 else None
        ok = ch is not None and ch >= 15.0 and (mx is None or tot <= mx)
        rows.append(dict(name=f"no backtrack {w0:.0f}-{w1:.0f} s (chord >= 15 m{f', path turn <= {mx:.0f} deg' if mx else ''})", t=None, dist_m=ch, tol_m=15.0,
                         path_turn_deg=tot, max_turn_deg=mx, ok=ok, conf=None, start_frame=False, kind="no_backtrack"))
        scored = [r for r in rows if not r["start_frame"]]
    if (case.get("expect") or {}).get("no_backtrack"):
        rows.append(dict(name="no backtrack in focus (min chord over 40 m >= 15 m)", t=None, dist_m=chord, tol_m=15.0, ok=chord is not None and chord >= 15.0,
                         conf=None, start_frame=False, kind="no_backtrack"))
        scored = [r for r in rows if not r["start_frame"]]
    return dict(checkpoints=rows, min_chord_m=chord, cp_ok=sum(r["ok"] for r in scored), cp_n=len(scored), cp_max_m=max([r["dist_m"] for r in scored if r.get("kind") != "no_backtrack"] or [0.0]),
                focus_conf=round(float(R["conf"][sel].mean()), 3) if sel.any() else None, conf_mean=round(float(R["conf"][~R["extrap"]].mean()), 3),
                verdict=pj.get("verdict"), vehicle=(pj.get("effective") or {}).get("vehicle"),
                step_seconds={k: v.get("seconds") for k, v in (pj.get("steps") or {}).items()})


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--rsm", default=None)
    ap.add_argument("--only", default=None)
    ap.add_argument("--kind", default=None)
    ap.add_argument("--tag", default=None)
    ap.add_argument("--save-baseline", action="store_true")
    ap.add_argument("--seed", default=None)
    ap.add_argument("--from-step", default=None)
    ap.add_argument("--list", action="store_true")
    a = ap.parse_args()

    cases = sorted(p.parent for p in SUITE.glob("*/case.json"))
    if a.only:
        want = set(a.only.split(","))
        cases = [c for c in cases if c.name in want]
    if a.kind:
        cases = [c for c in cases if jload(c / "case.json")["kind"] == a.kind]
    if a.list or not cases:
        for c in cases:
            k = jload(c / "case.json")
            b = jload(c / "baseline.json") if (c / "baseline.json").exists() else None
            print(f"{c.name:45s} {k['kind']:18s} {k['duration_s']:5.0f} s  {len(k['checkpoints'])} cp  cause {k.get('cause')}  "
                  f"baseline {b['tag'] + ' ' + b['status'] + ' %.0f s' % b['wall_s'] if b else '-'}")
        if not cases:
            print("no cases", file=sys.stderr)
        return

    rsm = rsm_dir(a.rsm)
    py = rsm / ".venv/bin/python"
    if not py.exists():
        py = rsm_dir(None) / ".venv/bin/python"
    heavy = rsm.parents[1] / "scripts" / "heavy.sh"
    tag = a.tag or code_tag(rsm)
    print(f"code {rsm} -> tag {tag}")
    env = dict(os.environ, RSM_DATA_DIR=str(RUNS / "_cache"), PYTHONUNBUFFERED="1", RSM_DIR=str(rsm_dir(None)))
    results = []
    for c in cases:
        case = jload(c / "case.json")
        out = c / "runs" / tag
        if a.seed:
            src = c / "runs" / a.seed
            if not (src / "project.json").exists():
                sys.exit(f"{c.name}: no seed run {src}")
            if out.exists():
                shutil.rmtree(out)
            shutil.copytree(src, out, ignore=shutil.ignore_patterns("logs"))
        elif case.get("seed_dir"):
            # a full_seeded case: start from the finished full run every time, so only the steps from from_step on are this code's
            if out.exists():
                shutil.rmtree(out)
            shutil.copytree(case["seed_dir"], out, ignore=shutil.ignore_patterns("logs", "inspect", "_cache"))
        out.mkdir(parents=True, exist_ok=True)
        cmd = [str(py), "-m", "rsm.pipeline", "run", "--video", str(c / case["video"]), "--bbox", ",".join(map(str, case["bbox"])), "--pbf", case["pbf"],
               "--out", str(out), "--vehicle", case.get("vehicle") or "auto", "--decoys", str(case["params"].get("decoys", 0)),
               "--intro-end", str(case["params"].get("intro_end") or 0.01), "--resume"]
        if case.get("start_bbox"):
            cmd += ["--start-bbox", ",".join(map(str, case["start_bbox"]))]
        cmd += case.get("args", [])
        if a.from_step or case.get("from_step"):
            cmd += ["--from-step", a.from_step or case["from_step"]]
        full = ([str(heavy)] if heavy.exists() else []) + cmd
        t_start = time.time()
        with open(out / "progress.jsonl", "w") as log:
            rc = subprocess.run(full, cwd=rsm, env=env, stdout=log, stderr=subprocess.STDOUT).returncode
        wall = time.time() - t_start
        row = dict(case=c.name, kind=case["kind"], cause=case.get("cause"), rc=rc, wall_s=round(wall, 1), tag=tag)
        if rc == 0 and (out / "refine" / "result.npz").exists():
            row.update(score(case, out))
            row["status"] = "PASS" if row["cp_ok"] == row["cp_n"] else "FAIL"
        else:
            row["status"] = f"ERROR rc={rc}"
        b = jload(c / "baseline.json") if (c / "baseline.json").exists() else None
        if b:
            row["baseline"] = dict(tag=b["tag"], status=b["status"], cp_ok=b.get("cp_ok"), focus_conf=b.get("focus_conf"), wall_s=b.get("wall_s"))
            lost = [r["name"] for r, br in zip(row.get("checkpoints", []), b.get("checkpoints", [])) if br["ok"] and not r["ok"]]
            won = [r["name"] for r, br in zip(row.get("checkpoints", []), b.get("checkpoints", [])) if r["ok"] and not br["ok"]]
            dconf = (row.get("focus_conf") or 0) - (b.get("focus_conf") or 0)
            row["delta"] = dict(lost=lost, won=won, focus_conf=round(dconf, 3))
            row["verdict_vs_baseline"] = "REGRESSION" if lost else ("FIXED" if won and row["status"] == "PASS" else
                                                                     ("BETTER" if dconf > 0.1 else ("WORSE" if dconf < -0.1 else "SAME")))
        if a.save_baseline and row["status"] in ("PASS", "FAIL"):
            jdump(row, c / "baseline.json")
        results.append(row)
        print(f"  {c.name:45s} {row['status']:10s} cp {row.get('cp_ok', '-')}/{row.get('cp_n', '-')} max {row.get('cp_max_m', '-')} m  "
              f"focus conf {row.get('focus_conf')}  {wall:.0f} s  {row.get('verdict_vs_baseline', '')}")

    res = SUITE / "_results"
    jdump(dict(tag=tag, rsm=str(rsm), date=dt.datetime.now().isoformat(timespec="seconds"), results=results), res / f"{tag}.json")
    L = [f"# Snippet-Suite {tag}", "", f"Code: `{rsm}`", "", "| Fall | Art | Status | Checkpoints | max m | Sicherheit Fokus | Urteil | Zeit | ggü. Baseline |",
         "|---|---|---|---|---|---|---|---|---|"]
    for r in results:
        bl = r.get("baseline")
        L.append(f"| {r['case']} | {r['kind']} | {r['status']} | {r.get('cp_ok', '-')}/{r.get('cp_n', '-')} | {r.get('cp_max_m', '-')} | {r.get('focus_conf')} | "
                 f"{r.get('verdict')} | {r['wall_s']:.0f} s | {(r.get('verdict_vs_baseline', '') + ' (' + bl['tag'] + ')') if bl else '-'} |")
    tot = sum(r["wall_s"] for r in results)
    L += ["", f"Gesamtzeit {tot / 60:.1f} min für {len(results)} Fälle."]
    (res / f"{tag}.md").write_text("\n".join(L) + "\n")
    print(f"{res / (tag + '.md')}  ({tot / 60:.1f} min)")
    if any(r.get("verdict_vs_baseline") == "REGRESSION" for r in results):
        sys.exit(1)


if __name__ == "__main__":
    main()
