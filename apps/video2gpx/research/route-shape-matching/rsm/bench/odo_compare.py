# SPDX-License-Identifier: AGPL-3.0-or-later
"""vms odometry against COLMAP camera poses, window by window (task 3). numpy / stdlib / rsm only.

python -m rsm.bench.odo_compare --routes ../road-reconstruction/routes --colmap work/odometry/colmap --vms work/odometry/vms -o work/odometry/compare
"""
from __future__ import annotations

import argparse
import json
import math
from dataclasses import dataclass
from pathlib import Path

import numpy as np

from ..core.metrics import frechet
from ..core.similarity import DegenerateFit, fit_similarity
from ..odometry import GateParams, NOMINAL, TurnParams, build_segments, dead_reckon, detect_turns, integrate, load_pairs, pair_flags
from .odo_colmap import Window, load_route

ROUTES = ["gotthard-450", "gotthard-600", "cayolle-1630", "cayolle-2850", "cayolle-4000", "cayolle-4000-dense"]
GRID_DT = 0.25  # s, common time grid
MIN_PIECE_S = 5.0  # a vms segment overlapping the window by less is not compared
MAX_COLMAP_GAP_S = 3.0  # grid points inside a hole of the COLMAP keyframes this long are skipped
MATCH_OVERLAP = 0.5  # turns match when the time overlap is at least this share of the shorter turn
INC_S = 2.0  # increment length for the focal regression


CAL = None  # optional rsm.odometry.Calibration (set by --calibration): distance factor and post-hoc horizon correction used in `pieces_for`


@dataclass
class Vms:
    video_id: str
    pairs: object
    flags: np.ndarray
    segs: list
    gate: GateParams

    @property
    def usable(self):
        return [s for s in self.segs if s.usable]


def load_vms(csv: str | Path, video_id: str, gate: GateParams) -> Vms:
    p = load_pairs(csv)
    fl = pair_flags(p, gate)
    return Vms(video_id, p, fl, build_segments(p, fl, gate), gate)


@dataclass
class Piece:
    t: np.ndarray
    theta: np.ndarray
    s: np.ndarray
    x: np.ndarray
    y: np.ndarray
    seg_id: int

    @property
    def ta(self):
        return float(self.t[0])

    @property
    def tb(self):
        return float(self.t[-1])


def pieces_for(win: Window, v: Vms, f360: float) -> list[Piece]:
    out = []
    for seg in v.usable:
        ta, tb = max(win.t[0], seg.t0), min(win.t[-1], seg.t1)
        if tb - ta < MIN_PIECE_S:
            continue
        tr = integrate(v.pairs, seg, v.flags, f360, dist_scale=CAL.dist_scale if CAL else 1.0, c_delta_px=CAL.c_delta_px if CAL else 0.0)
        inner = (tr.t > ta) & (tr.t < tb)
        t = np.concatenate([[ta], tr.t[inner], [tb]])
        th = np.interp(t, tr.t, tr.theta)
        s = np.interp(t, tr.t, tr.s)
        th, s = th - th[0], s - s[0]
        x, y = dead_reckon(th, s)
        out.append(Piece(t, th, s, x, y, v.segs.index(seg)))
    return out


def _grid(win: Window, pc: Piece) -> np.ndarray:
    tg = np.arange(math.ceil(pc.ta / GRID_DT) * GRID_DT, pc.tb, GRID_DT)
    k = np.clip(np.searchsorted(win.t, tg), 1, len(win.t) - 1)
    ok = (win.t[k] - win.t[k - 1] <= MAX_COLMAP_GAP_S) & (tg >= win.t[0]) & (tg <= win.t[-1])
    return tg[ok]


def match_turns(a, b) -> tuple[list[tuple[int, int]], list[int], list[int]]:
    """Match turn lists (a = COLMAP reference, b = vms) by time overlap; returns pairs (i, j), unmatched a, unmatched b."""
    cand = []
    for i, ta in enumerate(a):
        for j, tb in enumerate(b):
            ov = min(ta.t_end, tb.t_end) - max(ta.t_start, tb.t_start)
            if ov > 0:
                cand.append((ov / min(ta.t_end - ta.t_start, tb.t_end - tb.t_start), i, j))
    cand.sort(reverse=True)
    ua, ub, pairs = set(range(len(a))), set(range(len(b))), []
    for frac, i, j in cand:
        if frac >= MATCH_OVERLAP and i in ua and j in ub:
            pairs.append((i, j))
            ua.discard(i)
            ub.discard(j)
    return sorted(pairs), sorted(ua), sorted(ub)


