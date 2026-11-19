"""Recomputes the Part A metrics from the saved logits in double precision.

The Kaggle run stored probabilities in float32. After sharpening (T*/4), about 83% of test images then have a
confidence of exactly 1.0, so AUROC and the Spearman correlation are computed on heavily tied values. This script
recomputes every metric from the saved logits in float64 and writes new tables next to the original ones
(the original Kaggle outputs are kept unchanged).

Usage: python recompute_full_precision.py <folder with probs_seed*.npz> partA/results
"""
import os, sys
import numpy as np, pandas as pd
import matplotlib; matplotlib.use("Agg"); import matplotlib.pyplot as plt
from sklearn.metrics import roc_auc_score
from scipy.stats import spearmanr

NPZ, OUT = sys.argv[1], sys.argv[2]
h = pd.read_csv(os.path.join(OUT, "cifar10h_difficulty.csv")).sort_values("test_idx")
y, human_acc = h.true_label.values, h.human_acc.values

def ece(conf, correct, bins=15):
    edges = np.linspace(0, 1, bins + 1); e = 0.0
    for lo, hi in zip(edges[:-1], edges[1:]):
        sel = (conf > lo) & (conf <= hi) if lo > 0 else (conf >= lo) & (conf <= hi)
        if sel.any():
            e += sel.mean() * abs(correct[sel].mean() - conf[sel].mean())
    return e

def log_softmax(logits, T):
    z = logits.astype(np.float64) / T; z = z - z.max(1, keepdims=True)
    return z - np.log(np.exp(z).sum(1, keepdims=True))

def metrics(logp, signal=None):
    P = np.exp(logp); conf = P.max(1); correct = (P.argmax(1) == y).astype(float)
    sig = conf if signal is None else signal
    return dict(accuracy=correct.mean(), ece=ece(conf, correct), brier=((P - np.eye(10)[y]) ** 2).sum(1).mean(),
                nll=-logp[np.arange(len(y)), y].mean(), auroc=roc_auc_score(correct, sig),
                confident_error_rate=(conf[correct == 0] >= 0.8).mean(), spearman_human=spearmanr(conf, human_acc).correlation,
                share_shown_as_100pct=(np.round(conf * 100) >= 100).mean(),
                auroc_on_displayed_whole_percent=roc_auc_score(correct, np.round(conf * 100)))

rows = []
for s in (0, 1, 2):
    d = np.load(os.path.join(NPZ, f"probs_seed{s}.npz")); L, T = d["logits_test"], float(d["T"])
    for name, t in (("A1 Uncalibrated softmax", 1.0), ("Proposed: Temperature scaling (T*)", T),
                    ("A3 Sharpened (T*/4, overconfident)", T / 4)):
        rows.append(dict(seed=s, method=name, **metrics(log_softmax(L, t))))
main = pd.DataFrame(rows)
agg = main.drop(columns="seed").groupby("method", sort=False).agg(["mean", "std"])
agg.columns = [f"{m}_{st}" for m, st in agg.columns]
agg.to_csv(os.path.join(OUT, "table_main_metrics_fullprecision.csv"))
print(agg.round(4).T.to_string())

d0 = np.load(os.path.join(NPZ, "probs_seed0.npz")); L0, T0 = d0["logits_test"], float(d0["T"])
dn = np.load(os.path.join(NPZ, "probs_seed0_noaug.npz")); Ln, Tn = dn["logits_test"], float(dn["T"])
abl = []
add = lambda a, v, m: abl.append(dict(ablation=a, variant=v, **m))
add("- Temperature scaling", "Uncalibrated softmax (T=1)", metrics(log_softmax(L0, 1)))
add("- Temperature scaling", "Temperature-scaled (T*)", metrics(log_softmax(L0, T0)))
for lab, t in (("T*", T0), ("T*/2", T0 / 2), ("T*/4", T0 / 4)):
    add("Degree of overconfidence", lab, metrics(log_softmax(L0, t)))
lp = log_softmax(L0, T0); P = np.exp(lp); srt = np.sort(P, 1)
add("- Information about alternatives", "Top-1 confidence", metrics(lp))
add("- Information about alternatives", "Top-1 minus top-2 margin", metrics(lp, srt[:, -1] - srt[:, -2]))
add("- Information about alternatives", "Negative entropy (all 10 classes)", metrics(lp, (P * lp).sum(1)))
add("- Data augmentation", "With augmentation (T*)", metrics(log_softmax(L0, T0)))
add("- Data augmentation", "Without augmentation (T*)", metrics(log_softmax(Ln, Tn)))
add("- Data augmentation", "With augmentation (T=1)", metrics(log_softmax(L0, 1)))
add("- Data augmentation", "Without augmentation (T=1)", metrics(log_softmax(Ln, 1)))
ABL = pd.DataFrame(abl); ABL.to_csv(os.path.join(OUT, "table_ablations_partA_fullprecision.csv"), index=False)
print(ABL.drop(columns=["share_shown_as_100pct", "auroc_on_displayed_whole_percent"]).round(4).to_string())

OI = {"blue": "#0072B2", "orange": "#E69F00", "green": "#009E73"}
plt.rcParams.update({"savefig.dpi": 200, "font.size": 10, "axes.spines.top": False, "axes.spines.right": False})
sub = ABL[ABL.ablation == "Degree of overconfidence"]
fig, axes = plt.subplots(1, 3, figsize=(11, 3.2))
for ax, col, lab in zip(axes, ["ece", "confident_error_rate", "auroc"], ["ECE", "Confident-error rate (≥80%)", "Error-detection AUROC"]):
    ax.bar(sub.variant, sub[col], color=[OI["blue"], OI["green"], OI["orange"]]); ax.set_title(lab)
    for i, v in enumerate(sub[col]): ax.text(i, v, f"{v:.3f}", ha="center", va="bottom", fontsize=8)
plt.tight_layout(); plt.savefig(os.path.join(OUT, "figures", "fig6_ablation_overconfidence_fullprecision.png"), bbox_inches="tight")
