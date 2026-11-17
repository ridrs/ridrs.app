# SPDX-License-Identifier: AGPL-3.0-or-later
import json

import numpy as np
import pytest

from rsm import cli
from rsm.core.trajectory import RelativeTrajectory, ScalePrior
from rsm.io import road_reconstruction, trajectory_json as tj
import synthetic as syn


def full() -> RelativeTrajectory:
    rng = np.random.default_rng(11)
    n = 50
    pts = np.cumsum(rng.normal(size=(n, 2)) * [0.37, 1.13], axis=0) * 1.0000000000001 + 1 / 3
    return RelativeTrajectory(pts, z=rng.normal(size=n) / 7, t=np.sort(rng.uniform(0, 1e4, n)), uncertainty=rng.uniform(0, 1, n) / 3,
                              scale=ScalePrior(True, 0.9, 1.1), direction_known=False, junctions=(1 / 3, 2.5),
                              metadata={"route": "x", "nested": {"a": [1, 2.5, None]}, "warnings": ["w"]})


def test_roundtrip_exact(tmp_path):
    tr = full()
    p = tmp_path / "t.json"
    tj.write(tr, p)
    back = tj.read(p)
    assert back.equals(tr)
    assert tj.from_dict(json.loads(json.dumps(tj.to_dict(tr)))).equals(tr)


def test_roundtrip_minimal(tmp_path):
    tr = syn.irregular()
    tj.write(tr, tmp_path / "t.json")
    d = json.loads((tmp_path / "t.json").read_text())
    assert set(d["points"][0]) == {"x", "y"} and d["schema"] == 1
    assert tj.read(tmp_path / "t.json").equals(tr)


def good() -> dict:
    return tj.to_dict(full())


def mutated(**kw) -> dict:
    d = good()
    for k, v in kw.items():
        if v is KeyError:
            del d[k]
        else:
            d[k] = v
    return d


@pytest.mark.parametrize("bad, msg", [
    (mutated(schema=2), "unsupported schema"),
    (mutated(schema="1"), "unsupported schema"),
    (mutated(schema=True), "unsupported schema"),
    (mutated(schema=KeyError), "missing required field 'schema'"),
    (mutated(points=KeyError), "missing required"),
    (mutated(scale=KeyError), "missing required"),
    (mutated(frame=KeyError), "missing required"),
    (mutated(direction_known=KeyError), "missing required"),
    (mutated(provenance=KeyError), "missing required"),
    (mutated(junctions=KeyError), "missing required"),
    (mutated(extra=1), "unknown field"),
    (mutated(frame={"x": "left", "y": "forward", "unit": "m", "georeferenced": False}), "frame"),
    (mutated(frame={"x": "right", "y": "forward", "unit": "m", "georeferenced": True}), "frame"),
    (mutated(points=[]), "non-empty"),
    (mutated(points=[{"x": 0, "y": 0}]), "at least 2"),
    (mutated(points=[{"x": 0, "y": 0}, {"x": 1}]), "keys"),
    (mutated(points=[{"x": 0, "y": 0, "w": 1}, {"x": 1, "y": 1, "w": 1}]), "point keys"),
    (mutated(points=[{"x": 0, "y": 0}, {"x": "1", "y": 1}]), "not a number"),
    (mutated(points=[{"x": 0, "y": 0}, {"x": 0, "y": 0}]), "identical"),
    (mutated(scale={"known": False, "prior_min": 0.7}), "scale"),
    (mutated(scale={"known": False, "prior_min": 2.0, "prior_max": 1.0}), "prior"),
    (mutated(direction_known="yes"), "direction_known"),
    ([], "top level"),
])
def test_reader_rejects(bad, msg):
    with pytest.raises(tj.SchemaError, match=msg):
        tj.from_dict(bad)


def test_reader_rejects_bad_files(tmp_path):
    p = tmp_path / "t.json"
    p.write_text("{not json")
    with pytest.raises(tj.SchemaError, match="not valid JSON"):
        tj.read(p)
    p.write_text(json.dumps(good()).replace('"x": ', '"x": NaN, "q": ', 1))
    with pytest.raises(tj.SchemaError):
        tj.read(p)


# -- road-reconstruction adapter -------------------------------------------------------------

def make_route(root, alignment=None, name="r1", with_road=False, pipeline="fresh"):
    root = root / name
    (root / "metadata").mkdir(parents=True)
    cams = [{"name": f"{i}.jpg", "frame": i, "time": 100.0 + i, "position": [float(i), 0.5 + i / 10, -2.0 * i]} for i in range(6)]
    (root / "route.json").write_text(json.dumps({"cameras": cams}))
    if alignment is not None:
        (root / "metadata" / "alignment.json").write_text(json.dumps(alignment))
    if with_road:
        (root / "road-mesh").mkdir()
        st = {"center": [[0.0, 0.0, -float(i)] for i in range(5)]}
        (root / "road-mesh" / "road.json").write_text(json.dumps({"stations": st}))
    if pipeline is not None:
        # alignment finished at t=110; export/road started after (fresh) or before (stale)
        later = 200.0 if pipeline == "fresh" else 50.0
        st = {"alignment": {"status": "done", "started": 100.0, "seconds": 10.0},
              "export": {"status": "done", "started": later, "seconds": 5.0},
              "road": {"status": "done", "started": later, "seconds": 5.0}}
        (root / "metadata" / "pipeline.json").write_text(json.dumps({"stages": st}))
    return root


