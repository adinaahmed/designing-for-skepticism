# Phase 3 Implementation Package — Designing for Skepticism

Adina Ahmad (24I-2594) · Khadija Bhatti (24I-2606)
Data Analysis & Visualization — Research Project, Phase 3

This package contains the code, data and results for both parts of the study proposed in Phase 2:

- **Part A (computational):** a ResNet-18 classifier trained on CIFAR-10 on a Kaggle GPU, with calibrated (temperature-scaled) and overconfident (sharpened) confidence, the baselines and the ablations.
- **Part B (behavioural):** a web experiment in which 42 students classified pictures with the model's advice in five display formats (V1–V5), and the R script that analyses their data (33 participants after the pre-registered exclusions).

The full write-up is in `Phase3_Report.docx`.

```
phase3/
├── Phase3_Report.docx                    the Phase 3 report
├── README.md
├── docs/displays_V1_V5.png               the five advice displays as participants saw them
├── partA/
│   ├── PartA_CIFAR10_Confidence.ipynb    the notebook run on Kaggle
│   ├── partA_notebook.py                 the same code as a plain Python script
│   └── results/                          outputs of the Kaggle run (tables, figures, training logs, Part B stimuli)
├── partB/
│   ├── experiment/                       the jsPsych 7.3.4 experiment (source files and stimuli)
│   ├── google_apps_script/
│   │   ├── Code.gs                       web app that served the study link and saved the data to Google Drive
│   │   └── AI_Advice_Study.html          the exact single-file study used for data collection
│   ├── tools/build_single_file.py        builds AI_Advice_Study.html from experiment/
│   ├── data/                             the 42 participant files collected on 13–14 Nov 2026
│   ├── analysis/analysis_partB.R         the Part B analysis
│   ├── results/                          27 tables, 7 figures and summary.txt from the analysis
│   └── tests/                            automated test scripts (simulated participants; not study data)
└── report/build_report.js                builds Phase3_Report.docx from the results files
```

---

## Part A — model and confidence (Kaggle)

**Run.** `partA/PartA_CIFAR10_Confidence.ipynb` was run on Kaggle (GPU T4 × 2, Internet on, *Save & Run All*). It downloads CIFAR-10 and CIFAR-10H, trains 4 models (seeds 0, 1 and 2, plus one without augmentation; 30 epochs each), and computes all metrics, ablations, figures and the Part B stimulus pack. The notebook can resume training from the last saved epoch, and if a finished run is attached as an input it reuses the saved model outputs instead of retraining.

**Outputs (`partA/results/`).** These files are exactly as downloaded from the Kaggle runs:

- `table_main_metrics.csv`: accuracy, ECE, Brier, NLL, AUROC, confident-error rate and correlation with human difficulty for the 4 confidence methods (mean ± SD over 3 seeds, and seed-0 values with 95% bootstrap CIs);
- the other `table_*.csv` files: ablations, guidance coverage, confusion pairs, capability profile, model vs human difficulty, confident errors on hard-for-human images, the comparison with Phase 2 Paper 4, and the list of Part B stimuli;
- `figures/`: reliability diagrams, confidence histograms, confidence vs human difficulty, training curves, confusion matrix, overconfidence ablation, and the most confident errors;
- `training_log_*.csv`, `config.json`, `summary.json`, `split_val_indices.npy`, `cifar10h_difficulty.csv`;
- `partB_stimuli/`: the 50 study pictures, 3 practice pictures and `stimuli.json` / `stimuli.js` (AI answers, calibrated and overconfident confidence, V5 guidance rules).

The saved model probabilities (`probs_seed*.npz`, about 56 MB) are not included because of their size; they are only needed to rerun the notebook without retraining.

## Part B — the behavioural study

