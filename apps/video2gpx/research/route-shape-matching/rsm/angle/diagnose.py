# SPDX-License-Identifier: AGPL-3.0-or-later
"""Diagnosis of the vms yaw scale: (1) rate dependence (electronic stabilisation?) and (2) radial distortion in the far-feature flow.

python -m rsm.angle.diagnose rate    numpy only -> work/angle/diag_rate.json
    vms yaw px / far-feature yaw px (g) per pair, binned by the far-feature turn rate; vms / COLMAP heading increments (2 s) binned by the COLMAP turn rate.
python -m rsm.angle.diagnose resid   (vms venv, cv2) re-tracks a few stretches and bins the flow residual of the best rotation model against x -> work/angle/diag_resid.json
"""
from __future__ import annotations

import json
import pickle
import sys

import numpy as np

from . import farfeat, refs, rotflow, videos

NAMES = ["grimone", "roanne", "rousset", "gotthard", "cayolle", "amalfi"]
W = videos.WORK


def g_by_rate(name: str, edges_deg_s=(0, 4, 7, 10, 14, 100), tag="final"):
    res = pickle.load(open(W / f"a_{name}_{tag}.pkl", "rb"))
    pool = farfeat.pool_f(res)
    p = farfeat.Params(**{**res["params"], "k1_grid": tuple(res["params"]["k1_grid"])})
    fg = farfeat.f_grid(p)
    i = int(np.argmin(np.abs(np.log(fg) - np.log(pool["f"]))))
    A, V, R = [], [], []  # R: turn rate of the whole 5 s stretch (far-feature yaw), so the bin does not select on the pair's own noise
    for s in res["stretches"]:
        if len(s["pairs"]) < 3:
            continue
        rate = np.degrees(abs(sum(q["A"][i, 0] for q in s["pairs"])) / pool["f"]) / sum(q["tb"] - q["ta"] for q in s["pairs"])
        for q in s["pairs"]:
            if np.isfinite(q["vms_yaw"]):
                A.append(q["A"][i, 0]); V.append(q["vms_yaw"]); R.append(rate)
    A, V, R = map(np.array, (A, V, R))
    rows = []
    for lo, hi in zip(edges_deg_s[:-1], edges_deg_s[1:]):
        m = (R >= lo) & (R < hi)
        if m.sum() < 8:
            continue
        rng = np.random.default_rng(1)
        Am, Vm = A[m], V[m]
        b = []
        for _ in range(300):
            k = rng.integers(0, len(Am), len(Am))
            b.append((Vm[k] @ Am[k]) / (Am[k] @ Am[k]))
        rows.append(dict(lo=lo, hi=hi, n=int(m.sum()), g=float((V[m] @ A[m]) / (A[m] @ A[m])), ci=[float(np.percentile(b, 2.5)), float(np.percentile(b, 97.5))]))
    allg = float((V @ A) / (A @ A))
    # tilt: g against rate, regression of the pair g on rate (rad/s)
    r2 = float(np.corrcoef(R, V * np.sign(A) / np.maximum(np.abs(A), 3.0))[0, 1])
    return dict(f_A=pool["f"], g_all=allg, rows=rows, n=int(len(A)), corr_rate_vs_ratio=float(r2))


def colmap_by_rate(name: str, edges_deg_s=(0, 2, 4, 7, 10, 100), inc_s=2.0, trange=None, routes=None):
    from ..bench import odo_compare as oc
    from ..odometry import GateParams
    v = videos.VIDEOS[name]
    vms = oc.load_vms(v["csv"], name, GateParams(exclude_before_s=20.0))
    wins = [w for r in (routes or v["routes"]) for w in refs.load_windows(r) if w.kept]
    dx, dy = [], []
    for w in wins:
        for pc in oc.pieces_for(w, vms, 449.0):
            tg = oc._grid(w, pc)
            if trange is not None:
                tg = tg[(tg >= trange[0]) & (tg <= trange[1])]
            if len(tg) < 8:
                continue
            th = np.interp(tg, pc.t, pc.theta)
            rot = np.interp(tg, w.t, w.psi_rot)
            n = int(round(inc_s / oc.GRID_DT))
            idx = np.arange(0, len(tg) - n, n)
            dx.append(rot[idx + n] - rot[idx]); dy.append(th[idx + n] - th[idx])
    dx, dy = np.concatenate(dx), np.concatenate(dy)
    rate = np.degrees(np.abs(dx)) / inc_s
    rows = []
    for lo, hi in zip(edges_deg_s[:-1], edges_deg_s[1:]):
        m = (rate >= lo) & (rate < hi)
        if m.sum() < 6:
            continue
        rng = np.random.default_rng(1)
        b = []
        for _ in range(300):
            k = rng.integers(0, m.sum(), m.sum()); a, c = dx[m][k], dy[m][k]
            b.append(449.0 * (a @ c) / (a @ a))
        rows.append(dict(lo=lo, hi=hi, n=int(m.sum()), f_eff=float(449.0 * (dx[m] @ dy[m]) / (dx[m] @ dx[m])), ci=[float(np.percentile(b, 2.5)), float(np.percentile(b, 97.5))]))
    return dict(inc_s=inc_s, n=int(len(dx)), f_eff_all=float(449.0 * (dx @ dy) / (dx @ dx)), rows=rows,
                quad=_quad(dx, dy))


