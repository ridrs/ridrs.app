# SPDX-License-Identifier: AGPL-3.0-or-later
"""T3 of docs/CONCEPT_test_strategy.md: the whole pipeline on the long videos of rsm/bench/long_set.json (step cache), held against their checks
(rsm.bench.long.check), with the route compared with the T2 run of tag t2base when it is there. Deselected by default (marker `long`); run with
`scripts/heavy.sh .venv/bin/python -m pytest -m long`. A long video that is not cut fails: cut them with `python -m rsm.bench.long cut`."""
import pytest

from rsm.bench import long as LG

pytestmark = pytest.mark.long


@pytest.mark.parametrize("c", LG.long_set(), ids=lambda c: c["id"])
def test_long(c):
    assert (LG.LONG / c["id"] / "case.json").exists(), f"not cut: python -m rsm.bench.long cut --only {c['id']}"
    LG.run(c, log=lambda m: None)
    row = LG.score(c, "t2base")
    assert LG.check(row, c) == [], row
