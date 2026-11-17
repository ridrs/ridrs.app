# SPDX-License-Identifier: AGPL-3.0-or-later
"""Approach C: scan the angle scale (f360 of the vms heading) inside the stage A/B pipeline and pick the scale with the most accepted windows.

No GPS truth is read. The pipeline objects are imported unchanged (rsm.quanta, rsm.plaus, rsm.nogps); the frozen-params file that
rsm.quanta.video reads is replaced at run time by one per scale (the files written under work/angle/scan/).

  PYTHONPATH=. .venv/bin/python tools/memguard.py --max-gb 12 --min-free 25 -- .venv/bin/python -m rsm.angle.scan <video> [--scales a,b,c]
"""
from __future__ import annotations

import json
import pickle
import sys
import time
from pathlib import Path

import numpy as np

from rsm.plaus import data, decide as D, fit as fitmod, pipeline as P, stagea, path as pathmod
from rsm.quanta import evalrun as ev, video as qvideo
from rsm.quanta.chain import MapIndex
from rsm.quanta.qdef import mirror

from . import videos

OUT = videos.WORK / "scan"
SETTING = "measured"
VARIANT = "wider"
LENGTHS = P.LENGTHS
G: dict = {}


def install(csv_template: str, f360: float, tag: str) -> str:
    """Point rsm.quanta.video at a frozen-params copy whose 'scan' config is the baseline vms config with the given f360."""
    fz = json.loads((videos.ROOT / "work/vangestel/frozen_params.json").read_text())
    c = dict(fz["configs"]["baseline"])
    c["csv"], c["f360"] = csv_template, float(f360)
    fz["configs"] = {"scan": c}
    OUT.mkdir(parents=True, exist_ok=True)
    f = OUT / f"frozen_{tag}.json"
    f.write_text(json.dumps(fz))
    qvideo.FROZEN = f
    return "scan"


