# SPDX-License-Identifier: AGPL-3.0-or-later
"""user anchors (rsm.pipeline.anchors): "at video time t the camera is inside this map frame" -> HMM step masks"""
import json

import numpy as np
import pytest

from rsm.pipeline import anchors as AN


def _hmm_case(seed=3, n=16):
    from rsm.hmm import grid, seq
    from rsm.hmm_cal import dp
    from tests.test_hmm import city, heading_series, random_walk
    g = city()
    path = random_walk(g, np.random.default_rng(seed), n)
    st = seq.make_steps(heading_series(g, path), 30.0)
    G = grid.build(g, None, h=30.0)
    return g, path, st, G, dp.prepare(G, dp.Par())


def _bbox_around(g, xy, r):
    """S,W,N,E (degrees) of a square of half-width r m around xy (graph CRS)"""
    ll = g.to_wgs84(np.array([[xy[0] - r, xy[1] - r], [xy[0] + r, xy[1] + r]]))
    return [float(ll[:, 1].min()), float(ll[:, 0].min()), float(ll[:, 1].max()), float(ll[:, 0].max())]


@pytest.fixture(autouse=True)
def _off():
    yield
    AN.activate(None)


def test_parse_accepts_lists_and_dicts_and_sorts_by_time(tmp_path):
    raw = [{"t": 68, "bbox": [46.63, 8.59, 46.64, 8.60]}, {"t": 12.5, "bbox": {"south": 1, "west": 2, "north": 3, "east": 4}}]
    a = AN.parse(raw)
    assert [x["t"] for x in a] == [12.5, 68.0]
    assert a[1]["bbox"] == dict(south=46.63, west=8.59, north=46.64, east=8.60)
    f = tmp_path / "a.json"
    f.write_text(json.dumps({"anchors": raw}))
    assert AN.load(str(f)) == a
    assert AN.load(json.dumps(raw)) == a
    with pytest.raises(ValueError):
        AN.parse([{"t": -1, "bbox": [1, 2, 3, 4]}])
    with pytest.raises(ValueError):
        AN.parse([{"t": 3, "bbox": [3, 2, 1, 4]}])          # south > north


def test_time_maps_to_the_nearest_step():
    t = np.array([0.0, 1.0, 2.5, 4.0, 10.0])
    assert AN.step_of(t, 2.4) == 2
    assert AN.step_of(t, 0.0) == 0
    assert AN.step_of(t, 7.5) == 4                         # nearest end of a long step
    assert AN.step_of(t, 30.0) is None                     # after the video part of these steps
    assert AN.step_of(t, -6.0) is None                     # more than NEAR_S before the first step


def test_bbox_maps_to_the_cells_inside_plus_one_cell():
    g, path, st, G, pre = _hmm_case()
    c = G.xy[100]
    m = AN.cell_mask(G, AN.rect_xy(g.crs, AN.parse([{"t": 1, "bbox": _bbox_around(g, c, 5.0)}])[0]["bbox"]))
    d = np.hypot(*(G.xy - c).T)
    assert m[100] and m.sum() >= 1
    assert not m[d > 5.0 + 2 * G.h].any()                  # inside the frame grown by about one cell (h), nothing far away
    assert m[d <= 5.0].all()


def test_bbox_growth_includes_the_anchor_frames():
    bb = dict(south=46.5, west=8.5, north=46.6, east=8.6)
    a = AN.parse([{"t": 1, "bbox": [46.55, 8.55, 46.56, 8.56]}])
    assert AN.grow_bbox(bb, a) is None                     # inside: no change (map step not rerun)
    a2 = AN.parse([{"t": 1, "bbox": [46.62, 8.55, 46.63, 8.56]}])
    nb = AN.grow_bbox(bb, a2)
    assert nb["north"] > 46.63 and nb["south"] == 46.5 and nb["west"] == 8.5


def test_anchor_forces_the_toy_decode_through_the_frame():
    from rsm.hmm_cal import dp
    g, path, st, G, pre = _hmm_case()
    free = dp.viterbi(pre, st, backptr=True)
    j = st.T // 2
    p_free = G.xy[free["cell_path"][j]]
    far_c = int(np.argmax(np.hypot(*(G.xy - p_free).T) * (np.hypot(*(G.xy - p_free).T) < 500)))
    a = AN.parse([{"t": float(st.t[j]), "bbox": _bbox_around(g, G.xy[far_c], 20.0)}])
    AN.activate(a)
    r = dp.viterbi(pre, st, backptr=True)
    m = AN.step_masks(G, st, a)
    assert list(m) == [j]
    assert np.isfinite(r["score"]) and m[j][r["cell_path"][j]]
    assert r["score"] < free["score"]
    fb = dp.forward_backward(pre, st, r["cell_path"])
    assert np.isfinite(fb["p_vit"][j])
    AN.activate(None)
    assert dp.viterbi(pre, st)["score"] == pytest.approx(free["score"])


