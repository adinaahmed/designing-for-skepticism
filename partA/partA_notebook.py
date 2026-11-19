import os, sys, json, math, time, random, zipfile, shutil, urllib.request
import numpy as np
import pandas as pd
import torch
import torch.nn as nn
import torch.nn.functional as F
import torchvision
import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt
from scipy.stats import spearmanr
from sklearn.metrics import roc_auc_score, confusion_matrix

# ---- Configuration (values from the Phase 2 methodology) ----
CFG = dict(
    EPOCHS=30,               # Step 5a: 30 epochs
    LR=0.01,                 # Step 5a: SGD, learning rate 0.01 with cosine decay
    MOMENTUM=0.9,
    WEIGHT_DECAY=5e-4,
    BATCH=128,
    IMG=224,                 # Step 3a: resize 32 -> 224 for the ImageNet-pretrained network
    SEEDS=[0, 1, 2],         # Step 7: three training seeds
    SPLIT_SEED=42,           # fixed 45k/5k split, identical for all seeds
    DROPOUT_P=0.2,           # dropout before the classifier, required for the MC dropout baseline (A2)
    MC_PASSES=30,            # Step 6: MC dropout, 30 passes
    SHARPEN_DIV=4,           # Step 5a: overconfident condition uses T*/4
    ECE_BINS=15,             # Step 8: 15 confidence bins
    CONF_THRESHOLD=0.80,     # Step 8: "confident" = shown with >= 80% confidence
    N_BOOT=1000,             # Step 9: 1,000 bootstrap resamples
    STIM_SEED=2026,          # stimulus selection seed (Part B)
    STIM_PX=256,             # Step 3a: display images upscaled to 256 x 256 (bicubic)
)
SMOKE_TEST = os.environ.get("SMOKE_TEST", "0") == "1"   # used only to test the code without a GPU
if SMOKE_TEST:
    CFG.update(EPOCHS=1, IMG=32, SEEDS=[0, 1], N_BOOT=50, MC_PASSES=5, BATCH=64)

DEVICE = "cuda" if torch.cuda.is_available() else "cpu"
ON_KAGGLE = os.path.exists("/kaggle/working")
ON_COLAB = "google.colab" in sys.modules
if ON_COLAB and not SMOKE_TEST:
    # Google Colab: save everything to Google Drive so a disconnect does not lose checkpoints or results.
    from google.colab import drive
    drive.mount("/content/drive")
    WORK = "/content/drive/MyDrive/phase3_partA"
else:
    WORK = "/kaggle/working" if ON_KAGGLE else os.environ.get("WORK_DIR", "./work")
DATA_DIR = os.path.join(WORK, "data")
CKPT_DIR = os.path.join(WORK, "checkpoints")
OUT_DIR = os.path.join(WORK, "partA_outputs")
FIG_DIR = os.path.join(OUT_DIR, "figures")
for d in (DATA_DIR, CKPT_DIR, OUT_DIR, FIG_DIR):
    os.makedirs(d, exist_ok=True)

CLASSES = ["airplane", "automobile", "bird", "cat", "deer", "dog", "frog", "horse", "ship", "truck"]
CIFAR_MEAN = torch.tensor([0.4914, 0.4822, 0.4465]).view(1, 3, 1, 1)   # Step 3a: CIFAR-10 mean / std
CIFAR_STD = torch.tensor([0.2470, 0.2435, 0.2616]).view(1, 3, 1, 1)

def set_seed(s):
    random.seed(s); np.random.seed(s); torch.manual_seed(s); torch.cuda.manual_seed_all(s)

print("Device:", DEVICE, "| Kaggle:", ON_KAGGLE, "| Colab:", ON_COLAB, "| Work folder:", WORK, "| Smoke test:", SMOKE_TEST)
if DEVICE == "cpu" and not SMOKE_TEST:
    print("WARNING: no GPU found. On Kaggle: Settings -> Accelerator -> GPU T4. On Colab: Runtime -> Change runtime type -> T4 GPU.")
print("torch", torch.__version__, "torchvision", torchvision.__version__)
json.dump(CFG, open(os.path.join(OUT_DIR, "config.json"), "w"), indent=2)

# ---- Reuse a previous finished run (optional) ----
# If the output of an earlier run of this notebook is attached as a Kaggle input (Add Input -> Your Work -> this notebook),
# its saved model predictions (probs_*.npz), CIFAR-10 and CIFAR-10H files are reused: no retraining and no slow download.
# All tables and figures are then recomputed from exactly the same model outputs.
CIFAR_ROOT = DATA_DIR
def _find(name, is_dir=False):
    for base in ("/kaggle/input",):
        for root, dirs, files in os.walk(base):
            if (is_dir and name in dirs) or (not is_dir and name in files):
                return os.path.join(root, name)
    return None
REUSED_RUN = None
if ON_KAGGLE and not SMOKE_TEST:
    prev = _find("probs_seed0.npz")
    if prev:
        REUSED_RUN = os.path.dirname(prev)
        for f in os.listdir(REUSED_RUN):
            if (f.startswith("probs_") and f.endswith(".npz")) or (f.startswith("training_log_") and f.endswith(".csv")):
                shutil.copy(os.path.join(REUSED_RUN, f), OUT_DIR)
        for f in ("cifar10h-probs.npy", "cifar10h-raw.zip"):
            src = _find(f)
            if src and not os.path.exists(os.path.join(DATA_DIR, f)): shutil.copy(src, DATA_DIR)
        batches = _find("cifar-10-batches-py", is_dir=True)
        if batches: CIFAR_ROOT = os.path.dirname(batches)
print("Reusing saved model outputs from:", REUSED_RUN or "none (full training run)", "| CIFAR-10 folder:", CIFAR_ROOT)