def compare_window(win: Window, v: Vms, f360: float, turn: TurnParams = TurnParams(), detail: bool = True, turn_vms: TurnParams | None = None) -> dict:
    pcs = pieces_for(win, v, f360)
    res: dict = {"window": win.name, "t0": float(win.t[0]), "t1": float(win.t[-1]), "colmap_images": win.n_images, "colmap_length_m": win.length,
                 "f360": f360, "pieces": []}
    cov = sum(pc.tb - pc.ta for pc in pcs)
    res["vms_coverage"] = cov / (win.t[-1] - win.t[0])
    dif_rot, dif_tan, all_t, all_s = [], [], [], []
    ang_pairs, n_cm, n_vm, n_miss, n_extra, n_sign_ok = [], 0, 0, 0, 0, 0
    drift_w = []
    for pc in pcs:
        tg = _grid(win, pc)
        if len(tg) < 8:
            continue
        th = np.interp(tg, pc.t, pc.theta)
        rot = np.interp(tg, win.t, win.psi_rot)
        tan = np.interp(tg, win.t, win.psi_tan)
        sc = np.interp(tg, win.t, win.s)
        d1, d2 = th - rot, th - tan
        d1c, d2c = d1 - d1.mean(), d2 - d2.mean()
        plen = float(sc[-1] - sc[0])
        # drift per 100 m of COLMAP arc length (linear trend of the heading difference)
        drift = float(np.polyfit(sc - sc[0], d1, 1)[0] * 100) if plen > 20 else None
        # path shape
        pp = {"seg": pc.seg_id, "t0": pc.ta, "t1": pc.tb, "colmap_length_m": plen, "vms_nominal_length_m": float(pc.s[-1]),
              "length_ratio_vms_over_colmap": float(pc.s[-1] / plen) if plen > 0 else None,
              "heading_rms_deg_rot": math.degrees(float(np.sqrt(np.mean(d1c ** 2)))), "heading_rms_deg_tan": math.degrees(float(np.sqrt(np.mean(d2c ** 2)))),
              "drift_deg_per_100m": None if drift is None else math.degrees(drift), "n_grid": len(tg),
              "colmap_net_turn_deg": math.degrees(float(rot[-1] - rot[0])), "vms_net_turn_deg": math.degrees(float(th[-1] - th[0]))}
        va = np.column_stack([np.interp(tg, pc.t, pc.x), np.interp(tg, pc.t, pc.y)])
        ca = np.column_stack([np.interp(tg, win.t, win.xy[:, 0]), np.interp(tg, win.t, win.xy[:, 1])])
        try:
            fit = fit_similarity(va, ca)
            fitted = fit.apply(va)
            pp["shape"] = {"scale": fit.scale, "rms_m": fit.rms, "rms_over_length_pct": 100 * fit.rms / plen if plen > 0 else None,
                           "frechet_m": float(frechet(fitted, ca)), "max_residual_m": fit.max_residual}
        except DegenerateFit as e:
            pp["shape"] = {"error": str(e)}
        # turns, on the piece
        m = (win.t >= pc.ta) & (win.t <= pc.tb)
        ct = []
        if m.sum() >= 5:
            ct = detect_turns(win.s[m] - win.s[m][0], win.psi_rot[m], win.t[m], turn)
        vt = detect_turns(pc.s, pc.theta, pc.t, turn_vms or turn)  # turn_vms: calibrated vms detector; the COLMAP reference keeps `turn`
        pairs, ua, ub = match_turns(ct, vt)
        pp["turns_colmap"] = [t.to_dict() for t in ct]
        pp["turns_vms"] = [t.to_dict() for t in vt]
        pp["turn_pairs"] = [{"colmap": i, "vms": j, "colmap_deg": ct[i].angle_deg, "vms_deg": vt[j].angle_deg,
                             "err_deg": vt[j].angle_deg - ct[i].angle_deg, "err_pct": 100 * (vt[j].angle_deg - ct[i].angle_deg) / abs(ct[i].angle_deg),
                             "sign_agree": ct[i].sign == vt[j].sign} for i, j in pairs]
        pp["missed"], pp["extra"] = ua, ub
        n_cm += len(ct); n_vm += len(vt); n_miss += len(ua); n_extra += len(ub)
        ang_pairs += pp["turn_pairs"]
        n_sign_ok += sum(q["sign_agree"] for q in pp["turn_pairs"])
        dif_rot.append(d1c); dif_tan.append(d2c)
        if drift is not None:
            drift_w.append((plen, math.degrees(drift)))
        res["pieces"].append(pp if detail else {k: pp[k] for k in pp if not k.startswith("turns_")})
    res["n_pieces"] = len(res["pieces"])
    if dif_rot:
        res["heading_rms_deg_rot"] = math.degrees(float(np.sqrt(np.mean(np.concatenate(dif_rot) ** 2))))
        res["heading_rms_deg_tan"] = math.degrees(float(np.sqrt(np.mean(np.concatenate(dif_tan) ** 2))))
        res["drift_deg_per_100m"] = float(sum(w * d for w, d in drift_w) / sum(w for w, _ in drift_w)) if drift_w else None
    res["turns"] = {"colmap": n_cm, "vms": n_vm, "matched": len(ang_pairs), "missed": n_miss, "extra": n_extra, "sign_agree": n_sign_ok,
                    "mean_abs_err_deg": float(np.mean([abs(q["err_deg"]) for q in ang_pairs])) if ang_pairs else None,
                    "mean_err_pct_signed": float(np.mean([q["err_pct"] for q in ang_pairs])) if ang_pairs else None,
                    "median_abs_err_pct": float(np.median([abs(q["err_pct"]) for q in ang_pairs])) if ang_pairs else None}
    if pcs:
        res["length_ratio_vms_over_colmap"] = float(sum(pc.s[-1] for pc in pcs) / sum(q["colmap_length_m"] for q in res["pieces"])) if res["pieces"] else None
    return res