class Source:
    """stage A/B source of one video input and one scale, no truth (duck type of rsm.nogps.stages.Source)."""

    def __init__(self, video_name: str, ctx, ctl=None):
        self.video, self.src, self.ctl, self.map_video = video_name, "scan", ctl, video_name
        self.mctx = self.ctx = ctx
        self.ix = MapIndex(ctx.m, P.qparams(VARIANT))
        self.gi = pathmod.GraphIdx(ctx.g)
        self.q = ev.video_q(video_name, "scan", 45.0)
        self.tracks = data.vms_tracks(video_name, "scan")
        if ctl == "mirror":
            self.q = mirror(self.q)
            self.tracks = data.mirror_tracks(self.tracks)
        self.tmax = max(float(x["t"][-1]) for x in self.tracks)

    def windows(self, L):
        n = len(self.q["t0"])
        return ev.windows(np.ones(n, bool), L, max(1, L // 4))


def eval_window(src, L, lo, hi, K=200, KF=50):
    t0 = time.time()
    q = src.q
    chains = stagea.match_window_k(src.ix, q, lo, hi, K=K)
    wspan = float(q["t1"][hi - 1] - q["t0"][lo])
    cands = [dict(rank=rk, scoreA=ch.score, nm=ch.n_matched, frac=np.nan, correct=False, legs=ch.legs, fits={}) for rk, ch in enumerate(chains)]
    for rk in range(min(KF, len(chains))):
        P.fit_cand(src, cands[rk], lo, wspan, [SETTING], {SETTING: fitmod.PRIORS[SETTING]})
    return dict(video=src.video, ctl=src.ctl, L=L, lo=lo, hi=hi, t0=float(q["t0"][lo]), t1=float(q["t1"][hi - 1]), n_chains=len(chains), cands=cands, sec=time.time() - t0)


def _work(task):
    L, lo, hi = task
    return eval_window(G["src"], L, lo, hi)


def run_windows(src, procs=4):
    import multiprocessing as mp_
    G["src"] = src
    tasks = [(L, lo, hi) for L in LENGTHS for lo, hi in src.windows(L)]
    with mp_.get_context("fork").Pool(procs) as pool:
        return pool.map(_work, tasks, chunksize=1)


def frozen_tau_m():
    fz = json.loads((P.WORK / "frozen.json").read_text())
    c = fz["cal"]["refined"][SETTING]
    return c["tau"], c["m"]


def stats(recs, tau, m) -> dict:
    acc = [r for r in recs if D.accepted(r, SETTING, tau)]
    dec = [r for r in recs if D.decide(r, SETTING, tau, m) is not None]
    best = [min(f["snorm"] for _, f in D.fits_of(r, SETTING)) for r in recs if any(True for _ in D.fits_of(r, SETTING))]
    return dict(windows=len(recs), accepted=len(acc), decided=len(dec), best_snorm_median=float(np.median(best)) if best else None,
                rho_median=(D.estimate_video_level(recs, SETTING, tau) or {}).get("rho"))


def scan_video(video_name: str, ctx, csv_template: str, scales, procs=4, controls=True, log=print) -> list[dict]:
    tau, m = frozen_tau_m()
    out = []
    for f in scales:
        row = dict(f360=float(f))
        for ctl in ((None, "mirror") if controls else (None,)):
            install(csv_template, f, f"{video_name}_{f:.0f}")
            t0 = time.time()
            src = Source(video_name, ctx, ctl)
            recs = run_windows(src, procs)
            st = stats(recs, tau, m)
            st["seconds"] = time.time() - t0
            row["mirror" if ctl else "real"] = st
            with open(OUT / f"recs_{video_name}_{f:.0f}_{ctl or 'real'}.pkl", "wb") as fh:
                pickle.dump(recs, fh)
        out.append(row)
        log(f"  {video_name} f {f:6.1f}: " + " | ".join(f"{k} windows {v['windows']} acc {v['accepted']} dec {v['decided']} ({v['seconds']:.0f}s)" for k, v in row.items() if k != "f360"), flush=True)
    return out


def pick(rows, key="accepted") -> dict:
    """The scale with the most accepted windows (real run), smoothed over three neighbouring scales; also the real-minus-mirror variant."""
    f = np.array([r["f360"] for r in rows])
    real = np.array([r["real"][key] for r in rows], float)
    sm = np.convolve(np.pad(real, 1, mode="edge"), np.ones(3) / 3, "valid")
    i = int(np.argmax(sm))
    out = dict(f=float(f[i]), by="smoothed accepted windows", max_count=float(real[i]))
    if "mirror" in rows[0]:
        mir = np.array([r["mirror"][key] for r in rows], float)
        d = np.convolve(np.pad(real - mir, 1, mode="edge"), np.ones(3) / 3, "valid")
        j = int(np.argmax(d))
        out.update(f_minus_mirror=float(f[j]), real_minus_mirror_at_peak=float(d[j]))
    return out


def main(argv=None):
    import argparse
    ap = argparse.ArgumentParser()
    ap.add_argument("video")
    ap.add_argument("--scales", default=None, help="comma list of f360 values; default 449 x geometric 0.5..2.0 (13 steps)")
    ap.add_argument("--no-controls", action="store_true")
    ap.add_argument("--procs", type=int, default=4)
    a = ap.parse_args(argv)
    scales = [float(x) for x in a.scales.split(",")] if a.scales else [449.0 * s for s in np.exp(np.linspace(np.log(0.5), np.log(2.0), 13))]
    if a.video == "amalfi":
        from rsm.nogps import cfg, mapbuild
        ctx = mapbuild.load_ctx()
        name, tpl = cfg.VIDEO, "work/amalfi/vms/{video}.csv"
    else:
        v = videos.VIDEOS[a.video]
        name = v["gps"]
        ctx = ev.load_ctx(name, 45.0)
        tpl = "work/vangestel/vms/{video}.csv"
    rows = scan_video(name, ctx, tpl, scales, a.procs, not a.no_controls)
    OUT.mkdir(parents=True, exist_ok=True)
    pk = pick(rows)
    (OUT / f"scan_{a.video}.json").write_text(json.dumps(dict(rows=rows, pick=pk), indent=1, default=float))
    print(a.video, pk)


if __name__ == "__main__":
    sys.exit(main())
