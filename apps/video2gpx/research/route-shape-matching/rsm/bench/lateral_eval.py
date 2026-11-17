# SPDX-License-Identifier: AGPL-3.0-or-later
"""Lateral validation of the driving line against the GPS (development only; plan-accuracy 3.5). Reads the gps_score.npz files that rsm.bench.regress writes.

V1 bias: pooled median |GPS - line| (and signed) over all scored seconds on the correct road.
V3 bends: GPS lateral position and modelled offset, both high-passed (minus their running median over +-150 m of path), at bends with radius < 80 m, rides with
   about 1 Hz GPS only: OLS slope of GPS on model and Pearson r. Shows whether the corner cutting of L2 has the right sign and size.
V4 two directions: GPS points of the same road ridden in opposite directions (within 8 m, headings > 150 deg apart): the GPS separation of the two passes
   -(sc_a + sc_b) (free of the OSM way error) against the modelled separation off_a + off_b.

python -m rsm.bench.regress ... first; then  python -m rsm.bench.lateral_eval TAG [TAG ...]"""
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

import numpy as np

from rsm.bench import regress as RG

HZ1_MAX_SPACING_M = 8.0
V4_PAIRS = (("rousset", "rousset"), ("cdp", "pennes"))


def _load(tag: str, case: str):
    d = RG.WORK / tag / case
    f = d / "gps_score.npz"
    if not f.exists():
        return None
    z = dict(np.load(f))
    R = np.load(d / "refine" / "result.npz")
    z["sg"], z["xy"] = R["sg"], R["xy"]
    return z


def _hp(s: np.ndarray, x: np.ndarray, half: float = 150.0) -> np.ndarray:
    o = np.argsort(s)
    ss, xs = s[o], x[o]
    lo, hi = np.searchsorted(ss, ss - half), np.searchsorted(ss, ss + half)
    med = np.array([np.median(xs[a:b]) for a, b in zip(lo, hi)])
    out = np.empty_like(x)
    out[o] = xs - med
    return out


def v1(z) -> dict:
    r = z["road"]
    gl = -z["signed_cross"][r]                                                # GPS lateral position, + = right of travel
    return dict(abs=np.abs(gl - z["offset"][r]), signed=gl - z["offset"][r])


def v3(z):
    from rsm.pipeline import offset as O
    r = z["road"]
    k = O.path_curvature(z["xy"])
    kk = np.abs(np.interp(z["s_gps"], z["sg"], k))
    gl, off, s = -z["signed_cross"], z["offset"], z["s_gps"]
    g_hp, m_hp = _hp(s[r], gl[r]), _hp(s[r], off[r])
    bend = kk[r] > 1 / 80.0
    return g_hp[bend], m_hp[bend]


def v4(za, zb) -> dict | None:
    from scipy.spatial import cKDTree
    def head(z):
        return np.arctan2(np.gradient(z["gy"]), np.gradient(z["gx"]))
    ra, rb = za["road"], zb["road"]
    pa, pb = np.column_stack([za["gx"], za["gy"]])[ra], np.column_stack([zb["gx"], zb["gy"]])[rb]
    ha, hb = head(za)[ra], head(zb)[rb]
    tree = cKDTree(pb)
    j = np.full(len(pa), -1)
    for i, nb in enumerate(tree.query_ball_point(pa, 8.0)):                  # the nearest neighbour of the OTHER direction (a self pair finds itself first)
        nb = [q for q in nb if np.degrees(abs(np.angle(np.exp(1j * (ha[i] - hb[q]))))) >= 150.0]
        if nb:
            j[i] = min(nb, key=lambda q: np.hypot(*(pa[i] - pb[q])))
    ok = j >= 0
    if ok.sum() < 30:
        return None
    sep_gps = -(za["signed_cross"][ra][ok] + zb["signed_cross"][rb][j[ok]])
    sep_mod = za["offset"][ra][ok] + zb["offset"][rb][j[ok]]
    return dict(n=int(ok.sum()), gps_sep_median=float(np.median(sep_gps)), model_sep_median=float(np.median(sep_mod)), diff_median=float(np.median(sep_mod - sep_gps)))


def evaluate(tag: str) -> dict:
    from rsm.bench import gps_truth as GT
    cs = [c for c in RG.cases() if c.get("gps")]
    out, pool_abs, pool_sig, g3, m3, per = {}, [], [], [], [], {}
    Z = {}
    for c in cs:
        z = _load(tag, c["name"])
        if z is None:
            continue
        Z[c["name"]] = z
        a = v1(z)
        pool_abs.append(a["abs"]); pool_sig.append(a["signed"])
        per[c["name"]] = dict(v1_abs_median=float(np.median(a["abs"])), v1_signed_median=float(np.median(a["signed"])))
        lat, lon, t = GT.load_gpx(c["gps"])
        sp = float(np.median(np.hypot(np.diff(lat) * 111195, np.diff(lon) * 111195 * np.cos(np.radians(lat[:-1])))))
        per[c["name"]]["gps_spacing_m"] = sp
        if sp <= HZ1_MAX_SPACING_M:
            g, m = v3(z)
            g3.append(g); m3.append(m)
    out["per_case"] = per
    if pool_abs:
        A, Sg = np.concatenate(pool_abs), np.concatenate(pool_sig)
        out["v1"] = dict(n=int(len(A)), abs_median=float(np.median(A)), signed_median=float(np.median(Sg)))
    if g3:
        g, m = np.concatenate(g3), np.concatenate(m3)
        if np.std(m) > 1e-6:
            slope = float(np.sum((m - m.mean()) * (g - g.mean())) / np.sum((m - m.mean()) ** 2))
            out["v3"] = dict(n=int(len(g)), slope=slope, r=float(np.corrcoef(g, m)[0, 1]), model_hp_sd=float(np.std(m)), gps_hp_sd=float(np.std(g)))
        else:
            out["v3"] = dict(n=int(len(g)), slope=None, r=None, model_hp_sd=float(np.std(m)), note="the model has no bend signal (L1 only)")
    out["v4"] = {f"{a}x{b}": v4(Z[a], Z[b]) for a, b in V4_PAIRS if a in Z and b in Z}
    return out


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(prog="rsm.bench.lateral_eval")
    ap.add_argument("tags", nargs="+")
    a = ap.parse_args(argv)
    res = {t: evaluate(t) for t in a.tags}
    (RG.WORK / f"lateral_{'_'.join(a.tags)}.json").write_text(json.dumps(res, indent=1))
    for t, r in res.items():
        print(t, "V1", {k: round(v, 3) if isinstance(v, float) else v for k, v in (r.get("v1") or {}).items()})
        print(t, "V3", {k: round(v, 3) if isinstance(v, float) else v for k, v in (r.get("v3") or {}).items()})
        print(t, "V4", {k: ({kk: round(vv, 2) if isinstance(vv, float) else vv for kk, vv in v.items()} if v else None) for k, v in r["v4"].items()})
        print(t, "per case", {k: (round(v["v1_abs_median"], 2), round(v["v1_signed_median"], 2)) for k, v in r["per_case"].items()})
    return 0


if __name__ == "__main__":
    sys.exit(main())