def focal_regression(win: Window, v: Vms, f360: float, n_boot: int = 400, seed: int = 1) -> dict | None:
    """Best-fit f: theta_vms(f_nom) = (f_eff / f_nom) * psi_colmap, from 2-s increments (no intercept), pooled over the pieces,
    with a block bootstrap (blocks of 5 increments = 10 s); and from the cumulative curves with an intercept per piece."""
    dx, dy, cx, cy = [], [], [], []
    for pc in pieces_for(win, v, f360):
        tg = _grid(win, pc)
        if len(tg) < 8:
            continue
        th = np.interp(tg, pc.t, pc.theta)
        rot = np.interp(tg, win.t, win.psi_rot)
        n = int(INC_S / GRID_DT)
        idx = np.arange(0, len(tg) - n, n)
        dx.append(rot[idx + n] - rot[idx]); dy.append(th[idx + n] - th[idx])
        cx.append(rot - rot.mean()); cy.append(th - th.mean())
    if not dx:
        return None
    # blocks of consecutive increments
    blocks = []
    for a, b in zip(dx, dy):
        for i in range(0, len(a), 5):
            blocks.append((a[i:i + 5], b[i:i + 5]))
    sxx = sum(float(a @ a) for a, _ in blocks)
    slope = sum(float(a @ b) for a, b in blocks) / sxx
    rng = np.random.default_rng(seed)
    bs = []
    for _ in range(n_boot):
        pick = rng.integers(0, len(blocks), len(blocks))
        sxx_b = sum(float(blocks[i][0] @ blocks[i][0]) for i in pick)
        bs.append(sum(float(blocks[i][0] @ blocks[i][1]) for i in pick) / sxx_b)
    X, Y = np.concatenate(cx), np.concatenate(cy)
    cum = float(X @ Y / (X @ X))
    return {"slope_increments": slope, "f_eff_increments": slope * f360, "f_eff_ci95": [float(np.percentile(bs, 2.5) * f360), float(np.percentile(bs, 97.5) * f360)],
            "slope_cumulative": cum, "f_eff_cumulative": cum * f360, "n_increments": int(sum(len(a) for a, _ in blocks)),
            "corr_increments": float(np.corrcoef(np.concatenate(dx), np.concatenate(dy))[0, 1]),
            "colmap_net_turn_deg": float(math.degrees(abs(np.concatenate(dx)).sum()))}


