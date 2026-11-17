# SPDX-License-Identifier: AGPL-3.0-or-later
"""rsm.core.matcher on small synthetic libraries (no files, deterministic)."""
from __future__ import annotations

import ast
import subprocess
import sys
from pathlib import Path

import numpy as np
import pytest

from rsm.core import metrics as M
from rsm.core.matcher import Candidate, MatchOptions, StatusThresholds, match
from rsm.core.trajectory import RelativeTrajectory, ScalePrior
import synthetic as syn

TH = StatusThresholds(gap_ratio=1.5, max_score=0.2)  # test values; the calibrated ones come from the benchmark
OPT = MatchOptions(rank_by="rmse_rel", thresholds=TH)
N_LIB = 8


@pytest.fixture(scope="module")
def library():
    return [Candidate(f"c{i}", syn.wiggly(100 + i, 800.0)[::2]) for i in range(N_LIB)]


def make_query(cand: Candidate, start: float, length: float, scale_true=0.83, angle=0.9, shift=(300.0, -200.0), noise=0.0, seed=0, mirror=False):
    p = cand.points
    s = np.concatenate([[0.0], np.cumsum(np.hypot(*np.diff(p, axis=0).T))])
    ss = np.linspace(start, start + length, 400)
    cut = np.column_stack([np.interp(ss, s, p[:, 0]), np.interp(ss, s, p[:, 1])])
    q = syn.move(cut, 1.0 / scale_true, angle, shift, mirror=mirror)
    q = syn.irregular_resample(q, 1.3, seed)
    if noise:
        q = q + np.random.default_rng(seed).normal(0, noise, q.shape)
    return RelativeTrajectory(q, scale=ScalePrior(min=0.7, max=1.4))


def test_core_imports_only_allowed_third_party_modules():
    core = Path(__file__).resolve().parents[1] / "rsm" / "core"
    allowed = {"numpy", "scipy", "shapely"}
    stdlib = set(sys.stdlib_module_names) | {"rsm"}
    seen = set()
    for f in core.glob("*.py"):
        for node in ast.walk(ast.parse(f.read_text())):
            mods = [a.name for a in node.names] if isinstance(node, ast.Import) else [node.module] if isinstance(node, ast.ImportFrom) and node.level == 0 and node.module else []
            seen |= {m.split(".")[0] for m in mods}
    assert seen - stdlib <= allowed, seen - stdlib - allowed
    code = ("import sys, rsm.core.trajectory, rsm.core.geometry, rsm.core.similarity, rsm.core.metrics, rsm.core.matcher; "
            "bad = [m for m in ('osmnx', 'gpxpy', 'pyproj', 'networkx', 'geopandas', 'skimage', 'dtaidistance') if m in sys.modules]; "
            "assert not bad, bad")
    r = subprocess.run([sys.executable, "-c", code], capture_output=True, text=True, cwd=core.parents[1])
    assert r.returncode == 0, r.stderr


@pytest.mark.parametrize("scale_true,angle,start,length", [(0.83, 0.9, 210.0, 400.0), (1.1, -2.5, 95.0, 300.0), (0.75, 3.0, 300.0, 350.0)])
def test_recovers_candidate_window_scale_rotation_under_perturbation(library, scale_true, angle, start, length):
    q = make_query(library[3], start, length, scale_true, angle, noise=0.3, seed=4)
    res = match(q, library, OPT)
    best = res.distinct[0]
    assert best.candidate_id == "c3" and best.rank == 1 and not best.reversed
    assert best.window_start_m == pytest.approx(start, abs=12.0)  # the window offset on the candidate
    assert best.window_length_m == pytest.approx(length, rel=0.05)
    assert best.scale == pytest.approx(scale_true, rel=0.03) and not best.scale_clamped
    # similarity maps the trajectory onto the candidate: check by applying it
    c, s = np.cos(best.rotation_rad), np.sin(best.rotation_rad)
    mapped = best.scale * q.points @ np.array([[c, -s], [s, c]]).T + best.translation
    d = np.min(np.hypot(*(mapped[:, None, :] - library[3].points[None, :, :]).transpose(2, 0, 1)), axis=1)
    assert d.max() < 3.0
    assert res.ambiguity.status == "confident" and res.ambiguity.second_score > 3 * best.score
    # every component is kept separately and finite
    for k in ("rmse_rel", "frechet_rel", "hausdorff_rel", "heading", "rmse_m", "frechet_m", "hausdorff_m"):
        assert np.isfinite(best.scores[k])
    assert res.grid["n_candidates"] == N_LIB and res.grid["windows_per_candidate"] > 20
    assert all(m.rank == i + 1 for i, m in enumerate(res.ranked))


