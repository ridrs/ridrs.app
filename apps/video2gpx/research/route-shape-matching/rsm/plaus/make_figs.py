# SPDX-License-Identifier: AGPL-3.0-or-later
"""python -m rsm.plaus.make_figs <tag>: three example figures on TEST (Rousset, refined input): accepted true, rejected wrong, wrongly accepted (loose priors)."""
import pickle
import sys

from . import decide as D
from . import experiment as X
from . import fig, fit, pipeline as P


def main(tag):
    cal = pickle.load(open(P.WORK / f"cal_{tag}.pkl", "rb"))["refined"]
    recs = X.load_set(tag, "TEST", "refined")
    src = P.Source("col-de-rousset", "refined", variant="wider")
    (P.WORK / "figs").mkdir(exist_ok=True)
    a, b, _ = fig.pick_examples(recs, cal, "measured")
    # wrongly accepted: the wrong decision under the loose priors (none exists under the measured priors on TEST)
    wl = None
    for r in recs:
        d = D.decide(r, "loose", cal["loose"]["tau"], cal["loose"]["m"])
        if d is not None and not d[0]["correct"]:
            wl = (r, d[0]["rank"]); break
    info = {}
    for name, ex, st, ttl in (("accepted_true", a, "measured", "ACCEPTED, correct (measured priors)"), ("rejected_wrong", b, "measured", "REJECTED wrong candidate (measured priors)"),
                              ("wrongly_accepted_loose", wl, "loose", "WRONGLY ACCEPTED (loose priors)")):
        if ex is None:
            continue
        r, rk = ex
        f = fig.draw(src, r, rk, st, fit.PRIORS[st], f"Rousset, window L={r['L']} quanta {r['lo']}..{r['hi']}, candidate rank {rk}: {ttl}", str(P.WORK / "figs" / f"{name}.png"))
        info[name] = dict(L=r["L"], lo=r["lo"], rank=rk, snorm=f.snorm, rms=f.rms, frechet=f.frechet, maxdev=f.maxdev, rho=f.rho, kappa=f.kappa, rate=list(map(float, f.rate)))
    print(info)


if __name__ == "__main__":
    main(sys.argv[1])