def main(argv=None) -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--routes", required=True)
    ap.add_argument("--colmap", required=True)
    ap.add_argument("--vms", required=True)
    ap.add_argument("--exclude-before", type=float, default=20.0)
    ap.add_argument("--min-images", type=int, default=60)
    ap.add_argument("--calibration", help="calibration.json: one f360, distance factor, detector parameters for every window (no focal fit / sensitivity)")
    ap.add_argument("-o", "--out", required=True)
    args = ap.parse_args(argv)
    out = Path(args.out)
    out.mkdir(parents=True, exist_ok=True)
    gate = GateParams(exclude_before_s=args.exclude_before)
    vms = {vid: load_vms(Path(args.vms) / f"{vid}.csv", vid, gate) for vid in ("gotthard", "cayolle")}
    wins = []
    for r in ROUTES:
        wins += load_route(Path(args.routes) / r, Path(args.colmap) / f"{r}.models.json", args.min_images)
    if args.calibration:
        global CAL
        from ..odometry import load_calibration
        CAL = load_calibration(args.calibration)
        tp = TurnParams(**{**TurnParams().to_dict(), **CAL.turn})
        results = []
        for w in wins:
            vid = "gotthard" if w.route.startswith("gotthard") else "cayolle"
            r = compare_window(w, vms[vid], CAL.f360, turn_vms=tp)
            r.update({"video_id": vid, "kept": w.kept, "source": w.source, "colmap_scale": w.scale})
            results.append(r)
        (out / "results.json").write_text(json.dumps({"gate": gate.to_dict(), "turn_params": tp.to_dict(), "calibration": CAL.__dict__, "grid_dt": GRID_DT,
                                                       "min_piece_s": MIN_PIECE_S, "match_overlap": MATCH_OVERLAP, "windows": results}, indent=1, default=str))
        print(f"wrote {out / 'results.json'}: {len(results)} windows (calibrated)")
        return 0
    results, foc = [], {}
    for w in wins:
        vid = "gotthard" if w.route.startswith("gotthard") else "cayolle"
        nom = NOMINAL[vid]
        r = compare_window(w, vms[vid], nom.f360)
        r.update({"video_id": vid, "kept": w.kept, "source": w.source, "colmap_scale": w.scale, "colmap_fx360": w.colmap_fx360, "colmap_fy360": w.colmap_fy360})
        fr = focal_regression(w, vms[vid], nom.f360)
        r["focal_fit"] = fr
        foc[w.name] = (vid, fr)
        results.append(r)
    # focal sensitivity: rerun at f_low, f_high, the model's own fit (in-sample) and the pooled fit of the OTHER windows of that video (leave-one-out)
    for w, r in zip(wins, results):
        vid = r["video_id"]
        nom = NOMINAL[vid]
        sens = {}
        others = [fr for n, (v2, fr) in foc.items() if v2 == vid and n != w.name and fr]
        f_loo = float(np.mean([fr["f_eff_increments"] for fr in others])) if others else None
        fs = {"nominal": nom.f360, "f_low": nom.f_low, "f_high": nom.f_high}
        if r["focal_fit"]:
            fs["own_fit"] = r["focal_fit"]["f_eff_increments"]
        if f_loo:
            fs["loo_mean_of_other_windows"] = f_loo
        for k, f in fs.items():
            c = compare_window(w, vms[vid], f, detail=False)
            sens[k] = {"f360": f, "turns": c["turns"], "heading_rms_deg_rot": c.get("heading_rms_deg_rot"), "drift_deg_per_100m": c.get("drift_deg_per_100m"),
                       "length_ratio_vms_over_colmap": c.get("length_ratio_vms_over_colmap")}
        r["focal_sensitivity"] = sens
    (out / "results.json").write_text(json.dumps({"gate": gate.to_dict(), "turn_params": TurnParams().to_dict(), "grid_dt": GRID_DT, "min_piece_s": MIN_PIECE_S,
                                                   "match_overlap": MATCH_OVERLAP, "windows": results}, indent=1))
    print(f"wrote {out / 'results.json'}: {len(results)} windows")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
