# SPDX-License-Identifier: AGPL-3.0-or-later
"""T1 of docs/CONCEPT_test_strategy.md: every clip of rsm/bench/clip_set.json through the real motion and rotation steps (step cache), held against
its checks (rsm.bench.clips.check). Deselected by default (marker `clips`); run with `scripts/heavy.sh .venv/bin/python -m pytest -m clips`.
A clip that is not cut fails: cut them with `python -m rsm.bench.clips cut`."""
import pytest

from rsm.bench import clips as CL

pytestmark = pytest.mark.clips


@pytest.mark.parametrize("c", CL.clip_set(), ids=lambda c: c["id"])
def test_clip(c):
    assert (CL.CLIPS / c["id"] / "clip.json").exists(), f"clip not cut: python -m rsm.bench.clips cut --only {c['id']}"
    CL.run_clip(c, log=lambda m: None)
    row = CL.score(c)
    assert CL.check(row, c) == [], row