def load_cifar10():
    if SMOKE_TEST:
        # Synthetic stand-in images used ONLY to test that the code runs (no internet / GPU here).
        # Test labels are taken from CIFAR-10H so that the human-difficulty code path is exercised.
        rng = np.random.default_rng(0)
        h_lab = cifar10h_true_labels()
        ytr = rng.integers(0, 10, 50000)
        xtr = rng.integers(0, 256, (50000, 32, 32, 3), dtype=np.uint8)
        xte = rng.integers(0, 256, (10000, 32, 32, 3), dtype=np.uint8)
        # make the task learnable: brighten one colour channel by class
        for x, y in ((xtr, ytr), (xte, h_lab)):
            x[..., 0] = np.clip(x[..., 0].astype(int) // 2 + (y[:, None, None] * 12), 0, 255)
        return xtr, ytr, xte, h_lab
    dl = CIFAR_ROOT == DATA_DIR                      # download only when no local copy was found
    tr = torchvision.datasets.CIFAR10(CIFAR_ROOT, train=True, download=dl)
    te = torchvision.datasets.CIFAR10(CIFAR_ROOT, train=False, download=dl)
    return tr.data, np.array(tr.targets), te.data, np.array(te.targets)

C10H_BASE = "https://raw.githubusercontent.com/jcpeterson/cifar-10h/master/data/"
def fetch(name):
    p = os.path.join(DATA_DIR, name)
    if not os.path.exists(p):
        urllib.request.urlretrieve(C10H_BASE + name, p)
    return p

def cifar10h_true_labels():
    raw_zip = fetch("cifar10h-raw.zip")
    with zipfile.ZipFile(raw_zip) as z:
        with z.open("cifar10h-raw.csv") as f:
            raw = pd.read_csv(f, usecols=["is_attn_check", "true_label", "cifar10_test_test_idx"])
    raw = raw[raw.is_attn_check == 0]
    return raw.groupby("cifar10_test_test_idx").true_label.first().sort_index().values

x_train_all, y_train_all, x_test, y_test = load_cifar10()
H_PROBS = np.load(fetch("cifar10h-probs.npy"))          # 10,000 x 10 human label distribution
h_labels = cifar10h_true_labels()
assert H_PROBS.shape == (10000, 10)
assert np.array_equal(h_labels, y_test), "CIFAR-10H order does not match the CIFAR-10 test set"
print("CIFAR-10:", x_train_all.shape, x_test.shape, "| CIFAR-10H:", H_PROBS.shape, "| label order verified")

rng_split = np.random.default_rng(CFG["SPLIT_SEED"])
perm = rng_split.permutation(len(x_train_all))
idx_val, idx_tr = perm[:5000], perm[5000:]
x_tr, y_tr = x_train_all[idx_tr], y_train_all[idx_tr]
x_val, y_val = x_train_all[idx_val], y_train_all[idx_val]
np.save(os.path.join(OUT_DIR, "split_val_indices.npy"), idx_val)
print("train", len(x_tr), "| val", len(x_val), "| test", len(x_test))

def to_tensor_u8(x):                       # N,32,32,3 uint8 -> N,3,32,32 uint8 tensor
    return torch.from_numpy(x).permute(0, 3, 1, 2).contiguous()

X_TR, X_VAL, X_TE = to_tensor_u8(x_tr), to_tensor_u8(x_val), to_tensor_u8(x_test)
Y_TR, Y_VAL, Y_TE = torch.from_numpy(y_tr).long(), torch.from_numpy(y_val).long(), torch.from_numpy(y_test).long()
MEAN, STD = CIFAR_MEAN.to(DEVICE), CIFAR_STD.to(DEVICE)

def prep(xb_u8, train, augment=True):
    """uint8 batch on device -> normalised float batch at CFG['IMG'] resolution."""
    x = xb_u8.float() / 255.0
    if train and augment:
        n = x.shape[0]
        x = F.pad(x, (4, 4, 4, 4), mode="constant", value=0.0)          # random crop with padding 4
        i = torch.randint(0, 9, (n,), device=x.device); j = torch.randint(0, 9, (n,), device=x.device)
        rows = (i.view(n, 1) + torch.arange(32, device=x.device).view(1, 32))
        cols = (j.view(n, 1) + torch.arange(32, device=x.device).view(1, 32))
        x = x[torch.arange(n, device=x.device).view(n, 1, 1, 1), torch.arange(3, device=x.device).view(1, 3, 1, 1),
              rows.view(n, 1, 32, 1), cols.view(n, 1, 1, 32)]
        flip = torch.rand(n, device=x.device) < 0.5                         # horizontal flip
        x[flip] = x[flip].flip(-1)
    x = (x - MEAN) / STD                                                     # per-channel normalisation
    if CFG["IMG"] != 32:
        x = F.interpolate(x, size=CFG["IMG"], mode="bilinear", align_corners=False)
    return x

# Human difficulty (CIFAR-10H)
human_acc = H_PROBS[np.arange(10000), y_test]
human_ent = -(H_PROBS * np.log(np.clip(H_PROBS, 1e-12, 1))).sum(1)
ENT_MEDIAN = float(np.median(human_ent))
human_hard = human_ent > ENT_MEDIAN
print(f"Human accuracy: mean {human_acc.mean():.3f}, median {np.median(human_acc):.3f}")
print(f"Entropy median (easy/hard cut-off) = {ENT_MEDIAN:.4f}; hard images = {human_hard.mean():.1%}")
pd.DataFrame(dict(test_idx=np.arange(10000), true_label=y_test, human_acc=human_acc,
                  human_entropy=human_ent, human_hard=human_hard.astype(int))
             ).to_csv(os.path.join(OUT_DIR, "cifar10h_difficulty.csv"), index=False)

def make_model():
    if SMOKE_TEST:
        m = torchvision.models.resnet18(weights=None)
    else:
        m = torchvision.models.resnet18(weights=torchvision.models.ResNet18_Weights.IMAGENET1K_V1)
    m.fc = nn.Sequential(nn.Dropout(CFG["DROPOUT_P"]), nn.Linear(512, 10))
    return m.to(DEVICE)

def batches(n, bs, shuffle, gen=None):
    order = torch.randperm(n, generator=gen) if shuffle else torch.arange(n)
    for k in range(0, n, bs):
        yield order[k:k + bs]

def train_model(seed, augment=True, tag=None):
    tag = tag or f"seed{seed}" + ("" if augment else "_noaug")
    final = os.path.join(CKPT_DIR, f"{tag}_final.pt")
    if os.path.exists(final):
        print(f"[{tag}] found trained model, loading"); m = make_model()
        m.load_state_dict(torch.load(final, map_location=DEVICE)); return m
    set_seed(seed)
    m = make_model()
    opt = torch.optim.SGD(m.parameters(), lr=CFG["LR"], momentum=CFG["MOMENTUM"],
                          weight_decay=CFG["WEIGHT_DECAY"], nesterov=False)
    sched = torch.optim.lr_scheduler.CosineAnnealingLR(opt, T_max=CFG["EPOCHS"])
    scaler = torch.amp.GradScaler("cuda", enabled=(DEVICE == "cuda"))
    start, log = 0, []
    ck = os.path.join(CKPT_DIR, f"{tag}_last.pt")
    if os.path.exists(ck):                                              # resume after a session ends
        st = torch.load(ck, map_location=DEVICE)
        m.load_state_dict(st["model"]); opt.load_state_dict(st["opt"]); sched.load_state_dict(st["sched"])
        scaler.load_state_dict(st["scaler"]); start, log = st["epoch"] + 1, st["log"]
        print(f"[{tag}] resuming from epoch {start}")
    xtr, ytr = X_TR.to(DEVICE), Y_TR.to(DEVICE)
    gen = torch.Generator().manual_seed(seed)
    for _ in range(start):
        torch.randperm(len(xtr), generator=gen)                          # keep shuffling identical on resume
    for ep in range(start, CFG["EPOCHS"]):
        m.train(); t0 = time.time(); tot, correct, loss_sum = 0, 0, 0.0
        for b in batches(len(xtr), CFG["BATCH"], True, gen):
            b = b.to(DEVICE)
            xb, yb = prep(xtr[b], train=True, augment=augment), ytr[b]
            with torch.autocast(device_type="cuda", dtype=torch.float16, enabled=(DEVICE == "cuda")):
                out = m(xb); loss = F.cross_entropy(out, yb)
            opt.zero_grad(set_to_none=True)
            scaler.scale(loss).backward(); scaler.step(opt); scaler.update()
            tot += len(b); correct += (out.argmax(1) == yb).sum().item(); loss_sum += loss.item() * len(b)
            if SMOKE_TEST and tot >= int(os.environ.get("SMOKE_IMGS", "2048")): break
        sched.step()
        val_acc = (logits_of(m, X_VAL[:1000] if SMOKE_TEST else X_VAL).argmax(1).numpy() ==
                   (y_val[:1000] if SMOKE_TEST else y_val)).mean()
        log.append(dict(epoch=ep + 1, train_loss=loss_sum / tot, train_acc=correct / tot, val_acc=float(val_acc),
                        lr=sched.get_last_lr()[0], seconds=time.time() - t0))
        print(f"[{tag}] epoch {ep+1}/{CFG['EPOCHS']} loss {loss_sum/tot:.4f} train_acc {correct/tot:.4f} "
              f"val_acc {val_acc:.4f} ({time.time()-t0:.0f}s)")
        torch.save(dict(model=m.state_dict(), opt=opt.state_dict(), sched=sched.state_dict(),
                        scaler=scaler.state_dict(), epoch=ep, log=log), ck)
    torch.save(m.state_dict(), final)
    pd.DataFrame(log).to_csv(os.path.join(OUT_DIR, f"training_log_{tag}.csv"), index=False)
    return m

@torch.no_grad()
def features_of(m, X, bs=500):
    """512-d penultimate features (model in eval mode)."""
    m.eval(); out = []
    body = nn.Sequential(*list(m.children())[:-1])
    for k in range(0, len(X), bs):
        xb = prep(X[k:k + bs].to(DEVICE), train=False)
        with torch.autocast(device_type="cuda", dtype=torch.float16, enabled=(DEVICE == "cuda")):
            out.append(torch.flatten(body(xb), 1).float().cpu())
    return torch.cat(out)

@torch.no_grad()
def logits_of(m, X):
    f = features_of(m, X)
    return m.fc[1](f.to(DEVICE)).float().cpu()           # dropout is inactive in eval mode

@torch.no_grad()
def mc_dropout_probs(m, feats, passes, seed=0):
    """MC dropout: dropout kept active at test time, softmax averaged over passes.
    Dropout sits directly before the last linear layer, so applying it to the (fixed) features is
    exactly equivalent to running the full network `passes` times, but much faster."""
    g = torch.Generator(device="cpu").manual_seed(seed)
    lin = m.fc[1].cpu(); p = CFG["DROPOUT_P"]; acc = torch.zeros(len(feats), 10)
    for _ in range(passes):
        mask = (torch.rand(feats.shape, generator=g) > p).float() / (1 - p)
        acc += F.softmax(lin(feats * mask), 1)
    m.fc[1].to(DEVICE)
    return (acc / passes).numpy()

def fit_temperature(logits_val, y):
    logT = torch.zeros(1, requires_grad=True)
    opt = torch.optim.LBFGS([logT], lr=0.1, max_iter=200)
    yv = torch.as_tensor(y)
    def closure():
        opt.zero_grad(); loss = F.cross_entropy(logits_val / logT.exp(), yv); loss.backward(); return loss
    opt.step(closure)
    return float(logT.exp())

def softmax_T(logits, T):
    # double precision: in float32 many sharpened confidences round to exactly 1.0, which creates ties in AUROC
    return F.softmax(torch.as_tensor(logits, dtype=torch.float64) / T, 1).numpy()

def run_seed(seed, augment=True):
    tag = f"seed{seed}" + ("" if augment else "_noaug")
    cache = os.path.join(OUT_DIR, f"probs_{tag}.npz")
    if os.path.exists(cache):
        z = np.load(cache, allow_pickle=True); return {k: z[k] for k in z.files}
    m = train_model(seed, augment=augment)
    f_val, f_te = features_of(m, X_VAL), features_of(m, X_TE)
    with torch.no_grad():
        lv = m.fc[1](f_val.to(DEVICE)).float().cpu(); lt = m.fc[1](f_te.to(DEVICE)).float().cpu()
    T = fit_temperature(lv, y_val)
    res = dict(seed=seed, T=T, logits_val=lv.numpy(), logits_test=lt.numpy(), feats_test=f_te.numpy(),
               p_softmax=softmax_T(lt, 1.0), p_ts=softmax_T(lt, T), p_sharp=softmax_T(lt, T / CFG["SHARPEN_DIV"]),
               p_mc=mc_dropout_probs(m, f_te, CFG["MC_PASSES"], seed),
               p_mc1=mc_dropout_probs(m, f_te, 1, seed + 100),
               p_val_ts=softmax_T(lv, T))
    for half, name in ((2, "p_sharp2"),):                                # ablation: T*/2
        res[name] = softmax_T(lt, T / half)
    np.savez_compressed(cache, **res)
    print(f"[{tag}] fitted temperature T* = {T:.3f}")
    return res

RUNS = {s: run_seed(s) for s in CFG["SEEDS"]}
RUN_NOAUG = run_seed(CFG["SEEDS"][0], augment=False)                     # ablation: no augmentation
R0 = RUNS[CFG["SEEDS"][0]]                                               # seed-0 model drives figures & stimuli

def ece(conf, correct, bins=CFG["ECE_BINS"]):
    edges = np.linspace(0, 1, bins + 1); e = 0.0
    for lo, hi in zip(edges[:-1], edges[1:]):
        sel = (conf > lo) & (conf <= hi) if lo > 0 else (conf >= lo) & (conf <= hi)
        if sel.any():
            e += sel.mean() * abs(correct[sel].mean() - conf[sel].mean())
    return e

def metrics(P, y, idx=None, signal=None):
    if idx is not None:
        P, y = P[idx], y[idx]
    pred = P.argmax(1); conf = P.max(1); correct = (pred == y).astype(float)
    onehot = np.eye(10)[y]
    sig = conf if signal is None else (signal if idx is None else signal[idx])
    errs = correct == 0
    return dict(
        accuracy=correct.mean(),
        ece=ece(conf, correct),
        brier=((P - onehot) ** 2).sum(1).mean(),
        nll=-np.log(np.clip(P[np.arange(len(y)), y], 1e-12, 1)).mean(),
        auroc=roc_auc_score(correct, sig) if 0 < correct.sum() < len(correct) else np.nan,
        confident_error_rate=(conf[errs] >= CFG["CONF_THRESHOLD"]).mean() if errs.any() else np.nan,
        spearman_human=spearmanr(conf, human_acc if idx is None else human_acc[idx]).correlation,
    )

METHODS = [("A1 Uncalibrated softmax", "p_softmax"), ("Proposed: Temperature scaling (T*)", "p_ts"),
           ("A3 Sharpened (T*/4, overconfident)", "p_sharp"), ("A2 MC dropout (30 passes)", "p_mc")]

def bootstrap(P, y, n=CFG["N_BOOT"], seed=0):
    rng = np.random.default_rng(seed); rows = []
    for _ in range(n):
        rows.append(metrics(P, y, rng.integers(0, len(y), len(y))))
    return pd.DataFrame(rows)

rows = []
for name, key in METHODS:
    per_seed = pd.DataFrame([metrics(RUNS[s][key], y_test) for s in CFG["SEEDS"]])
    boot = bootstrap(R0[key], y_test)
    point = metrics(R0[key], y_test)
    for metric in point:
        rows.append(dict(method=name, metric=metric, seed0=point[metric],
                         ci_low=boot[metric].quantile(0.025), ci_high=boot[metric].quantile(0.975),
                         mean_over_seeds=per_seed[metric].mean(), sd_over_seeds=per_seed[metric].std(ddof=1)))
MAIN = pd.DataFrame(rows)
MAIN.to_csv(os.path.join(OUT_DIR, "table_main_metrics.csv"), index=False)
wide = MAIN.pivot(index="method", columns="metric", values="mean_over_seeds").loc[[m for m, _ in METHODS]]
print("Fitted temperatures:", {s: round(float(RUNS[s]['T']), 3) for s in CFG["SEEDS"]})
print(wide.round(4).to_string())

OI = {"blue": "#0072B2", "orange": "#E69F00", "green": "#009E73", "red": "#D55E00", "grey": "#666666"}
plt.rcParams.update({"figure.dpi": 130, "savefig.dpi": 200, "font.size": 10, "axes.spines.top": False,
                     "axes.spines.right": False})

def savefig(name):
    plt.tight_layout(); plt.savefig(os.path.join(FIG_DIR, name), bbox_inches="tight"); plt.close()

# 7.1 Reliability diagrams
fig, axes = plt.subplots(1, 4, figsize=(15, 3.8), sharey=True)
edges = np.linspace(0, 1, CFG["ECE_BINS"] + 1)
for ax, (name, key) in zip(axes, METHODS):
    P = R0[key]; conf = P.max(1); corr = (P.argmax(1) == y_test)
    accs, confs, counts = [], [], []
    for lo, hi in zip(edges[:-1], edges[1:]):
        sel = (conf > lo) & (conf <= hi)
        counts.append(sel.sum()); accs.append(corr[sel].mean() if sel.any() else np.nan)
        confs.append(conf[sel].mean() if sel.any() else np.nan)
    mids = (edges[:-1] + edges[1:]) / 2
    ax.bar(mids, accs, width=1 / CFG["ECE_BINS"] * 0.9, color=OI["blue"], label="Accuracy in bin")
    ax.plot([0, 1], [0, 1], "--", color=OI["grey"], lw=1, label="Perfect calibration")
    ax.set_title(f"{name}\nECE = {ece(conf, corr.astype(float)):.3f}", fontsize=9)
    ax.set_xlabel("Confidence"); ax.set_xlim(0, 1); ax.set_ylim(0, 1)
axes[0].set_ylabel("Accuracy"); axes[0].legend(fontsize=7, loc="upper left")
savefig("fig1_reliability_diagrams.png")

# 7.2 Confidence histograms: correct vs wrong
fig, axes = plt.subplots(1, 4, figsize=(15, 3.5), sharey=False)
for ax, (name, key) in zip(axes, METHODS):
    P = R0[key]; conf = P.max(1); corr = P.argmax(1) == y_test
    b = np.linspace(0, 1, 26)
    ax.hist(conf[corr], bins=b, density=True, alpha=0.65, color=OI["blue"], label="Correct")
    ax.hist(conf[~corr], bins=b, density=True, alpha=0.65, color=OI["orange"], label="Wrong")
    ax.axvline(CFG["CONF_THRESHOLD"], color=OI["grey"], ls=":", lw=1)
    ax.set_title(name, fontsize=9); ax.set_xlabel("Confidence")
axes[0].set_ylabel("Density"); axes[0].legend(fontsize=8)
savefig("fig2_confidence_histograms.png")

# 7.3 Model confidence vs human difficulty (CIFAR-10H)
fig, axes = plt.subplots(1, 2, figsize=(10, 3.8))
bins_h = np.quantile(human_acc, np.linspace(0, 1, 11)); bins_h[-1] += 1e-9
grp = np.clip(np.digitize(human_acc, np.unique(bins_h)) - 1, 0, None)
for name, key, col in (("Calibrated (T*)", "p_ts", OI["blue"]), ("Overconfident (T*/4)", "p_sharp", OI["orange"])):
    conf = R0[key].max(1)
    xs = [human_acc[grp == g].mean() for g in np.unique(grp)]; ys = [conf[grp == g].mean() for g in np.unique(grp)]
    axes[0].plot(xs, ys, "o-", color=col, label=name)
axes[0].set_xlabel("Human accuracy on the image (CIFAR-10H)"); axes[0].set_ylabel("Mean model confidence")
axes[0].set_title("Model confidence vs human difficulty"); axes[0].legend(fontsize=8)
pred0 = R0["p_ts"].argmax(1); err0 = pred0 != y_test
tab = pd.crosstab(pd.Series(np.where(human_hard, "Hard for humans", "Easy for humans")),
                  pd.Series(np.where(err0, "AI wrong", "AI right")), normalize="index")
tab.plot(kind="barh", stacked=True, ax=axes[1], color=[OI["blue"], OI["orange"]])
axes[1].set_xlabel("Share of images"); axes[1].set_ylabel(""); axes[1].set_title("AI errors by human difficulty"); axes[1].legend(fontsize=8)
savefig("fig3_confidence_vs_human_difficulty.png")

# 7.4 Training curves
fig, ax = plt.subplots(figsize=(6, 3.5))
for s in CFG["SEEDS"]:
    p = os.path.join(OUT_DIR, f"training_log_seed{s}.csv")
    if os.path.exists(p):
        lg = pd.read_csv(p); ax.plot(lg.epoch, lg.val_acc, label=f"seed {s} (val acc)")
ax.set_xlabel("Epoch"); ax.set_ylabel("Validation accuracy"); ax.legend(fontsize=8)
savefig("fig4_training_curves.png")

# 7.5 Confusion matrix (seed 0)
cm = confusion_matrix(y_test, pred0, labels=range(10))
fig, ax = plt.subplots(figsize=(6.2, 5.4))
im = ax.imshow(cm, cmap="Blues")
ax.set_xticks(range(10)); ax.set_yticks(range(10))
ax.set_xticklabels(CLASSES, rotation=45, ha="right"); ax.set_yticklabels(CLASSES)
for i in range(10):
    for j in range(10):
        ax.text(j, i, cm[i, j], ha="center", va="center", fontsize=7, color="white" if cm[i, j] > cm.max() / 2 else "black")
ax.set_xlabel("Predicted"); ax.set_ylabel("True"); ax.set_title("Confusion matrix (test set, seed 0)")
plt.colorbar(im, fraction=0.046)
savefig("fig5_confusion_matrix.png")
print("Figures saved to", FIG_DIR)

abl = []
def add(ablation, variant, m):
    abl.append(dict(ablation=ablation, variant=variant, **m))
add("- Temperature scaling", "Uncalibrated softmax (T=1)", metrics(R0["p_softmax"], y_test))
add("- Temperature scaling", "Temperature-scaled (T*)", metrics(R0["p_ts"], y_test))
for lab, key in (("T*", "p_ts"), ("T*/2", "p_sharp2"), ("T*/4", "p_sharp")):
    add("Degree of overconfidence", lab, metrics(R0[key], y_test))
P = R0["p_ts"]; srt = np.sort(P, 1)
margin = srt[:, -1] - srt[:, -2]; neg_entropy = (P * np.log(np.clip(P, 1e-12, 1))).sum(1)
add("- Information about alternatives", "Top-1 confidence", metrics(P, y_test))
add("- Information about alternatives", "Top-1 minus top-2 margin", metrics(P, y_test, signal=margin))
add("- Information about alternatives", "Negative entropy (all 10 classes)", metrics(P, y_test, signal=neg_entropy))
add("- MC dropout", "Single stochastic pass", metrics(R0["p_mc1"], y_test))
add("- MC dropout", "30-pass MC dropout", metrics(R0["p_mc"], y_test))
add("- Data augmentation", "With augmentation (T*)", metrics(R0["p_ts"], y_test))
add("- Data augmentation", "Without augmentation (T*)", metrics(RUN_NOAUG["p_ts"], y_test))
add("- Data augmentation", "With augmentation (T=1)", metrics(R0["p_softmax"], y_test))
add("- Data augmentation", "Without augmentation (T=1)", metrics(RUN_NOAUG["p_softmax"], y_test))
ABL = pd.DataFrame(abl)
ABL.to_csv(os.path.join(OUT_DIR, "table_ablations_partA.csv"), index=False)
print(ABL.round(4).to_string())

# Ablation figure: degree of overconfidence
sub = ABL[ABL.ablation == "Degree of overconfidence"]
fig, axes = plt.subplots(1, 3, figsize=(11, 3.2))
for ax, col, lab in zip(axes, ["ece", "confident_error_rate", "auroc"], ["ECE", "Confident-error rate (≥80%)", "Error-detection AUROC"]):
    ax.bar(sub.variant, sub[col], color=[OI["blue"], OI["green"], OI["orange"]]); ax.set_title(lab)
    for i, v in enumerate(sub[col]): ax.text(i, v, f"{v:.3f}", ha="center", va="bottom", fontsize=8)
savefig("fig6_ablation_overconfidence.png")

conf_ts, conf_sh = R0["p_ts"].max(1), R0["p_sharp"].max(1)
wrong = np.where(err0)[0]
top_wrong = wrong[np.argsort(-conf_ts[wrong])][:24]
fig, axes = plt.subplots(4, 6, figsize=(12, 9))
for ax, i in zip(axes.ravel(), top_wrong):
    ax.imshow(x_test[i]); ax.axis("off")
    ax.set_title(f"true: {CLASSES[y_test[i]]}\nAI: {CLASSES[pred0[i]]}\n{conf_ts[i]:.0%} cal | {conf_sh[i]:.0%} over\n"
                 f"humans {human_acc[i]:.0%} right", fontsize=7)
plt.suptitle("Highest-confidence AI errors (seed 0)", fontsize=11)
savefig("fig7_confident_errors_grid.png")

pairs = pd.Series([f"{CLASSES[y_test[i]]} -> {CLASSES[pred0[i]]}" for i in wrong]).value_counts()
pairs.rename("n_errors").to_csv(os.path.join(OUT_DIR, "table_confusion_pairs.csv"))
print("Most frequent confusion pairs:\n", pairs.head(10).to_string())

model_hard = conf_ts < np.median(conf_ts)
xt = pd.crosstab(pd.Series(np.where(model_hard, "hard for model", "easy for model"), name="model"),
                 pd.Series(np.where(human_hard, "hard for humans", "easy for humans"), name="humans"))
xt.to_csv(os.path.join(OUT_DIR, "table_model_vs_human_difficulty.csv"))
err_tab = pd.crosstab(pd.Series(np.where(err0, "AI wrong", "AI right"), name="AI"),
                      pd.Series(np.where(human_hard, "hard for humans", "easy for humans"), name="humans"))
err_tab.to_csv(os.path.join(OUT_DIR, "table_ai_errors_by_human_difficulty.csv"))
print(xt, "\n", err_tab)
# AI errors that humans find easy to spot and hard to spot, with high model confidence
risky = wrong[(conf_ts[wrong] >= CFG["CONF_THRESHOLD"]) & human_hard[wrong]]
pd.DataFrame(dict(test_idx=risky, true=[CLASSES[y_test[i]] for i in risky], ai=[CLASSES[pred0[i]] for i in risky],
                  conf_calibrated=conf_ts[risky], conf_overconfident=conf_sh[risky], human_acc=human_acc[risky])
             ).sort_values("conf_calibrated", ascending=False).to_csv(
    os.path.join(OUT_DIR, "table_confident_errors_hard_for_humans.csv"), index=False)
print(f"Confident (>=80%, calibrated) AI errors on images hard for humans: {len(risky)}")

def brightness(x): return x.reshape(len(x), -1).mean(1) / 255.0
def sharpness(x):
    g = x.astype(float).mean(-1)
    lap = (g[:, :-2, 1:-1] + g[:, 2:, 1:-1] + g[:, 1:-1, :-2] + g[:, 1:-1, 2:] - 4 * g[:, 1:-1, 1:-1])
    return lap.reshape(len(x), -1).var(1)

pv = R0["p_val_ts"]; pred_v = pv.argmax(1); err_v = pred_v != y_val; base = err_v.mean()
b_val, s_val = brightness(x_val), sharpness(x_val)
b_cut, s_cut = np.quantile(b_val, 0.25), np.quantile(s_val, 0.25)
cands = []
# Rules are defined from the user's point of view: the user sees the AI's answer, not the true class.
for c in range(10):
    sel = pred_v == c                                   # "when the AI answers c, it is often wrong"
    cands.append(dict(rule=f"class:{CLASSES[c]}", text=f"When the AI answers \u201c{CLASSES[c]}\u201d", sel_val=sel,
                      e=err_v[sel].mean() if sel.any() else 0.0))
for a in range(10):
    for b in range(a + 1, 10):
        sel = np.isin(pred_v, [a, b])                    # AI answers a or b ...
        mix = sel & np.isin(y_val, [a, b]) & err_v       # ... but the picture is the other one of the pair
        cands.append(dict(rule=f"pair:{CLASSES[a]}|{CLASSES[b]}", text=f"Telling a {CLASSES[a]} from a {CLASSES[b]}",
                          sel_val=sel, e=mix.sum() / max(1, sel.sum())))
for name, txt, sel in (("cond:dark", "Dark images", b_val <= b_cut), ("cond:blurry", "Blurry or low-detail images", s_val <= s_cut)):
    cands.append(dict(rule=name, text=txt, sel_val=sel, e=err_v[sel].mean()))
profile = [dict(rule=cd["rule"], guidance_text=cd["text"], val_error_rate=cd["e"], val_share=cd["sel_val"].mean(),
                ratio_to_overall=cd["e"] / base if base > 0 else np.nan) for cd in cands]
PROFILE = pd.DataFrame(profile).sort_values("ratio_to_overall", ascending=False)
PROFILE.to_csv(os.path.join(OUT_DIR, "table_capability_profile_validation.csv"), index=False)
def dedup(df):   # keep each confusion pair only once (a->b and b->a: keep the stronger direction)
    df = df.copy()
    df["key"] = df.rule.apply(lambda r: "pair:" + "|".join(sorted(r[5:].split("|"))) if r.startswith("pair:") else r)
    return df.drop_duplicates("key").drop(columns="key")
RULES = dedup(PROFILE[(PROFILE.ratio_to_overall >= 2) & (PROFILE.val_share >= 0.01)]).head(6)
RULE_CRITERION = "error rate >= 2x overall validation error rate (max 6 rules)"
if len(RULES) < 3:   # fallback so that V5 always names at least 3 known weaknesses
    RULES = dedup(PROFILE[(PROFILE.ratio_to_overall > 1) & (PROFILE.val_share >= 0.01)]).head(3)
    RULE_CRITERION = "fewer than 3 weaknesses reached 2x; used the 3 weaknesses with the highest above-average error rate"
print("Rule criterion used:", RULE_CRITERION)
print(f"Overall validation error rate: {base:.3%}. Guidance rules:\n", RULES[["rule", "guidance_text", "val_error_rate", "ratio_to_overall"]])

b_te, s_te = brightness(x_test), sharpness(x_test)
# A rule "covers" a test image if it falls in the flagged situation as the user sees it (AI's shown answer, image condition).
def covers(rule, pred, bright, sharp):
    kind, val = rule.split(":", 1)
    if kind == "class": return pred == CLASSES.index(val)
    if kind == "pair": return np.isin(pred, [CLASSES.index(v) for v in val.split("|")])
    return bright <= b_cut if val == "dark" else sharp <= s_cut
rule_list = list(RULES.rule)
hit = {r: covers(r, pred0, b_te, s_te) for r in rule_list}
any_hit = np.zeros(10000, bool)
for r in rule_list: any_hit |= hit[r]
cov = [dict(variant="All rules", share_of_test_errors_flagged=any_hit[err0].mean(),
            share_of_correct_flagged=any_hit[~err0].mean())]
for r in rule_list:
    others = np.zeros(10000, bool)
    for q in rule_list:
        if q != r: others |= hit[q]
    cov.append(dict(variant=f"without {r}", share_of_test_errors_flagged=others[err0].mean(),
                    share_of_correct_flagged=others[~err0].mean()))
COV = pd.DataFrame(cov); COV.to_csv(os.path.join(OUT_DIR, "table_guidance_coverage.csv"), index=False)
print(COV.round(3).to_string())

from PIL import Image
rs = np.random.default_rng(CFG["STIM_SEED"])
correct_mask = ~err0
pools = {("correct", "easy"): np.where(correct_mask & ~human_hard)[0], ("correct", "hard"): np.where(correct_mask & human_hard)[0],
         ("error", "easy"): np.where(err0 & ~human_hard & (conf_sh >= CFG["CONF_THRESHOLD"]))[0],
         ("error", "hard"): np.where(err0 & human_hard & (conf_sh >= CFG["CONF_THRESHOLD"]))[0]}
need = {("correct", "easy"): 4, ("correct", "hard"): 4, ("error", "easy"): 1, ("error", "hard"): 1}
for k, v in pools.items():
    print(f"pool {k}: {len(v)} candidates (need {need[k] * 5})")
    assert len(v) >= need[k] * 5, f"Not enough candidates for {k}; see methodology Step 5a (adjust using validation data)"
used = set(); sets = []
def pick(pool, n, classes_in_set=None):
    """Random pick without re-using images; within a set, prefer true classes not used yet (class balance)."""
    out = []
    cand = [int(i) for i in rs.permutation(pool) if int(i) not in used]
    cs = classes_in_set if classes_in_set is not None else set()
    for prefer_new in (True, False):
        for i in cand:
            if len(out) == n: break
            if i in out or (prefer_new and y_test[i] in cs): continue
            out.append(i); cs.add(y_test[i])
    for i in out: used.add(i)
    return out
# Representative sampling (documented Phase 3 refinement of Step 2): within each of the four trial types, the share of
# trials that fall under the V5 guidance matches the share observed for that kind of AI answer on the full 10,000-image
# test set (correct and wrong answers separately). Without this, a random draw of only 10 errors can leave the guidance
# almost never applicable, or make "the guidance applies" an artificial clue that the AI is wrong.
cov_err, cov_cor = any_hit[err0].mean(), any_hit[~err0].mean()
n_cov = {("error", "easy"): int(round(cov_err * 5)), ("error", "hard"): int(round(cov_err * 5)),
         ("correct", "easy"): int(round(cov_cor * 20)), ("correct", "hard"): int(round(cov_cor * 20))}
print(f"Guidance applies to {cov_err:.1%} of test-set AI errors and {cov_cor:.1%} of correct answers ->",
      {f"{k[0]}/{k[1]}": f"{v} of {need[k] * 5}" for k, v in n_cov.items()})
# which slots (set, type) receive a guidance-covered image: spread across the five sets
cov_slots, per_set = {}, np.zeros(5, int)
for k, n in sorted(n_cov.items(), key=lambda kv: -kv[1]):           # spread covered trials evenly over the 5 sets
    used_j = np.zeros(5, int)
    for _ in range(n):
        s = min((x for x in range(5) if used_j[x] < need[k]), key=lambda x: (per_set[x], used_j[x], x))
        cov_slots[(s, k, int(used_j[s]))] = True; used_j[s] += 1; per_set[s] += 1
sub = {k: {"cov": np.array([i for i in pools[k] if any_hit[i]]), "unc": np.array([i for i in pools[k] if not any_hit[i]])}
       for k in pools}
for k in pools:
    nc = n_cov[k]; nu = need[k] * 5 - nc
    print(f"pool {k}: covered {len(sub[k]['cov'])} (need {nc}), not covered {len(sub[k]['unc'])} (need {nu})")
    if SMOKE_TEST and (len(sub[k]["cov"]) < nc or len(sub[k]["unc"]) < nu):   # code test with random images only
        sub[k] = {"cov": pools[k], "unc": pools[k]}
    assert len(sub[k]["cov"]) >= nc and len(sub[k]["unc"]) >= nu, f"Not enough candidates for {k}"
for s in range(5):
    items, cls = [], set()
    for (cor, dif), n in need.items():
        for j in range(n):
            part = "cov" if cov_slots.get((s, (cor, dif), j)) else "unc"
            for i in pick(sub[(cor, dif)][part], 1, cls):
                items.append((i, cor, dif))
    sets.append(items)
practice = pick(pools[("correct", "easy")], 3)

STIM_DIR = os.path.join(OUT_DIR, "partB_stimuli"); IMG_DIR = os.path.join(STIM_DIR, "img")
os.makedirs(IMG_DIR, exist_ok=True)
def top3(P):
    o = np.argsort(-P)[:3]; return [dict(label=CLASSES[k], p=round(float(P[k]), 4)) for k in o]
def stim_record(i, cor, dif, set_id):
    fn = f"img/test_{i:05d}.png"
    Image.fromarray(x_test[i]).resize((CFG["STIM_PX"], CFG["STIM_PX"]), Image.BICUBIC).save(os.path.join(STIM_DIR, fn))
    return dict(test_idx=int(i), set=set_id, file=fn, true_label=CLASSES[y_test[i]], ai_label=CLASSES[pred0[i]],
                ai_correct=cor == "correct", difficulty=dif, human_acc=round(float(human_acc[i]), 4),
                human_entropy=round(float(human_ent[i]), 4),
                calibrated=dict(conf=round(float(conf_ts[i]), 4), top3=top3(R0["p_ts"][i])),
                overconfident=dict(conf=round(float(conf_sh[i]), 4), top3=top3(R0["p_sharp"][i])),
                guidance_rules_matched=[r for r in rule_list if hit[r][i]])
stimuli = [stim_record(i, c, d, s) for s, items in enumerate(sets) for (i, c, d) in items]
practice_recs = [stim_record(i, "correct", "easy", -1) for i in practice]
guidance = dict(model_name="ResNet-18 (CIFAR-10, seed 0)", temperature=float(R0["T"]), rule_criterion=RULE_CRITERION,
                sharpen_divisor=CFG["SHARPEN_DIV"], overall_val_error_rate=float(base),
                rules=[dict(rule=r.rule, text=r.guidance_text, val_error_rate=round(float(r.val_error_rate), 4))
                       for r in RULES.itertuples()])
pack = dict(classes=CLASSES, trials=stimuli, practice=practice_recs, guidance=guidance,
            note="Generated by partA_notebook; seed-0 model; CIFAR-10 test images; guidance coverage matched to the test set.",
            selection=dict(guidance_coverage_test_errors=round(float(cov_err), 4), guidance_coverage_test_correct=round(float(cov_cor), 4),
                           covered_trials={f"{k[0]}/{k[1]}": v for k, v in n_cov.items()}),
            smoke_test=SMOKE_TEST)
json.dump(pack, open(os.path.join(STIM_DIR, "stimuli.json"), "w"), indent=1)
with open(os.path.join(STIM_DIR, "stimuli.js"), "w") as f:            # loadable from a local file:// page
    f.write("window.STIMULI = " + json.dumps(pack) + ";\n")
sdf = pd.json_normalize(stimuli)
sdf.to_csv(os.path.join(OUT_DIR, "table_partB_stimuli.csv"), index=False)
print(sdf.groupby(["set", "ai_correct", "difficulty"]).size().unstack().fillna(0))
print("Guidance-covered trials per type:\n", sdf.assign(guided=sdf.guidance_rules_matched.map(len) > 0).groupby(["ai_correct", "difficulty"])["guided"].sum())
print("Observed confidence of the 10 error stimuli:\n",
      sdf[~sdf.ai_correct][["set", "difficulty", "calibrated.conf", "overconfident.conf"]].to_string(index=False))

# Paper 4 (Hao et al., 2026, Scientific Reports): CIFAR-10 accuracies read from Figure 12 ("Accuracy comparison across
# methods"). These are model classification accuracies reported in the paper's figure, not results of its human-participant
# experiment, and they come from different models and training set-ups than ours (see the limitations column).
P4_SRC = "Hao et al. (2026), Scientific Reports, Figure 12 (accuracy comparison across methods)"
P4_NOTE = "Model classification accuracy read from the paper's figure; not a human-participant result; different model and training set-up"
PAPER4_FIG12 = [("Proposed method (XAI + ESN)", 0.925), ("Standalone Grad-CAM", 0.910), ("Attention mechanisms", 0.902),
                ("Baseline CNN", 0.893), ("SHAP", 0.881), ("LIME", 0.876)]
acc_mean = MAIN[(MAIN.method == "Proposed: Temperature scaling (T*)") & (MAIN.metric == "accuracy")]
comp = pd.DataFrame(
    [dict(study="This study", method="ResNet-18, ImageNet-pretrained, 224 px, 30 epochs (3 seeds)", dataset="CIFAR-10 test (10,000)",
          accuracy=float(acc_mean.mean_over_seeds.iloc[0]), accuracy_sd=float(acc_mean.sd_over_seeds.iloc[0]),
          source="This notebook (table_main_metrics.csv)", note="Mean over 3 seeds; temperature scaling does not change accuracy")] +
    [dict(study="Phase 2 Paper 4 (Hao et al., 2026)", method=m, dataset="CIFAR-10", accuracy=a, accuracy_sd=None, source=P4_SRC, note=P4_NOTE)
     for m, a in PAPER4_FIG12])
comp.to_csv(os.path.join(OUT_DIR, "table_comparison_paper4.csv"), index=False)
print(comp.to_string(index=False))

summary = dict(temperatures={str(s): float(RUNS[s]["T"]) for s in CFG["SEEDS"]},
               entropy_median=ENT_MEDIAN, n_test_errors_seed0=int(err0.sum()),
               guidance_rules=list(RULES.rule), rule_criterion=RULE_CRITERION, smoke_test=SMOKE_TEST)
json.dump(summary, open(os.path.join(OUT_DIR, "summary.json"), "w"), indent=2)
zip_path = os.path.join(WORK, "partA_outputs.zip")
if os.path.exists(zip_path): os.remove(zip_path)
shutil.make_archive(zip_path[:-4], "zip", OUT_DIR)
print("Done. Download:", zip_path)
