# SPDX-License-Identifier: AGPL-3.0-or-later
"""DEVELOPMENT-ONLY probe harness (docs/CONCEPT_fast_testing.md, block C): call one changed function for every bench case in this process, on the
finished artifacts of a bench tag, and print a small table. No pipeline step runs, nothing in the case directories is changed.

    .venv/bin/python -m rsm.bench.probe local_accept --tag seed1                 # all cases of the tag
    .venv/bin/python -m rsm.bench.probe local_accept --tag seed1 --save base     # keep the result as work/probes/local_accept/base.json
    .venv/bin/python -m rsm.bench.probe local_accept --tag seed1 --baseline base # columns that differ from the saved result in brackets

A probe is a module rsm/bench/probes/<name>.py with NEEDS (the step directories it reads) and run(d: Path, case: dict) -> dict of flat values.
Heavy probes (a decode on a large corridor) should still be run through scripts/heavy.sh."""
from __future__ import annotations

import argparse
import importlib
import json
import os
import sys
import time
import traceback
from pathlib import Path

from .regress import WORK, cases

OUT = WORK.parent / "probes"


def _fmt(v) -> str:
    if isinstance(v, float):
        return f"{v:.3g}" if abs(v) < 1000 else f"{v:.0f}"
    return "" if v is None else str(v)


def table(rows: list[dict], base: dict | None = None) -> str:
    keys = [k for k in dict.fromkeys(k for r in rows for k in r) if k != "case"]
    out = ["| case | " + " | ".join(keys) + " |", "|---" * (len(keys) + 1) + "|"]
    for r in rows:
        b = (base or {}).get(r["case"], {})
        cells = []
        for k in keys:
            v, w = _fmt(r.get(k)), _fmt(b.get(k)) if k in b else None
            cells.append(v if w is None or w == v else f"{v} ({w})")
        out.append(f"| {r['case']} | " + " | ".join(cells) + " |")
    return "\n".join(out)


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(prog="rsm.bench.probe")
    ap.add_argument("probe")
    ap.add_argument("--tag", default="seed1", help="bench tag whose case directories are read")
    ap.add_argument("--only", default=None)
    ap.add_argument("--save", default=None)
    ap.add_argument("--baseline", default=None)
    a = ap.parse_args(argv)
    os.environ.setdefault("RSM_DATA_DIR", str(WORK / "_data"))
    mod = importlib.import_module(f"rsm.bench.probes.{a.probe}")
    rows = []
    for c in cases(a.only.split(",") if a.only else None):
        d = WORK / a.tag / c["name"]
        missing = [s for s in getattr(mod, "NEEDS", ()) if not (d / "steps" / f"{s}.done.json").exists()]
        if missing:
            rows.append(dict(case=c["name"], error=f"missing steps {','.join(missing)} in {a.tag}"))
            continue
        t0 = time.time()
        try:
            r = mod.run(d, c)
        except Exception as e:                                     # a probe must not stop the others
            traceback.print_exc(file=sys.stderr)
            r = dict(error=f"{type(e).__name__}: {e}")
        rows.append(dict(case=c["name"], **r, seconds=round(time.time() - t0, 1)))
        print(time.strftime("%H:%M:%S"), c["name"], f"{rows[-1]['seconds']} s", flush=True)
    base = None
    if a.baseline:
        f = OUT / a.probe / f"{a.baseline}.json"
        base = {r["case"]: r for r in json.loads(f.read_text())} if f.exists() else None
    print(table(rows, base))
    if a.save:
        (OUT / a.probe).mkdir(parents=True, exist_ok=True)
        (OUT / a.probe / f"{a.save}.json").write_text(json.dumps(rows, indent=1, default=float))
    return 0


if __name__ == "__main__":
    sys.exit(main())