def test_infeasible_anchor_is_dropped_and_the_others_kept():
    from rsm.hmm_cal import dp
    g, path, st, G, pre = _hmm_case()
    free = dp.viterbi(pre, st, backptr=True)
    j1, j2 = st.T // 3, 2 * st.T // 3
    good = {"t": float(st.t[j1]), "bbox": _bbox_around(g, G.xy[free["cell_path"][j1]], 10.0)}
    # the same place one step later than another anchor 600 m away: no route covers 600 m in one step
    p = G.xy[free["cell_path"][j2]]
    far = G.xy[int(np.argmax(np.hypot(*(G.xy - p).T)))]
    bad = {"t": float(st.t[j2 + 1]), "bbox": _bbox_around(g, far, 5.0)}
    near = {"t": float(st.t[j2]), "bbox": _bbox_around(g, p, 10.0)}
    an = AN.parse([good, near, bad])

    def feasible(sub):
        AN.activate(sub)
        try:
            return np.isfinite(dp.viterbi(pre, st)["score"])
        finally:
            AN.activate(None)

    kept, dropped = AN.prune(an, feasible)
    assert [x["t"] for x in kept] == [good["t"], near["t"]]
    assert [x["t"] for x in dropped] == [bad["t"]]


def test_anchors_change_only_the_route_side_hashes():
    from rsm.pipeline.cli import Run
    P = dict(video=__file__, bbox=dict(south=46.5, west=8.5, north=46.7, east=8.7), pbf=__file__, vehicle="auto", offset_m=None, traffic_side="auto", decoys=0,
             start_tol_m=150.0, hint_buffer_m=300.0, hint_fallback="auto")
    h0 = Run.hashes(None, P)
    h1 = Run.hashes(None, dict(P, anchors=AN.parse([{"t": 68, "bbox": [46.63, 8.59, 46.64, 8.60]}])))
    h2 = Run.hashes(None, dict(P, anchors=AN.parse([{"t": 69, "bbox": [46.63, 8.59, 46.64, 8.60]}])))
    for s in ("motion", "rotation", "map"):
        assert h0[s] == h1[s] == h2[s]
    for s in ("route_search", "plausibility", "refine", "gpx"):
        assert len({h0[s], h1[s], h2[s]}) == 3


def test_cli_parses_anchors_option():
    from rsm.pipeline.cli import parse_args
    a = parse_args(["run", "--video", "v", "--bbox", "1,2,3,4", "--pbf", "p", "--out", "o", "--anchors", "x.json"])
    assert a.anchors == "x.json"


def _fake_pipeline(tmp_path, monkeypatch, argv):
    """cli.Run.run with a fake worker: -> (exit code, steps computed, step events)"""
    from rsm.pipeline import cli, memguard
    from rsm.pipeline.common import jdump
    monkeypatch.setattr(memguard, "free_percent", lambda: None)
    out, ran, events = tmp_path / "out", [], []
    monkeypatch.setattr(cli, "emit", lambda e: events.append(e))
    summ = dict(f_eff=600.0, kappa=1.0, conf_mean=0.9, path_km=10.0)

    def fake_worker(self, sid, i):
        ran.append(sid)
        if sid == "gpx":
            jdump(out / "project.json", dict(verdict_detail=dict(verdict="confident", basis="x", reasons=[], signals={}), effective=dict(vehicle="car", offset_m=1.6, traffic_side="right")))
        return 0, dict(summary=summ, seconds=0.1, peak_gb=None), []
    monkeypatch.setattr(cli.Run, "run_worker", fake_worker)
    a = cli.parse_args(["run", "--video", __file__, "--bbox", "46.5,8.5,46.7,8.7", "--pbf", __file__, "--out", str(out), *argv])
    return cli.Run(a).run(), ran, [e for e in events if e.get("type") == "step"]


def test_rerun_reuses_unchanged_steps_and_from_step_forces_the_rest(tmp_path, monkeypatch):
    rc, ran, _ = _fake_pipeline(tmp_path, monkeypatch, ["--resume"])
    assert rc == 0 and ran == ["motion", "rotation", "map", "route_search", "refine", "gpx"]
    # new anchors (inside the area): motion, rotation and map are reused, route_search onward computed again
    af = tmp_path / "a.json"
    af.write_text(json.dumps([{"t": 68, "bbox": [46.63, 8.59, 46.64, 8.60]}]))
    rc, ran, ev = _fake_pipeline(tmp_path, monkeypatch, ["--resume", "--anchors", str(af)])
    assert rc == 0 and ran == ["route_search", "refine", "gpx"]
    assert [e["id"] for e in ev if e.get("reused")] == ["motion", "rotation", "map"]
    # nothing changed: everything reused
    rc, ran, _ = _fake_pipeline(tmp_path, monkeypatch, ["--resume", "--anchors", str(af)])
    assert rc == 0 and ran == []
    # explicit rerun from refine: the steps before it are reused, refine and gpx computed
    rc, ran, _ = _fake_pipeline(tmp_path, monkeypatch, ["--resume", "--anchors", str(af), "--from-step", "refine"])
    assert rc == 0 and ran == ["refine", "gpx"]
    # an anchor outside the search area grows it: the map step (and everything after it) reruns, motion and rotation do not
    af.write_text(json.dumps([{"t": 68, "bbox": [46.75, 8.59, 46.76, 8.60]}]))
    rc, ran, _ = _fake_pipeline(tmp_path, monkeypatch, ["--resume", "--anchors", str(af)])
    assert rc == 0 and ran == ["map", "route_search", "refine", "gpx"]
    assert json.loads((tmp_path / "out" / "project.params.json").read_text())["bbox"]["north"] > 46.76


def test_from_step_needs_resume_and_earlier_results(tmp_path, monkeypatch):
    rc, ran, _ = _fake_pipeline(tmp_path, monkeypatch, ["--from-step", "refine"])
    assert rc == 2 and ran == []
    rc, ran, _ = _fake_pipeline(tmp_path, monkeypatch, ["--resume", "--from-step", "refine"])
    assert rc == 2 and ran == []                        # no earlier run to reuse
