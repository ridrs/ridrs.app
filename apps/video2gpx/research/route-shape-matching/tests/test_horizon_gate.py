# SPDX-License-Identifier: AGPL-3.0-or-later
"""A29: the running horizon drops a stretch whose focus of expansion lies more than HZ_MAX_DEV rows off the median of its neighbours (±HZ_GATE_SPAN / 2 s),
not off the one calibrated row of the whole video.

Lahntal (2026-11-22): the camera tilted during the ride (horizon about 180 rows at the start, 222 after 10 min, 265 after 20 min); the calibrated row 249
is a mix that fits no part of the video. The old gate (±60 rows around 249) dropped 64 of the 66 stretches of the first 5.5 minutes, the pairs there were
fitted with 249, and the distance came out 35-54 % too long: the route started on the other bank of the Lahn."""
import numpy as np
import pytest

from rsm.pipeline.vmsx import interpret as VI, motion as vm


def _starts(rows_by_k):
    return {k * vm.HZ_EVERY: r for k, r in rows_by_k.items()}


# ------------------------------------------------------------------ the gate
def test_a_horizon_that_drifts_away_from_the_calibrated_row_is_kept():
    t = np.arange(0, 1800, vm.HZ_EVERY)
    med = np.where(t < 600, 180.0, np.where(t < 1200, 222.0, 265.0))
    keep = vm.gate_track(t, med, 360)
    assert keep.all()


def test_an_isolated_wild_stretch_is_still_dropped():
    t = np.arange(0, 600, vm.HZ_EVERY)
    med = np.full(len(t), 200.0)
    med[40] = 300.0
    keep = vm.gate_track(t, med, 360)
    assert not keep[40] and keep[np.arange(len(t)) != 40].all()


def test_the_gate_scales_with_the_frame_height():
    t = np.arange(0, 300, vm.HZ_EVERY)
    med = np.full(len(t), 400.0)
    med[10] = 400.0 + 1.5 * vm.HZ_MAX_DEV                         # 90 rows at 720 = 45 at 360: kept
    assert vm.gate_track(t, med, 720)[10]
    med[10] = 400.0 + 2.5 * vm.HZ_MAX_DEV                         # 150 at 720 = 75 at 360: dropped
    assert not vm.gate_track(t, med, 720)[10]


# ------------------------------------------------------------------ both tracks use it
def test_the_video_track_follows_a_drift_away_from_the_calibrated_row(monkeypatch):
    monkeypatch.setattr(vm, "probe", lambda p: type("I", (), dict(duration=900.0, width=640, height=360, fps=30.0))())
    monkeypatch.setattr(vm, "_foe_sample", lambda a: [180.0 if a[2] < 450 else 265.0] * 8)
    tr = vm.horizon_track("v.mp4", 360, 249.0, hwaccel=False)
    assert len(tr["t"]) == len(np.arange(0, 900 - vm.HZ_WINDOW + 1e-9, vm.HZ_EVERY))
    assert min(tr["row"]) == 180.0 and max(tr["row"]) == 265.0


def test_the_extraction_track_follows_a_drift_away_from_the_calibrated_row(monkeypatch):
    P = type("P", (), dict(height=360, width=640, duration=900.0, rect=lambda self, a, b: None, stretch=lambda self, s, w: s))()
    monkeypatch.setattr(VI, "_foes", lambda P_, s, whole: np.full(8, 180.0 if s < 450 else 265.0))
    tr = VI.horizon_track(P, 249.0)
    assert len(tr["t"]) == len(np.arange(0, 900 - vm.HZ_WINDOW + 1e-9, vm.HZ_EVERY))
    assert min(tr["row"]) == 180.0 and max(tr["row"]) == 265.0


def test_the_gate_span_keys_the_motion_step(tmp_path, monkeypatch):
    from rsm.pipeline import config as C
    from tests.test_horizon_by_vehicle import _run
    run, base = _run(tmp_path)
    ref = run.hashes(base)
    monkeypatch.setattr(vm, "HZ_GATE_SPAN", vm.HZ_GATE_SPAN + 1)
    assert all(run.hashes(base)[s] != ref[s] for s in C.STEPS)