def test_components_equal_the_metrics_module(library):
    q = make_query(library[1], 150.0, 400.0, noise=0.5, seed=2)
    res = match(q, library, OPT)
    m = res.distinct[0]
    n = res.grid["n_points"]
    c, s = np.cos(m.rotation_rad), np.sin(m.rotation_rad)
    qt = m.scale * q.resample_n(n).points @ np.array([[c, -s], [s, c]]).T + m.translation
    p = library[1].points
    cum = np.concatenate([[0.0], np.cumsum(np.hypot(*np.diff(p, axis=0).T))])
    ss = m.window_start_m + m.window_length_m * np.linspace(0, 1, n)
    win = np.column_stack([np.interp(ss, cum, p[:, 0]), np.interp(ss, cum, p[:, 1])])
    assert m.scores["rmse_m"] == pytest.approx(M.rmse(qt, win), rel=1e-9)
    assert m.scores["frechet_m"] == pytest.approx(M.frechet(qt, win), rel=1e-9)
    assert m.scores["hausdorff_m"] == pytest.approx(M.hausdorff(qt, win), rel=1e-9)
    assert m.scores["heading"] == pytest.approx(M.heading_signature_distance(qt, win, n), rel=1e-9)
    assert m.scores["rmse_rel"] == pytest.approx(m.scores["rmse_m"] / (m.scale * q.length), rel=1e-12)


def test_window_offset_found_at_both_ends_of_a_candidate(library):
    for start in (0.0, 400.0):  # query covers the first / last part of the candidate
        q = make_query(library[5], start, 400.0, noise=0.2, seed=1)
        best = match(q, library, OPT).distinct[0]
        assert best.candidate_id == "c5" and best.window_start_m == pytest.approx(start, abs=12.0)


def test_reverse_only_when_allowed(library):
    rev = [Candidate(c.id, c.points[::-1]) if c.id == "c2" else c for c in library]
    q = make_query(library[2], 200.0, 400.0, noise=0.2, seed=3)  # drives along c2 in its ORIGINAL direction
    fwd_best = match(q, library, OPT).distinct[0]
    assert fwd_best.candidate_id == "c2"
    off = match(q, rev, OPT)
    c2_off = next(m for m in off.ranked if m.candidate_id == "c2")
    assert c2_off.score > 5 * fwd_best.score  # the reversed candidate is not a good match by default
    assert all(not m.reversed and m.reverse_scores is None for m in off.ranked)
    on = match(q, rev, MatchOptions(rank_by="rmse_rel", thresholds=TH, allow_reverse=True))
    assert on.distinct[0].candidate_id == "c2" and on.distinct[0].reversed
    assert on.distinct[0].score == pytest.approx(fwd_best.score, rel=0.15)
    assert on.distinct[0].window_start_m == pytest.approx(200.0, abs=12.0)  # offset reported in the candidate's own direction
    assert on.distinct[0].reverse_scores["rmse_rel"] < on.distinct[0].forward_scores["rmse_rel"]
    # diagnostic only: computed and reported, but never used for the rank
    dg = match(q, rev, MatchOptions(rank_by="rmse_rel", thresholds=TH, diagnose_reverse=True))
    c2 = next(m for m in dg.ranked if m.candidate_id == "c2")
    assert c2.reverse_scores is not None and not c2.reversed and c2.reverse_scores["rmse_rel"] < c2.scores["rmse_rel"]
    assert c2.score == pytest.approx(c2_off.score)


