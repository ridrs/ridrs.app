import pickle, sys, numpy as np
from . import exp
def f(x): return "n/a" if x is None or (isinstance(x,float) and not np.isfinite(x)) else (f"{100*x:.0f}%" if isinstance(x,float) and abs(x)<=1.0001 else str(x))
def row(video, cfg):
    d = pickle.load(open(exp.RES / f"{cfg}_{video}.pkl", "rb"))["out"]
    P1, P2 = d["P1"], d["P2"]
    def sc(P, k): s = P[k]; return f"on30 {s['on30']:.2f} (dec {s.get('on30_of_decided',0):.2f}) road {s['on_road']:.2f} J {s['junc_correct']}/{s['junc_wrong']}/{s['junc_off']}"
    print(f"{video} {cfg} [{d['seconds']:.0f}s] sf={d.get('speed_fit',{}).get('a','-')},{d.get('speed_fit',{}).get('b','-')}")
    print("  lead(P1):", sc(P1, "lead"), "| stitch P1:", sc(P1, "stitch"), "| chain P1:", sc(P1, "chain_filled"))
    print("  P2: lead", sc(P2, "lead"), "| stitch", sc(P2, "stitch"), "| chain", sc(P2, "chain_filled"), "| chain dec", sc(P2,"chain"))
    s = d["sep"]; print("  sep: cpk %.1f/%.1f auc %.2f good %.0f/%.0f auc %.2f" % (s["cpk_true"], s["cpk_wrong"], s["auc_cost"], s["good_true"], s["good_wrong"], s["auc_good"]), {k: round(v, 1) for k, v in d["comp_true"].items()})
    if "ctl_mirror" in d: print("  ctl", d["ctl_mirror"], d["ctl_foreign"], d["ctl_random"])
if __name__ == "__main__":
    for c in sys.argv[2:]: row(sys.argv[1], c)