def _quad(dx, dy):
    """dy = a dx + b dx |dx|: a nonzero b means a rate-dependent gain (b < 0: fast turns are under-measured, i.e. smoothing / stabilisation)."""
    M = np.column_stack([dx, dx * np.abs(dx)])
    c, *_ = np.linalg.lstsq(M, dy, rcond=None)
    r = dy - M @ c
    cov = np.linalg.inv(M.T @ M) * (r @ r) / (len(dy) - 2)
    return dict(a=float(c[0]), b=float(c[1]), b_se=float(np.sqrt(cov[1, 1])), gain_at_10deg_s_vs_2=float((c[0] + c[1] * np.radians(20)) / (c[0] + c[1] * np.radians(4))))


def rate_main():
    out = {"g_by_rate": {n: g_by_rate(n) for n in NAMES}, "colmap_by_rate": {}}
    for n, kw in (("amalfi", dict(trange=(780, 960))), ("amalfi_all", dict()), ("cayolle", {}), ("gotthard", {})):
        nm = n.replace("_all", "")
        for inc in (1.0, 2.0, 4.0):
            out["colmap_by_rate"][f"{n}_inc{inc:g}"] = colmap_by_rate(nm, inc_s=inc, **kw)
    # bike videos: GPS heading as the reference at W = 4 s steps is too coarse; the fresh COLMAP windows serve here
    (W / "diag_rate.json").write_text(json.dumps(out, indent=1, default=float))
    for n, r in out["g_by_rate"].items():
        print(n, "g_all %.3f f_A %.0f n %d corr(rate, |vms/A|) %.2f" % (r["g_all"], r["f_A"], r["n"], r["corr_rate_vs_ratio"]), [(f"{x['lo']}-{x['hi']}", round(x["g"], 3), x["n"]) for x in r["rows"]])
    for n, r in out["colmap_by_rate"].items():
        print(n, "f_eff_all %.0f n %d" % (r["f_eff_all"], r["n"]), [(f"{x['lo']}-{x['hi']}", round(x["f_eff"]), x["n"]) for x in r["rows"]], "quad b=%.2f+-%.2f gain(10/s vs 2/s) %.2f" % (r["quad"]["b"], r["quad"]["b_se"], r["quad"]["gain_at_10deg_s_vs_2"]))


