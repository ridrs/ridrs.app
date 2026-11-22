# SPDX-License-Identifier: AGPL-3.0-or-later
"""A30: a start / end outside its frame costs per metre; the tolerance stays the outer limit.

Lahntal (2026-11-22): the start frame was 93 x 70 m, the tolerance 150 m, and every start within it was free: the decoded start lay 144 m outside the
frame (98 m from the hint start), which absorbed about 100 m of distance the video measured too much."""
import numpy as np
import pytest
from pyproj import Transformer

from rsm.hmm import grid, seq
from rsm.hmm_cal import dp
from rsm.pipeline import config as C, hints as HI
from tests.test_hmm import city, heading_series, random_walk


@pytest.fixture(autouse=True)
def _off():
    HI.activate_frame_cost(None)
    yield
    HI.activate_frame_cost(None)


def _case(seed=3):
    g = city()
    path = random_walk(g, np.random.default_rng(seed), 16)
    st = seq.make_steps(heading_series(g, path), 30.0)
    return g, dp.prepare(grid.build(g, None, h=30.0), dp.Par()), st


# ------------------------------------------------------------------ the decoder takes a prior on the first and the last cell
def test_a_constant_prior_shifts_the_score_and_keeps_the_path(monkeypatch):
    g, pre, st = _case()
    plain = dp.viterbi(pre, st, backptr=True)
    monkeypatch.setattr(dp, "FRAME_PRIOR_HOOK", lambda G: (np.full(G.N, -1.0, np.float32), np.full(G.N, -2.0, np.float32)))
    r = dp.viterbi(pre, st, backptr=True)
    assert r["score"] == pytest.approx(plain["score"] - 3.0, abs=1e-3)
    assert np.array_equal(r["cell_path"], plain["cell_path"])


def test_an_infinite_prior_acts_like_the_hard_frame(monkeypatch):
    g, pre, st = _case()
    ok = np.zeros(pre.grid.N, bool)
    ok[: pre.grid.N // 3] = True
    hard = dp.viterbi(pre, st, backptr=True, start_ok=ok)
    monkeypatch.setattr(dp, "FRAME_PRIOR_HOOK", lambda G: (np.where(ok, 0.0, -np.inf).astype(np.float32), None))
    soft = dp.viterbi(pre, st, backptr=True)
    assert soft["score"] == pytest.approx(hard["score"], abs=1e-3)
    assert np.array_equal(soft["cell_path"], hard["cell_path"])


def test_the_posterior_takes_the_prior_too(monkeypatch):
    g, pre, st = _case()
    ok = np.zeros(pre.grid.N, bool)
    ok[: pre.grid.N // 3] = True
    r = dp.viterbi(pre, st, backptr=True, start_ok=ok)
    hard = dp.forward_backward(pre, st, r["cell_path"], start_ok=ok, end_ok=ok)
    monkeypatch.setattr(dp, "FRAME_PRIOR_HOOK", lambda G: (np.where(ok, 0.0, -np.inf).astype(np.float32),) * 2)
    soft = dp.forward_backward(pre, st, r["cell_path"])
    assert np.allclose(np.nan_to_num(soft["p_vit"]), np.nan_to_num(hard["p_vit"]), atol=1e-3)


# ------------------------------------------------------------------ the cost of the run's frames
def _frame_around(g, x0, x1, y0, y1):
    tr = Transformer.from_crs(g.crs, 4326, always_xy=True)
    (w, e), (s, n) = tr.transform([x0, x1], [y0, y1])
    return dict(south=s, west=w, north=n, east=e)


def test_inside_the_frame_is_free_and_outside_costs_per_metre():
    g = city()
    G = grid.build(g, None, h=30.0)
    fr = _frame_around(g, -10.0, 10.0, -10.0, 250.0)                 # around the street x = 0, y 0..240
    HI.activate_frame_cost(dict(start=fr, end=None, tol=150.0), g.crs)
    s, e = HI.frame_prior(G)
    assert e is None
    inside = (np.abs(G.xy[:, 0]) < 5) & (G.xy[:, 1] > 0) & (G.xy[:, 1] < 240)
    assert np.allclose(s[inside], 0.0, atol=1e-3)
    far = (G.xy[:, 0] > 200) & (G.xy[:, 1] > 0) & (G.xy[:, 1] < 240)
    d = G.xy[far, 0] - 10.0
    assert np.allclose(s[far], -C.FRAME_COST_NATS_PER_M * d, rtol=0.02)


def test_activating_the_frames_sets_the_decoder_hook_and_none_clears_it():
    g = city()
    HI.activate_frame_cost(dict(start=_frame_around(g, 0, 10, 0, 10), end=None, tol=150.0), g.crs)
    assert dp.FRAME_PRIOR_HOOK is not None and HI.frame_cost_key() != ""
    HI.activate_frame_cost(None)
    assert dp.FRAME_PRIOR_HOOK is None and HI.frame_cost_key() == ""


def test_the_frame_cost_is_in_the_keys_of_a_run_with_frames_only(tmp_path, monkeypatch):
    from tests.test_horizon_by_vehicle import _run
    run, base = _run(tmp_path)
    fr = dict(south=1.0, west=2.0, north=1.1, east=2.1)
    h0, hf = run.hashes(base), run.hashes(dict(base, start_bbox=fr))
    monkeypatch.setattr(C, "FRAME_COST_NATS_PER_M", C.FRAME_COST_NATS_PER_M * 2)
    assert run.hashes(base) == h0 and run.hashes(dict(base, start_bbox=fr))["route_search"] != hf["route_search"]