def test_mirrored_query_is_rejected(library):
    strict = MatchOptions(rank_by="rmse_rel", thresholds=StatusThresholds(1.5, 0.006))  # max_score from the noise level of this test
    ok = match(make_query(library[4], 200.0, 400.0, noise=0.3, seed=5), library, strict)
    mir = match(make_query(library[4], 200.0, 400.0, noise=0.3, seed=5, mirror=True), library, strict)
    assert ok.ambiguity.status == "confident" and ok.distinct[0].candidate_id == "c4"
    own = next(m for m in mir.ranked if m.candidate_id == "c4")
    assert own.score > 10 * ok.distinct[0].score  # a reflection is not fitted: its own road scores >10x worse
    assert mir.distinct[0].score > 3 * ok.distinct[0].score  # and nothing else in the library fits well either
    assert mir.ambiguity.status == "no_match"
    assert own.scores["heading"] > 3 * ok.distinct[0].scores["heading"]


def test_duplicate_shape_is_ambiguous_not_confident(library):
    dup = Candidate("c3-copy", syn.move(library[3].points, 1.0, 1.3, (5000.0, 5000.0)), origin_id="elsewhere")
    q = make_query(library[3], 210.0, 400.0, noise=0.3, seed=4)
    res = match(q, library + [dup], OPT)
    assert {res.distinct[0].candidate_id, res.distinct[1].candidate_id} == {"c3", "c3-copy"}
    a = res.ambiguity
    assert a.status == "ambiguous" and a.gap_ratio == pytest.approx(1.0, abs=0.05) and a.n_within_eps >= 1
    assert a.second_id in ("c3", "c3-copy") and a.best_id != a.second_id


def test_overlapping_library_entries_of_one_road_are_not_distinct(library):
    base = library[6].points
    cum = np.concatenate([[0.0], np.cumsum(np.hypot(*np.diff(base, axis=0).T))])

    def cut(a, b):
        ss = np.arange(a, b, 4.0)
        return np.column_stack([np.interp(ss, cum, base[:, 0]), np.interp(ss, cum, base[:, 1])])

    overlapping = [Candidate(f"r{a}", cut(a, a + 600.0), origin_id="road", origin_offset_m=float(a)) for a in (0, 50, 100, 150)]
    others = [c for c in library if c.id != "c6"]
    q = make_query(Candidate("x", base), 200.0, 350.0, noise=0.2, seed=8)
    res = match(q, overlapping + others, OPT)
    assert sum(1 for m in res.ranked if m.origin_id == "road") == 4
    assert sum(1 for m in res.distinct if m.origin_id == "road") == 1  # the four entries are the same place
    assert res.ambiguity.status == "confident" and res.distinct[0].origin_id == "road"
    # without origin information the same entries compete as different candidates -> ambiguous
    plain = [Candidate(c.id, c.points) for c in overlapping]
    assert match(q, plain + others, OPT).ambiguity.status == "ambiguous"


def test_scale_clamped_warns(library):
    q = make_query(library[0], 100.0, 250.0, scale_true=1.8, noise=0.1, seed=6)  # true scale outside the prior [0.7, 1.4]
    res = match(q, library, OPT)
    m = next(m for m in res.ranked if m.candidate_id == "c0")
    assert m.scale_clamped and m.scale_at_bound and m.scale == pytest.approx(1.4)
    assert any("prior bound" in w for w in m.warnings)
    ok = match(make_query(library[0], 100.0, 250.0, scale_true=0.9, noise=0.1, seed=6), library, OPT)
    best = next(m for m in ok.ranked if m.candidate_id == "c0")
    assert not best.scale_clamped and not best.warnings