**How it was run.** Students opened one link (a Google Apps Script web app) on a phone or laptop, with no sign-in or download. The web app served `AI_Advice_Study.html`, gave each new participant the next condition in a 20-condition rotation, and saved each finished session as a CSV file in the researchers' Google Drive. Pilot runs (`?pilot=1`) were marked and are ignored by the analysis.

**Procedure (about 8–10 minutes; median 9.2 minutes).** Consent → age, gender and AI use → baseline trust → tutorial and 3 practice pictures → 5 rounds, one per display (V1–V5) in Latin-square order. Each round starts with a short explanation of the display and one comprehension question, then shows 5 pictures (1 easy and 3 hard pictures the AI gets right, and 1 AI error). For each picture the participant answers first, rates how sure they are, sees the AI's advice, and gives a final answer. After each round they see feedback (which answers were right and which AI answers were wrong) and rate their trust in the AI and its estimated accuracy. The study ends with the most useful display, an optional comment, a score screen and a debrief.

**Conditions.** Condition c (0–19): calibration group = c mod 2, display order = floor(c / 2) mod 5, picture half h = floor(c / 10) mod 2.

**Data (`partB/data/`).** 42 finished sessions: 19 calibrated and 23 overconfident. The link was opened 83 times, and the rest did not finish. The files contain no names, e-mail addresses or student IDs; each participant has a random ID.

**Analysis.** R 4.3 with lme4, afex, emmeans, ggplot2, dplyr, tidyr, readr, purrr, jsonlite and pwr:

```
Rscript partB/analysis/analysis_partB.R partB/data partB/results
```

The script applies the Phase 2 exclusion rules (failed a comprehension question twice: 9 participants; trials faster than 300 ms or slower than mean + 3 SD: 43 of 825 trials) and writes 27 tables, 7 figures and `summary.txt`, covering the GLMMs and Holm-corrected contrasts for H1–H3, the mixed ANOVA with non-parametric alternatives, effect sizes, the trust models (H4), moderation (H5), the Part B ablations, reliance–confidence slopes, error analysis, participant profiles, the comparison with Papers 2 and 9 and Too Sure for Our Own Good, and the sensitivity analysis.

**Testing.** Before data collection, the experiment was run end to end by automated simulated participants (`partB/tests/`) in Chromium, on desktop and phone screen sizes, with the Google server replaced by a local mock. This checked condition assignment, balancing, data saving and the analysis script. Test data are not part of `partB/data/` and are not reported.

**Rebuilding the study file.** After a change in `partB/experiment/`, run `python partB/tools/build_single_file.py partB/experiment AI_Advice_Study.html` and upload the result to Google Drive as a new version of the existing file.

---

## Implementation decisions

These details were not fixed in the Phase 2 document, or changed during implementation. The main ones are also listed in Section 1.4 of the report.