GPX_ALIGN = {"up": {"method": "GPX elevation profile"}, "scale_source": "gpx", "scale_agreement": 0.8}
FREE_ALIGN = {"up": {"method": "vertical lines"}, "scale_source": "camera_height"}


def test_adapter_projection_and_gpx_free(tmp_path):
    tr = road_reconstruction.load(make_route(tmp_path, FREE_ALIGN))
    assert np.allclose(tr.points[:, 0], np.arange(6)) and np.allclose(tr.points[:, 1], 2.0 * np.arange(6))  # (X, -Z)
    assert np.allclose(tr.z, 0.5 + np.arange(6) / 10) and np.allclose(tr.t, 100 + np.arange(6))
    assert tr.metadata["scale_source"] == "camera_height" and tr.metadata["up_method"] == "vertical lines"
    assert tr.metadata["gpx_free"] is True and tr.warnings == []
    assert tr.scale == ScalePrior(False, 0.7, 1.4)


def test_adapter_flags_gpx(tmp_path):
    tr = road_reconstruction.load(make_route(tmp_path, GPX_ALIGN))
    assert tr.metadata["gpx_free"] is False
    assert tr.metadata["scale_source"] == "gpx" and tr.metadata["up_method"] == "GPX elevation profile"
    assert len(tr.warnings) == 2 and any("scale" in w for w in tr.warnings) and any("gravity" in w for w in tr.warnings)
    only_scale = road_reconstruction.load(make_route(tmp_path, {"up": {"method": "vertical lines"}, "scale_source": "gpx"}, name="r2"))
    assert len(only_scale.warnings) == 1 and only_scale.metadata["gpx_free"] is False


def test_adapter_missing_alignment_is_unknown_not_clean(tmp_path):
    tr = road_reconstruction.load(make_route(tmp_path, None))
    assert tr.metadata["z_reliable"] is False
    assert tr.metadata["scale_source"] == "unknown" and tr.metadata["gpx_free"] is False and tr.warnings


def test_adapter_stale_route_json_raises(tmp_path):
    root = make_route(tmp_path, FREE_ALIGN, pipeline="stale")
    with pytest.raises(ValueError, match="stale"):
        road_reconstruction.load(root)
    # metadata/cameras.json is preferred and is written by alignment itself: fresh by construction
    (root / "metadata" / "cameras.json").write_text((root / "route.json").read_text())
    assert len(road_reconstruction.load(root)) == 6
    root2 = make_route(tmp_path, FREE_ALIGN, name="r2", with_road=True, pipeline="stale")
    with pytest.raises(ValueError, match="stale"):
        road_reconstruction.load(root2, "road-center")


def test_adapter_missing_pipeline_or_unfinished_alignment_raises(tmp_path):
    with pytest.raises(ValueError, match="pipeline.json missing"):
        road_reconstruction.load(make_route(tmp_path, FREE_ALIGN, pipeline=None))
    root = make_route(tmp_path, FREE_ALIGN, name="r2")
    pj = root / "metadata" / "pipeline.json"
    d = json.loads(pj.read_text()); d["stages"]["alignment"]["status"] = "failed"; pj.write_text(json.dumps(d))
    with pytest.raises(ValueError, match="not done"):
        road_reconstruction.load(root)


def test_adapter_z_reliability_and_scale_prior(tmp_path):
    fb = {"up": {"method": "trajectory plane"}, "scale_source": "camera_height"}
    tr = road_reconstruction.load(make_route(tmp_path, fb), scale_min=0.8, scale_max=1.3)
    assert tr.metadata["z_reliable"] is False and any("z/elevation is unreliable" in w for w in tr.warnings)
    assert tr.metadata["gpx_free"] is True and tr.scale == ScalePrior(False, 0.8, 1.3)
    assert road_reconstruction.load(make_route(tmp_path, FREE_ALIGN, name="r2")).metadata["z_reliable"] is True


def test_adapter_falls_back_to_cameras_json_and_road_center(tmp_path):
    root = make_route(tmp_path, FREE_ALIGN, with_road=True)
    (root / "route.json").rename(root / "metadata" / "cameras.json")
    (root / "route.json").write_text("{}")  # ignored: cameras.json wins
    assert len(road_reconstruction.load(root)) == 6
    c = road_reconstruction.load(root, "road-center")
    assert c.t is None and np.allclose(c.points[:, 1], np.arange(5)) and any("road centre" in w for w in c.warnings)
    with pytest.raises(FileNotFoundError):
        road_reconstruction.load(tmp_path / "nope")
    with pytest.raises(ValueError):
        road_reconstruction.load(root, "bogus")


def test_cli_roundtrip(tmp_path, capsys):
    root = make_route(tmp_path, GPX_ALIGN)
    out = tmp_path / "work" / "r.trajectory.json"
    assert cli.main(["trajectory", "--from-reconstruction", str(root), "--scale-min", "0.8", "-o", str(out)]) == 0
    assert cli.main(["trajectory-info", str(out)]) == 0
    text = capsys.readouterr()
    assert "scale_source: gpx" in text.out and "warnings:   2" in text.out and "GPX" in text.err
    assert cli.main(["trajectory-info", str(tmp_path / "missing.json")]) == 2