def test_no_match_status_when_nothing_resembles_the_query(library):
    q = make_query(library[0], 100.0, 400.0, noise=0.2, seed=6)
    others = [c for c in library if c.id != "c0"]
    res = match(q, others, MatchOptions(rank_by="rmse_rel", thresholds=StatusThresholds(1.5, 0.003)))
    assert res.ambiguity.status == "no_match" and "max_score" in res.ambiguity.reason


def test_candidate_shorter_than_the_shortest_window_is_skipped_and_counted(library):
    q = make_query(library[0], 100.0, 400.0, seed=6)
    short = Candidate("short", library[0].points[:20])
    res = match(q, library + [short], OPT)
    assert res.n_skipped == 1 and "short" not in {m.candidate_id for m in res.ranked}


def test_rerank_changes_order_but_not_alignments(library):
    q = make_query(library[3], 210.0, 400.0, noise=0.5, seed=4)
    res = match(q, library, OPT)
    for key, th in (("frechet_rel", StatusThresholds(1.2, 1.0)), ("heading", StatusThresholds(1.2, 5.0)), ("combo", StatusThresholds(1.2, 5.0))):
        r2 = res.rerank(key, th)
        assert r2.rank_by == key and r2.distinct[0].candidate_id == "c3"
        assert [m.scores for m in sorted(r2.ranked, key=lambda m: m.candidate_id)] == [m.scores for m in sorted(res.ranked, key=lambda m: m.candidate_id)]
        assert all(r2.ranked[i].score <= r2.ranked[i + 1].score for i in range(len(r2.ranked) - 1))


def test_deterministic_and_inputs_validated(library):
    q = make_query(library[3], 210.0, 400.0, noise=0.5, seed=4)
    a, b = match(q, library, OPT), match(q, library, OPT)
    assert [(m.candidate_id, m.score) for m in a.ranked] == [(m.candidate_id, m.score) for m in b.ranked]
    with pytest.raises(ValueError, match="no candidates"):
        match(q, [], OPT)
    with pytest.raises(ValueError, match="unique"):
        match(q, [library[0], library[0]], OPT)
    with pytest.raises(ValueError, match="thresholds"):
        match(q, library, MatchOptions(rank_by="rmse_rel"))  # no calibrated defaults are shipped until the benchmark ran
    with pytest.raises(ValueError):
        MatchOptions(rank_by="nonsense")
    with pytest.raises(ValueError):
        Candidate("bad", np.zeros((5, 2)))
    with pytest.raises(ValueError):
        StatusThresholds(0.5, 1.0)


def test_prefilter_option_keeps_the_true_candidate_here(library):
    q = make_query(library[3], 210.0, 400.0, noise=0.3, seed=4)
    res = match(q, library, MatchOptions(rank_by="rmse_rel", thresholds=TH, prefilter_k=3))
    assert res.n_prefiltered_out == N_LIB - 3 and res.distinct[0].candidate_id == "c3"


def test_extra_metric_hook_adds_scores_and_can_rank(library):
    q = make_query(library[3], 210.0, 400.0, noise=0.5, seed=4)
    # a stand-in for an optional metric: mean distance of paired points
    mean_d = lambda a, b: float(np.mean(np.hypot(*(a - b).T)))
    res = match(q, library, MatchOptions(rank_by="meand_rel", thresholds=TH, extra_metrics=(("meand", mean_d),)))
    best = res.distinct[0]
    assert best.candidate_id == "c3" and best.scores["meand_m"] == pytest.approx(best.scores["meand_rel"] * best.scale * q.length)
    assert "meand" in res.timings_s
    with pytest.raises(ValueError):
        MatchOptions(rank_by="meand_rel")  # unknown without the extra metric
    with pytest.raises(ValueError):
        MatchOptions(rank_by="dtw_rel")  # DTW is not in rsm.core
