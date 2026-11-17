# SPDX-License-Identifier: AGPL-3.0-or-later
"""Curve anchors and fusion with the far-feature yaw: the vms heading tracks (rsm.plaus.data.vms_tracks) are rebuilt with the new yaw series, everything else
(distance track, segments, HMM positions, curve producer, merge, gate, RTS smoother) is the existing code, unchanged.
    tracks_from_series(...)   -> list of {t, s, th} like data.vms_tracks (th is divided by ctx.a_ang so that a_ang * th = the far-feature heading in rad)
    load_video(name, S)       -> rsm.fusion.core.Video whose ctx.tracks are the new ones
"""
from __future__ import annotations

import pickle
from dataclasses import replace

import numpy as np

from rsm.fusion import core, features, posterior
from rsm.odometry import gating
from rsm.odometry.calib import CAMERA_HEIGHT_M, YAW_SIGN
from rsm.odometry.vms_csv import load_pairs
from rsm.plaus import data
from rsm.quanta import video
from rsm.refine import analyse, load

from . import series as S_

GPS_IDS = load.GPS_VIDEOS


def vms_config(name: str) -> dict:
    """frozen vms config of the video as the stored HMM runs used it (Amalfi: the baseline CSV, f360 449)"""
    if name == "Amalfi":
        from rsm.nogps import cfg
        label = cfg.install("base")
        return video.config(label, cfg.VIDEO)
    return video.config("refined", GPS_IDS[name])


def pair_rad(S: S_.Series, p, which: str = "dth") -> np.ndarray:
    """heading increment (rad) of every vms frame pair from the window series (a window's increment is spread evenly over its k pairs)"""
    k, fps = S.meta["k"], S.meta["fps"]
    w = np.floor((p.time * fps - 0.5) / k).astype(int)
    w = np.clip(w, 0, len(S.dth) - 1)
    x = np.where(np.isfinite(getattr(S, which)), getattr(S, which), S.vms)
    x = np.where(np.isfinite(x), x, 0.0)
    return x[w] / k


def tracks_from_series(name: str, S: S_.Series, a_ang: float, which: str = "dth") -> list[dict]:
    cfg = vms_config(name)
    p = load_pairs(cfg["csv"])
    fl = gating.pair_flags(p)
    om = pair_rad(S, p, which)
    out = []
    for sg in gating.build_segments(p, fl, gating.GateParams()):
        if not sg.usable:
            continue
        sl = slice(sg.i0, sg.i1)
        ok = fl[sl] == 0
        sp = np.maximum(S_._fill(np.where(ok, p.s[sl], np.nan)), 0.0)
        k = cfg["f360"] * CAMERA_HEIGHT_M * cfg.get("dist_scale", 1.0)
        theta = np.concatenate([[0.0], np.cumsum(om[sl])]) / a_ang
        s = np.concatenate([[0.0], np.cumsum(k * sp)])
        tm = p.time[sl]
        t = np.concatenate([tm - p.dt / 2, [tm[-1] + p.dt / 2]])
        r = data._resample(t, s, theta)
        if r is not None:
            out.append(r)
    return out


def load_video(name: str, S: S_.Series | None = None, which: str = "dth") -> core.Video:
    ctx = load.build_ctx(name)
    if S is not None:
        ctx.tracks = tracks_from_series(name, S, ctx.a_ang, which)
    P = pickle.load(open(posterior.RES / f"post_{name}.pkl", "rb"))
    idx = ctx.extra["idx"]
    pm = P["s_pm"][idx].astype(float); sd = P["sd"][idx].astype(float)
    src, cand, acc, rej = analyse.run_curves(ctx)
    return core.Video(name, ctx, pm, sd, src, cand, acc, features.Featurizer(ctx, src))