def collect_points(name: str, n_stretch: int = 12, max_pairs: int = 6):
    """Re-track the strongest stretches of the final run and keep (x, y, flow, inlier mask) of the pairs (cv2)."""
    import cv2
    cv2.setNumThreads(1)
    res = pickle.load(open(W / f"a_{name}_final.pkl", "rb"))
    p = farfeat.Params(**{**res["params"], "k1_grid": tuple(res["params"]["k1_grid"])})
    v = videos.VIDEOS[name]
    info = res["info"]
    Hh = p.height
    Wd = round(info["width"] * Hh / info["height"] / 2) * 2
    k = max(2, int(round(p.dt_s * info["fps"])))
    mask, _ = farfeat.make_mask(cv2, Hh, Wd, res["horizon"], p)
    fg = farfeat.f_grid(p)
    rng = np.random.default_rng(0)
    sts = sorted([s for s in res["stretches"] if len(s["pairs"]) >= 3], key=lambda s: -abs(s["net_px"]))[:n_stretch]
    out = []
    for s in sts:
        frames = [fr for _, fr in farfeat.read_frames(str(v["video"]), info, Hh, s["t0"], s["t1"] - s["t0"])]
        got = 0
        for i in range(0, len(frames) - k, k):
            tr = farfeat.track_pair(cv2, mask, frames[i], frames[i + k], p, 1.0)
            if tr is None:
                continue
            q0, fl = tr
            x, y = q0[:, 0] - Wd / 2, q0[:, 1] - Hh / 2
            fit = rotflow.fit_pair(x, y, fl, fg, np.array([0.0]), 449.0, scale=1.0, rng=rng, min_inl=p.min_inl)
            if fit is None or fit.xspread < p.min_xspread:
                continue
            out.append(dict(x=x[fit.inl], y=y[fit.inl], fl=fl[fit.inl], W=Wd, H=Hh))
            got += 1
            if got >= max_pairs:
                break
    return out


def _fit(pairs, f, k1):
    """Per pair least squares of [A, B, C, e] at fixed (f, k1): residual rows and the signed yaw A."""
    R = []
    for q in pairs:
        n = len(q["x"])
        M = rotflow.design(q["x"], q["y"], f, k1)
        b = np.concatenate([q["fl"][:, 0], q["fl"][:, 1]])
        pr, *_ = np.linalg.lstsq(M, b, rcond=None)
        r = b - M @ pr
        R.append((q["x"], q["y"], r[:n], r[n:], pr[0]))
    return R


def resid_main(names=("roanne", "cayolle", "amalfi", "gotthard")):
    cm = {"roanne": (485.0, -0.0009), "cayolle": (374.8, 0.0519), "amalfi": (357.2, -0.0252), "gotthard": (400.1, 0.0564)}  # COLMAP fx360, k1 (OPENCV) of the kept reconstructions
    out = {}
    for n in names:
        pairs = collect_points(n)
        res = pickle.load(open(W / f"a_{n}_final.pkl", "rb"))
        f_a = farfeat.pool_f(res)["f"]
        fx, k1c = cm[n]
        models = {"k1=0, f=f_A": (f_a, 0.0), "k1=0, f=COLMAP fx": (fx, 0.0), "COLMAP fx, k1": (fx, k1c)}
        # joint fit over a (f, k1) grid for these pairs
        best = None
        for f in np.exp(np.linspace(np.log(0.7 * fx), np.log(1.4 * fx), 36)):
            for k in np.linspace(-0.12, 0.12, 25):
                sse = sum(float((r[2] ** 2).sum() + (r[3] ** 2).sum()) for r in _fit(pairs, f, k))
                if best is None or sse < best[0]:
                    best = (sse, f, k)
        models["joint (f, k1) best"] = (best[1], best[2])
        row = {}
        for label, (f, k) in models.items():
            R = _fit(pairs, f, k)
            sse = sum(float((r[2] ** 2).sum() + (r[3] ** 2).sum()) for r in R)
            npts = sum(len(r[0]) for r in R)
            # residual dx along x (sign-normalised by the yaw), 7 bins
            xs = np.concatenate([r[0] for r in R]); rx = np.concatenate([r[2] * np.sign(r[4]) for r in R])
            edges = np.linspace(-pairs[0]["W"] / 2, pairs[0]["W"] / 2, 8)
            bins = [float(rx[(xs >= a) & (xs < b)].mean()) if ((xs >= a) & (xs < b)).sum() > 20 else None for a, b in zip(edges[:-1], edges[1:])]
            row[label] = dict(f=float(f), k1=float(k), rms_px=float(np.sqrt(sse / (2 * npts))), mean_resid_dx_by_x_bin=bins, n_pts=int(npts))
        out[n] = row
        print(n, "pairs", len(pairs), {l: (round(r["f"]), round(r["k1"], 3), round(r["rms_px"], 4)) for l, r in row.items()})
        for l, r in row.items():
            print("   ", l, [None if b is None else round(b, 3) for b in r["mean_resid_dx_by_x_bin"]])
    (W / "diag_resid.json").write_text(json.dumps(out, indent=1, default=float))


if __name__ == "__main__":
    {"rate": rate_main, "resid": resid_main}[sys.argv[1]]()
