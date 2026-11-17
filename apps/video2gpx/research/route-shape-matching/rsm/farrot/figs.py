# SPDX-License-Identifier: AGPL-3.0-or-later
"""Figures of work/farrot/figs.  python -m rsm.farrot.figs"""
import json
import pickle

import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt
import numpy as np

from rsm.angle import refs, videos

from . import report, series, validate

F = series.WORK / "figs"


def amalfi_colmap():
    S = series.build("amalfi", str(videos.VIDEOS["amalfi"]["csv"]))
    w = refs.load_windows("amalfi-780")[0]
    sel = (w.t >= 780) & (w.t <= 960)
    t = np.arange(780, 960, 0.5)
    h = {k: validate.heading_fn(S, k)(t) for k in ("vms", "dth")}
    ps = np.interp(t, w.t, w.psi_rot)
    fig, ax = plt.subplots(1, 3, figsize=(16, 4.2))
    for k, c, lab in (("vms", "tab:red", "vms yaw"), ("dth", "tab:green", "far-feature yaw (fused)")):
        y = h[k] - h[k][0]; sl = np.dot(y, ps - ps[0]) / np.dot(y, y)
        ax[0].plot(t, np.degrees(y * sl), c, label=f"{lab} x {sl:.2f}")
    ax[0].plot(t, np.degrees(ps - ps[0]), "k", lw=2, label="COLMAP optical axis"); ax[0].set_title("Amalfi 780-960 s: heading (deg, each series scaled by one gain)"); ax[0].legend(fontsize=8); ax[0].set_xlabel("video s")
    for i, (k, c, lab) in enumerate((("vms", "tab:red", "vms"), ("dth", "tab:green", "far-feature fused"))):
        ref, ser, t0 = validate.colmap_blocks(S, k, block_s=2.0)
        r = validate.block_compare(ref, ser, block_s=2.0)
        ax[1].scatter(np.degrees(ref), np.degrees(ser) / r["slope"], s=14, c=c, label=f"{lab}: r {r['r']:.3f}, rms {r['resid_deg']:.1f} deg")
    ax[1].plot([-30, 30], [-30, 30], "k", lw=.5); ax[1].set_xlabel("COLMAP 2 s increment (deg)"); ax[1].set_ylabel("series / gain (deg)"); ax[1].legend(fontsize=8); ax[1].set_title("2 s heading increments")
    cur = {k: validate.colmap_curves(S, k) for k in ("vms", "dth")}
    x = np.arange(len(cur["vms"]))
    ax[2].bar(x - 0.2, [r["ratio_colmap_over_series"] for r in cur["vms"]], 0.4, color="tab:red", label="vms")
    ax[2].bar(x + 0.2, [r["ratio_colmap_over_series"] for r in cur["dth"]], 0.4, color="tab:green", label="far-feature fused")
    ax[2].set_title("per-curve COLMAP / series ratio (13 COLMAP turns)"); ax[2].set_xlabel("curve"); ax[2].legend(); ax[2].axhline(1, color="k", lw=.5)
    fig.tight_layout(); fig.savefig(F / "yaw_vs_colmap_amalfi.png", dpi=110); plt.close(fig)


def bikes_gps():
    fig, ax = plt.subplots(2, 3, figsize=(15, 8))
    for j, name in enumerate(report.BIKES):
        S = report.build_series(name)
        gps = videos.VIDEOS[name]["gps"]
        for i, (k, c, lab) in enumerate((("vms", "tab:red", "vms (refined csv)"), ("dth", "tab:green", "far-feature fused"))):
            ref, ser, t0 = validate.gps_blocks(gps, S, k, 4.0)
            r = validate.block_compare(ref, ser, t_blocks=t0)
            ax[i, j].scatter(np.degrees(ref), np.degrees(ser) / r["slope"], s=5, c=c, alpha=.5)
            ax[i, j].plot([-60, 60], [-60, 60], "k", lw=.5)
            ax[i, j].set_title(f"{name}: {lab}  r {r['r']:.3f}, rms {r['resid_deg']:.1f} deg, drift300 {r['drift_rms_deg']:.0f} deg", fontsize=9)
            ax[i, j].set_xlabel("GPS 4 s heading increment (deg)"); ax[i, j].set_ylabel("series / gain (deg)")
    fig.tight_layout(); fig.savefig(F / "yaw_vs_gps_bikes.png", dpi=100); plt.close(fig)


def portals():
    o = pickle.load(open(series.WORK / "res" / "amalfi.pkl", "rb"))
    P = o["vms"]["P"]; x = np.arange(len(P))
    fig, ax = plt.subplots(figsize=(13, 4))
    ax.bar(x - 0.27, o["vms"]["err"]["d_gated"], 0.27, color="tab:red", label="vms yaw, gated fusion (d)")
    ax.bar(x, o["far"]["err"]["d_gated"], 0.27, color="tab:green", label="far-feature yaw, gated fusion (d)")
    ax.bar(x + 0.27, o["far"]["err"]["c_ungated"], 0.27, color="tab:blue", label="far-feature yaw, ungated (c)")
    ax.set_xticks(x); ax.set_xticklabels([f"T{p['tunnel']} {p['portal'][:2]}" for p in P], rotation=60, fontsize=8)
    ax.axhline(0, color="k", lw=.5); ax.set_ylabel("along-track error at the portal (m)"); ax.legend(fontsize=8)
    ax.set_title("Amalfi (post hoc): error at the 18 tunnel portals; 'ex' = exit (common bias about -23 m)")
    fig.tight_layout(); fig.savefig(F / "portal_errors_amalfi.png", dpi=110); plt.close(fig)


def coverage_time():
    S = series.build("amalfi", str(videos.VIDEOS["amalfi"]["csv"]))
    fig, ax = plt.subplots(figsize=(13, 2.6))
    b = np.arange(0, S.tb[-1], 60.0)
    cs = np.concatenate([[0.0], np.cumsum(S.src == 0)])
    a = np.searchsorted(S.ta, b); e = np.searchsorted(S.ta, b + 60)
    ax.bar(b, (cs[e] - cs[a]) / np.maximum(e - a, 1), 55, align="edge", color="tab:green")
    ax.set_ylabel("far-yaw share"); ax.set_xlabel("video s"); ax.set_title("Amalfi: share of windows with a valid far-feature fit per minute (rest = vms fallback)")
    fig.tight_layout(); fig.savefig(F / "coverage_amalfi.png", dpi=100); plt.close(fig)


if __name__ == "__main__":
    F.mkdir(exist_ok=True, parents=True)
    amalfi_colmap(); bikes_gps(); portals(); coverage_time()