| # | Decision | Reason |
|---|---|---|
| 1 | A **dropout layer (p = 0.2)** is added before the final layer of ResNet-18. | ResNet-18 has no dropout; the MC dropout baseline (A2) needs one. |
| 2 | MC dropout applies the 30 dropout masks to the stored 512-d features. | Identical to 30 full forward passes, because dropout sits directly before the last layer, and about 100× faster. |
| 3 | SGD momentum 0.9, weight decay 5e-4, batch size 128, mixed precision. | Standard values for fine-tuning ResNet-18; Phase 2 fixed only the learning rate (0.01), cosine decay and 30 epochs. |
| 4 | The 32 → 224 resize and the augmentation run on the GPU. | Same result as on the CPU, but much faster. |
| 5 | **Easy / hard** uses a median split on CIFAR-10H **entropy** (cut-off 0.095). | 44% of images have human accuracy = 1.0, so a median split on accuracy cannot separate them. |
| 6 | **V3 categories:** High ≥ 80%, Medium 50–79%, Low < 50%. | Phase 2 did not define the cut-offs; 80% is the methodology's own "confident" threshold. |
| 7 | **Guidance rules** are built on the validation split ("when the AI answers *cat*", "telling a *cat* from a *dog*", dark or blurry images). A weakness becomes a rule if its error rate is ≥ 2× the overall validation error rate (at most 6 rules). If fewer than 3 qualify, the 3 highest above-average weaknesses are used. | Phase 2 gave no threshold. In the real run only one weakness reached 2×, so the fallback applied. |
| 8 | Stimuli come from the CIFAR-10 test set (seed-0 model). Errors are screened so the overconfident confidence is ≥ 80%; classes are balanced within each set where possible. | Follows Step 5a. |
| 9 | **Metacognitive sensitivity** uses the type-2 AUROC (confidence in the first answer vs whether it was correct). | Phase 2 allows meta-d′ or type-2 AUROC; meta-d′ needs many trials per person. |
| 10 | Practice trials use the label-only display and show the correct answer. | Phase 2 specified 3 practice trials but not their display. |
| 11 | Round feedback lists, for each picture, the correct answer, the AI's answer and the participant's final answer. | Implements "shows the correct answers and which AI recommendations were wrong". |
| 12 | Kaggle is used instead of Google Colab. | Longer free GPU sessions; the notebook works on both. |
| 13 | **Confident-error acceptance** is compared across displays within the overconfident group only; group differences are tested with error detection on all AI-error trials (H1). | With honest confidence, the AI's errors are rarely shown at ≥ 80%, so this measure does not exist for most calibrated participants. |
| 14 | **Representative stimulus sampling.** Within each trial type, the share of trials covered by the V5 guidance matches the share on the full test set (40.1% of AI errors, 19.3% of correct answers). | A purely random draw of 10 errors included only 1 the guidance applies to, against 4 expected, which would make H3 almost untestable. |
| 15 | **Paper 4 comparison** uses the CIFAR-10 accuracies in Hao et al. (2026), *Scientific Reports*, Figure 12. | These are model accuracies, not results of its human-participant experiment, so they are context rather than a like-for-like benchmark. |
| 16 | **Online study through one link** (Google Apps Script web app) instead of a computer-lab session. Conditions are assigned by the server in rotation; data are saved to Google Drive; the layout adapts to phones. | Booking a lab was not feasible in the time available. Unsupervised participation is a limitation; the comprehension checks and response-time exclusions address part of it. |
| 17 | **Model-fitting fallback.** If a GLMM fails to converge, it is refitted with another optimiser (Nelder–Mead, then nAGQ = 0); the formula never changes. Displayed confidence is centred in the slope model. | Small samples can make complex models fail numerically; this does not change what is estimated. |
| 18 | **Shorter study: 25 pictures instead of 50** (5 rounds of 5; the AI is still right on 80% of pictures). Which pictures and which AI error (easy or hard) appear is counterbalanced by a third factor h, giving 20 conditions. The AI error appears at picture 3, 4 or 5 of a round. GAAIS, the Trust in Automation scale, the final-answer confidence rating and the study-programme question were removed. | The first pilot took 25–30 minutes, too long for unpaid online participation. Each display now has 1 AI error per participant instead of 2, so more participants are needed. |
| 19 | **Easier questions.** The Berlin Numeracy Test was removed (H5 is tested with metacognition only); confidence is one tap on 4 buttons (Just guessing / Not sure / Fairly sure / Very sure); estimated AI accuracy is a slider; display preference is one choice instead of a ranking. | Pilot participants found the questions too demanding. The same measures are kept in a simpler form. |
| 20 | **Harder picture mix.** Each round shows 1 easy + 3 hard AI-correct pictures (instead of 2 + 2) and 1 AI error. | In the pilot almost every picture was easy without the AI, leaving little room for advice to matter (a ceiling effect). |
| 21 | **Sample.** Data were collected until 42 students had finished (33 after exclusions: 17 calibrated, 16 overconfident). | The Phase 3 deadline. Part B is reported with effect sizes, confidence intervals and a sensitivity analysis (80% power only for large effects). |
