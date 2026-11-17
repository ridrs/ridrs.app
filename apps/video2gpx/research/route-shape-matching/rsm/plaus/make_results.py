# SPDX-License-Identifier: AGPL-3.0-or-later
"""python -m rsm.plaus.make_results <tag>: tables for DEV-A, TEST-B, TEST -> work/plaus/tables_<tag>.md"""
from __future__ import annotations

import pickle
import sys

from . import pipeline as P
from . import report as R

SPLIT_TITLE = {"DEV-A": "DEV-A (first halves of Grimone and Roanne; tuned here, optimistic)",
               "TEST-B": "TEST-B (second half of Grimone; Roanne's second half has no window; held out from the start)",
               "TEST": "TEST (Rousset; second use of Rousset as test; run once after the freeze)"}


def main(tag):
    cal = pickle.load(open(P.WORK / f"cal_{tag}.pkl", "rb"))
    out = []
    for h in ("DEV-A", "TEST-B", "TEST"):
        d = R.load_all(tag, h)
        out.append(f"## {SPLIT_TITLE[h]}\n")
        out.append("### Stage A: true chain among the K candidates (windows)\n\n" + R.recall_table(d, h) + "\n")
        out.append("### Stage B decisions per window length: correct / wrong / none\n\n" + R.decision_table(d, h, cal) + "\n")
        out.append("### Acceptance of true and wrong candidates (K = 50; summed over L = 5, 10, 20)\n\n" + R.accept_table(d, h, cal) + "\n")
        out.append("### Controls (refined input; every accepted candidate and every decision is a failure)\n\n" + R.control_table(d, h, cal) + "\n")
        out.append("### Fitted corrections, measured priors, p1\n\n" + R.corr_table(d, h, cal) + "\n")
        out.append("### Effect of K in stage B (measured priors, p1)\n\n" + R.kdep_table(d, cal) + "\n")
        out.append("### Cross-window consistency (refined input)\n\n" + R.vc_table(d, cal) + "\n\nVideo-level estimates:\n\n" + R.vc_estimates(d) + "\n")
        out.append("### Post hoc: baseline with the refined threshold\n\n" + R.posthoc_baseline(d, cal) + "\n")
        out.append(f"### Runtime\n\n{R.runtime(d)}\n")
    (P.WORK / f"tables_{tag}.md").write_text("\n".join(out))
    print("\n".join(out))


if __name__ == "__main__":
    main(sys.argv[1])
