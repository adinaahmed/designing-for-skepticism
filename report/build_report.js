// Builds the Phase 3 report (Word) in the same style as the Phase 2 document.
// Usage: node build_report.js <output.docx>
const fs = require("fs");
const path = require("path");
const {
  Document, Packer, Paragraph, TextRun, Table, TableRow, TableCell, ImageRun, AlignmentType,
  HeadingLevel, WidthType, BorderStyle, ShadingType, LevelFormat,
} = require("docx");

const ROOT = path.resolve(__dirname, "..");
const FIG = (f) => path.join(ROOT, "partA", "results", "figures", f);
const OUT = process.argv[2] || path.join(__dirname, "Phase3_Report.docx");
const CONTENT_W = 9746;                       // A4 width minus 0.75" margins, in DXA

// ---------- helpers ----------
function runs(text, base = {}) {             // **bold** and _italic_ markup
  const out = [];
  text.split(/(\*\*[^*]+\*\*|_[^_]+_)/).forEach((part) => {
    if (!part) return;
    if (part.startsWith("**")) out.push(new TextRun({ ...base, text: part.slice(2, -2), bold: true }));
    else if (part.startsWith("_") && part.endsWith("_") && part.length > 2) out.push(new TextRun({ ...base, text: part.slice(1, -1), italics: true }));
    else out.push(new TextRun({ ...base, text: part }));
  });
  return out;
}
const P = (t, opts = {}) => new Paragraph({ children: runs(t), spacing: { after: 120, line: 276 }, ...opts });
const H1 = (t) => new Paragraph({ heading: HeadingLevel.HEADING_1, children: [new TextRun(t)] });
const H2 = (t) => new Paragraph({ heading: HeadingLevel.HEADING_2, children: [new TextRun(t)] });
const H3 = (t) => new Paragraph({ heading: HeadingLevel.HEADING_3, children: [new TextRun(t)] });
const B = (t) => new Paragraph({ numbering: { reference: "bullets", level: 0 }, children: runs(t), spacing: { after: 80, line: 276 } });
const PENDING = (t) => new Paragraph({ children: [new TextRun({ text: "[" + t + "]", italics: true })], spacing: { after: 120 },
  border: { left: { style: BorderStyle.SINGLE, size: 12, color: "000000", space: 6 } } });
const CAP = (t) => new Paragraph({ children: runs(t, { italics: true, size: 20 }), spacing: { after: 200 }, alignment: AlignmentType.LEFT });

const cellBorder = { style: BorderStyle.SINGLE, size: 4, color: "000000" };
const borders = { top: cellBorder, bottom: cellBorder, left: cellBorder, right: cellBorder };
function table(headers, rows, widths) {
  const total = widths.reduce((a, b) => a + b, 0);
  const w = widths.map((x) => Math.round((x / total) * CONTENT_W));
  w[w.length - 1] += CONTENT_W - w.reduce((a, b) => a + b, 0);
  const cell = (text, i, head) => new TableCell({
    borders, width: { size: w[i], type: WidthType.DXA },
    shading: head ? { fill: "D9D9D9", type: ShadingType.CLEAR, color: "auto" } : undefined,
    margins: { top: 60, bottom: 60, left: 90, right: 90 },
    children: String(text).split("\n").map((line) => new Paragraph({ spacing: { after: 0, line: 240 },
      children: runs(line, { size: 17, bold: head ? true : undefined }) })),
  });
  return new Table({
    width: { size: CONTENT_W, type: WidthType.DXA }, columnWidths: w,
    rows: [new TableRow({ tableHeader: true, cantSplit: true, children: headers.map((h, i) => cell(h, i, true)) }),
           ...rows.map((r) => new TableRow({ cantSplit: true, children: r.map((c, i) => cell(c, i, false)) }))],
  });
}
const GAP = () => new Paragraph({ children: [], spacing: { after: 60 } });
function fig(file, widthPx, caption) {
  const buf = fs.readFileSync(file);
  const w = buf.readUInt32BE(16), h = buf.readUInt32BE(20);        // PNG header
  const width = Math.min(widthPx, 640), height = Math.round((h / w) * width);
  return [new Paragraph({ alignment: AlignmentType.CENTER, spacing: { before: 120, after: 60 }, keepNext: true,
            children: [new ImageRun({ type: "png", data: buf, transformation: { width, height } })] }), CAP(caption)];
}

// ---------- results (read from the Part A output files, not typed by hand) ----------
function csv(file) {
  const lines = fs.readFileSync(path.join(ROOT, "partA", "results", file), "utf8").trim().split(/\r?\n/);
  const split = (l) => { const o = []; let cur = "", q = false;
    for (const ch of l) { if (ch === '"') q = !q; else if (ch === "," && !q) { o.push(cur); cur = ""; } else cur += ch; }
    o.push(cur); return o; };
  const head = split(lines[0]);
  return lines.slice(1).map((l) => { const v = split(l); const r = {}; head.forEach((h, i) => (r[h] = v[i])); return r; });
}
const MAIN = csv("table_main_metrics.csv");
const ABL = csv("table_ablations_partA.csv");
const COV = csv("table_guidance_coverage.csv");
const P4 = csv("table_comparison_paper4.csv");
const M = (method, metric) => MAIN.find((r) => r.method.startsWith(method) && r.metric === metric);
const f3 = (x) => Number(x).toFixed(3), f4 = (x) => Number(x).toFixed(4), pc = (x, d = 1) => (100 * Number(x)).toFixed(d) + "%";
const meanSd = (r, kind) => kind === "pct" ? `${(100 * r.mean_over_seeds).toFixed(1)} ± ${(100 * r.sd_over_seeds).toFixed(1)}%`
                                           : `${f3(r.mean_over_seeds)} ± ${f3(r.sd_over_seeds)}`;
const ci = (r, kind) => kind === "pct" ? `${pc(r.seed0)} [${pc(r.ci_low)}, ${pc(r.ci_high)}]`
                                       : `${f3(r.seed0)} [${f3(r.ci_low)}, ${f3(r.ci_high)}]`;
const METHODS = [["A1 Uncalibrated", "A1 Uncalibrated softmax"], ["Proposed", "Proposed: temperature scaling (T*)"],
                 ["A3 Sharpened", "A3 Sharpened T*/4 (overconfident)"], ["A2 MC dropout", "A2 MC dropout (30 passes)"]];
const METRICS = [["accuracy", "Accuracy", "pct"], ["ece", "ECE (15 bins) ↓", "num"], ["brier", "Brier score ↓", "num"],
                 ["nll", "NLL ↓", "num"], ["auroc", "Error-detection AUROC ↑", "num"],
                 ["confident_error_rate", "Confident-error rate (errors shown ≥ 80%) ↓", "pct"],
                 ["spearman_human", "Spearman ρ with human accuracy (CIFAR-10H) ↑", "num"]];
const A = (abl, variant) => ABL.find((r) => r.ablation.includes(abl) && r.variant === variant);


// ---------- Part B results (read from the Part B output files) ----------
const FIGB = (f) => path.join(ROOT, "partB", "results", "figures", f);
function csvB(file) {
  const lines = fs.readFileSync(path.join(ROOT, "partB", "results", "tables", file), "utf8").trim().split(/\r?\n/);
  const split = (l) => { const o = []; let cur = "", q = false;
    for (const ch of l) { if (ch === '"') q = !q; else if (ch === "," && !q) { o.push(cur); cur = ""; } else cur += ch; }
    o.push(cur); return o; };
  const head = split(lines[0]);
  return lines.slice(1).map((l) => { const v = split(l); const r = {}; head.forEach((h, i) => (r[h] = v[i])); return r; });
}
const BD = csvB("B05_metrics_descriptives.csv");
const BPREF = csvB("B25_display_preference.csv");
const BSLOPE = csvB("B14_trust_slope_by_calibration.csv");
const BTM = csvB("B12_trust_models.csv");
const BSENS = csvB("B27_sensitivity_analysis.csv");
const pv = (x) => { const v = Number(x); return v < 0.001 ? "< .001" : "= " + v.toFixed(3).replace(/^0/, ""); };
const pcB = (x) => (x === "NA" || x === "" || x === undefined) ? "–" : (100 * Number(x)).toFixed(0) + "%";

// ---------- document ----------
const C = [];
C.push(new Paragraph({ children: [new TextRun({ text: "DATA ANALYSIS & VISUALIZATION — RESEARCH PROJECT", bold: true })] }));
C.push(new Paragraph({ heading: HeadingLevel.TITLE, children: [new TextRun("Phase 3 — Implementation and Evaluation")] }));
C.push(P("_Topic: Designing for Skepticism: How Uncertainty Visualization Influences Human Detection of Overconfident AI Errors and Trust Calibration_"));
C.push(P("Submitted by: Adina Ahmad (24I-2594) and Khadija Bhatti (24I-2606)"));

C.push(H1("Overview"));
C.push(P("Phase 3 implements the methodology proposed in Phase 2 and evaluates it. The study has the same two parts. **Part A** is a computational evaluation of a real image classifier (ResNet-18 on CIFAR-10) whose confidence is produced in a calibrated and an overconfident form. **Part B** is a behavioural study in which students classify images with this model’s advice, shown in five display formats (V1–V5)."));
C.push(P("This report follows the seven Phase 3 requirements: (1) implementation and documented changes, (2) dataset, preprocessing and splits, (3) baselines, (4) results and graphs, (5) comparison with existing research, (6) ablation studies and (7) discussion."));
C.push(P("**Status.** Both parts are complete. Part A was trained on a Kaggle GPU. Part B was run online through one link on 13–14 November 2026; 42 students finished the study and 33 met the pre-registered inclusion rules."));

// ===== 1 =====
C.push(H1("1. Implementation of the Proposed Methodology"));
C.push(H2("1.1 What was implemented"));
C.push(P("Every step of the Phase 2 pipeline was turned into working code. The table shows where each step is implemented."));
C.push(table(["Phase 2 step", "Implemented as", "Where"], [
  ["1 Research input", "Part A: 10,000 CIFAR-10 test images × 4 confidence methods. Part B: participant × trial records (answer before and after advice).", "Part A notebook; Part B experiment"],
  ["2 Data collection", "CIFAR-10 and CIFAR-10H downloaded automatically; Part B stimulus set built from the test set; students take part through an online link.", "Part A notebook; Google Apps Script web app"],
  ["3 Preprocessing", "Normalisation, 32 → 224 px resize, augmentation, 45,000 / 5,000 / 10,000 split, CIFAR-10H difficulty; Part B exclusion rules.", "Part A notebook; R analysis script"],
  ["4 Feature engineering", "Calibrated and overconfident confidence, top-3 probabilities, human difficulty, capability profile, behavioural and person-level features.", "Part A notebook; R analysis script"],
  ["5 Proposed method", "5a ResNet-18 with temperature scaling (T*) and sharpening (T*/4). 5b the five displays V1–V5 (Figure 1).", "Part A notebook; experiment code (displays.js)"],
  ["6 Baselines", "A1 uncalibrated softmax, A2 MC dropout, A3 sharpened softmax; human alone; V1–V4.", "Part A notebook; Part B experiment"],
  ["7 Experimental design", "3 training seeds (Part A); 2 (calibration) × 5 (display) × 2 (AI correct/error) × 2 (easy/hard) mixed design with Latin-square order (Part B).", "Part A notebook; experiment.js"],
  ["8 Metrics", "All Part A and Part B metrics of Step 8.", "Part A notebook; R analysis script"],
  ["9 Statistics", "Bootstrap CIs and seed means (Part A); GLMMs, mixed ANOVA, Holm-corrected contrasts, trust LMM, moderation, sensitivity analysis (Part B).", "Part A notebook; R analysis script"],
  ["10 Ablations", "Six Part A ablations (Section 6); three Part B display contrasts.", "Part A notebook; R analysis script"],
  ["11 Error analysis", "Confusion matrix, highest-confidence errors, model vs human difficulty (Part A); accepted errors, rejected correct advice, participant profiles, comments (Part B).", "Part A notebook; R analysis script"],
  ["12 Final output", "This report, the code package and the anonymised data.", "Phase 3 package"],
], [16, 58, 26]));
C.push(GAP());
C.push(P("**Tools.** Part A runs in Python (PyTorch) on a free Kaggle GPU (2 × NVIDIA T4). The full run (3 seeds × 30 epochs, a no-augmentation model and all evaluation) took about 2.5 hours. Part B is a web experiment built with jsPsych 7.3.4. It is served by a Google Apps Script web app, which gives each student a condition automatically and saves their data file in the researchers’ Google Drive. Part B is analysed in R (lme4, afex, emmeans, pwr). Every component was tested end to end with automated test participants before real data collection; their data are never used as results."));

C.push(H2("1.2 The five displays"));
C.push(P("Figure 1 shows the five displays exactly as participants see them, with an example confidence of 82%. The guidance panel in V5 lists the real weaknesses found in the model’s validation-set profile (Section 4.2)."));
C.push(...fig(path.join(ROOT, "docs", "displays_V1_V5.png"), 380, "Figure 1. The five advice displays: V1 label only, V2 numeric confidence, V3 confidence category (High ≥ 80%, Medium 50–79%, Low < 50%), V4 visual uncertainty (top-3 bar chart and 10 × 10 icon array), V5 visual uncertainty + capability guidance."));

C.push(H2("1.3 Part B procedure as implemented"));
C.push(P("Students open one link on a phone or laptop. No sign-in, download or participant number is needed. The study takes about 8–10 minutes:"));
[ "Consent → three short questions about the participant (age, gender, how often they use AI tools) → baseline trust rating.",
  "Tutorial and 3 practice pictures (label-only display; the correct answer is shown after each).",
  "**5 rounds**, one per display, in Latin-square order. Each round starts with one screen explaining that round’s display and one comprehension question.",
  "Each of the 5 pictures in a round follows the **judge–advise–revise** protocol: (1) the participant taps a label and how sure they are; (2) the AI’s advice appears in the round’s display; (3) the participant taps a final label. No feedback is given during a round.",
  "**Delayed round feedback:** the participant’s score, the AI’s score and, for each picture, the correct answer, the AI’s answer (marked correct or wrong) and the participant’s final answer. Then trust in the AI (0–100) and estimated AI accuracy (0–100).",
  "After the last round: the display found most useful, an optional comment, the total score (participant vs AI) and a debrief explaining that one AI version was deliberately overconfident. The data file is then saved automatically.",
].forEach((t) => C.push(B(t)));

C.push(H2("1.4 Documented changes from the Phase 2 methodology"));
C.push(P("The methodology was followed as written wherever possible. The table lists every point where the implementation had to fill in a detail that Phase 2 left open, or had to change something, with the reason."));
C.push(table(["#", "Change", "Reason"], [
  ["1", "A dropout layer (p = 0.2) is added before the final layer of ResNet-18; MC dropout applies 30 dropout masks to the stored features.", "ResNet-18 has no dropout, but baseline A2 needs one. Because dropout sits directly before the last layer, this is identical to 30 full passes and about 100× faster."],
  ["2", "Training details: SGD with momentum 0.9, weight decay 5 × 10⁻⁴, batch size 128, mixed precision; resize and augmentation run on the GPU.", "Phase 2 fixed only the learning rate (0.01), cosine decay and 30 epochs; these are standard fine-tuning values."],
  ["3", "Kaggle is used instead of Google Colab (the notebook runs on both).", "Kaggle gives longer free GPU sessions."],
  ["4", "Easy / hard images use a median split of CIFAR-10H **label entropy** (cut-off 0.095).", "44% of images have human accuracy 1.0, so a median split on accuracy cannot separate them; entropy splits the images in half."],
  ["5", "Guidance rules: a weakness becomes a rule if its validation error rate is ≥ 2× the overall rate (at most 6). If fewer than 3 qualify, the 3 highest above-average weaknesses are used.", "Phase 2 said the guidance must come only from the validation profile but gave no threshold. Only one weakness (“the AI answers cat”) reached 2×, so the fallback applied (Section 4.2)."],
  ["6", "V3 categories: High ≥ 80%, Medium 50–79%, Low < 50%.", "Phase 2 did not set the cut-offs; 80% is the methodology’s own “confident” threshold."],
  ["7", "**Representative stimulus sampling:** within each trial type, the share of trials covered by the V5 guidance matches the share on the full test set (40.1% of AI errors, 19.3% of correct answers).", "A purely random draw of 10 errors happened to include only 1 that the guidance applies to (4 expected), which would have made H3 almost untestable."],
  ["8", "Metacognitive sensitivity uses the type-2 AUROC (confidence in the first answer vs whether it was correct).", "Phase 2 allowed meta-d′ or type-2 AUROC; meta-d′ needs many more trials per person."],
  ["9", "**Online delivery:** one web link (Google Apps Script) instead of a supervised session. The server assigns conditions in rotation and saves each data file in Google Drive.", "Students would not install or open files; one link on a phone gives far more responses. The design and balance are unchanged."],
  ["10", "**Shorter study (25 pictures instead of 50):** 5 rounds of 5. Each round shows 1 easy + 3 hard AI-correct pictures and 1 AI error (harder mix chosen after the pilot, where the pictures were almost always clear to the pilot participant; 2 of the 4 easy AI-correct pictures per set are no longer shown), so the AI is still right on 80%. Which error (easy or hard) and which half of the correct pictures appear is counterbalanced (20-condition rotation), so every picture is used and each display meets easy and hard errors equally often.", "A pilot of the full version took 25–30 minutes, too long for unpaid online participation. Trade-off: 1 AI error per display per participant instead of 2, so more participants are needed (target 40 or more)."],
  ["11", "**Fewer and easier questions:** removed GAAIS, the Trust in Automation scale, the Berlin Numeracy Test, the second confidence rating and the typed study-programme question. Confidence is now one tap on 4 buttons (Just guessing / Not sure / Fairly sure / Very sure), estimated AI accuracy is a slider, and display preference is one tap instead of a ranking.", "Students found the questions too long and too hard. GAAIS and Trust in Automation were descriptive only; the second confidence rating was not used in any metric. H5 is now tested with metacognition only. The type-2 AUROC needs only the order of the confidence ratings, so 4 levels are enough."],
  ["12", "Confident-error acceptance is compared across displays **within the overconfident group only**; group differences are tested with error detection on all AI-error trials (H1).", "With honest confidence, few AI errors are shown at ≥ 80%, so this metric does not exist for most calibrated participants."],
  ["13", "If a trial-level GLMM fails to fit numerically, it is refitted with another optimiser (Nelder–Mead, then nAGQ = 0); the model formula never changes.", "Models with three-way interactions can fail on small samples; the method used is printed in the log."],
  ["14", "Comparison with Paper 4 uses the CIFAR-10 accuracies in its Figure 12.", "These are model accuracies, not human-participant results, so they are context rather than a like-for-like benchmark (Section 5)."],
], [4, 52, 44]));

// ===== 2 =====
C.push(H1("2. Dataset, Preprocessing and Splits"));
C.push(H2("2.1 Datasets"));
C.push(B("**CIFAR-10:** 60,000 colour images of 32 × 32 px in 10 everyday classes (airplane, automobile, bird, cat, deer, dog, frog, horse, ship, truck); 50,000 training and 10,000 test images."));
C.push(B("**CIFAR-10H:** about 50 human labels for each of the 10,000 CIFAR-10 test images. Mean human accuracy is 95.2%; 44% of images were labelled correctly by every annotator."));
C.push(B("**Part B data:** one CSV file per participant (one row per screen), saved automatically when the participant finishes."));
C.push(H2("2.2 Splits"));
C.push(table(["Split", "Images", "Used for"], [
  ["Training", "45,000", "Training ResNet-18 (3 seeds: 0, 1, 2)"],
  ["Validation", "5,000 (fixed split seed 42)", "Fitting the temperature T*; building the capability profile and the V5 guidance; never used for training"],
  ["Test", "10,000", "All Part A metrics, ablations and error analysis; pool for the Part B pictures"],
], [16, 26, 58]));
C.push(GAP());
C.push(H2("2.3 Preprocessing"));
C.push(B("Per-channel normalisation with the CIFAR-10 mean and standard deviation; images resized from 32 to 224 px for the ImageNet-pretrained network."));
C.push(B("Training augmentation only: random crop with 4 px padding and horizontal flip. A second model without augmentation was trained for the ablation."));
C.push(B("CIFAR-10H label counts converted into a probability distribution per image. Human accuracy and label entropy were computed from it, and images were split at the median entropy into **easy** (5,170) and **hard** (4,830) for humans."));
C.push(B("Pictures shown to participants were upscaled with bicubic interpolation to 256 × 256 px."));
C.push(B("Part B (in the R script): pilot runs are removed. Participants who fail a comprehension question twice or do not finish are excluded. Trials faster than 300 ms or slower than 3 SD above the participant’s mean are removed. Mixed-effects models keep participants with a few missing trials."));
C.push(H2("2.4 Part B stimulus set"));
C.push(P("The stimuli come from the CIFAR-10 test set and the seed-0 model, drawn with a fixed seed (2026). There are 50 test pictures in 5 sets of 10, each with 4 correct/easy, 4 correct/hard, 1 error/easy and 1 error/hard (the Phase 2 structure), plus 3 practice pictures. All errors were screened so that the overconfident confidence is at least 80%. Each participant sees 25 of the 50 pictures (change 10). The table describes the confidence values participants actually see."));
C.push(table(["Trial type", "Pictures", "Mean calibrated confidence", "Mean overconfident confidence", "Mean human accuracy (CIFAR-10H)"], [
  ["AI correct, easy", "20", "99.8%", "100.0%", "100%"],
  ["AI correct, hard", "20", "95.9%", "99.9%", "91%"],
  ["AI error, easy", "5", "81.3%", "97.9% (min 91.0%)", "100%"],
  ["AI error, hard", "5", "81.3%", "98.8% (min 96.2%)", "85%"],
], [22, 12, 22, 22, 22]));
C.push(GAP());
C.push(P("The same images and AI answers are used in both groups; only the confidence values differ. In the overconfident version every AI error is shown with at least 91% confidence. In the calibrated version the same errors are shown at about 81% on average, so their confidence is lower than that of the correct answers (96–100%)."));

// ===== 3 =====
C.push(H1("3. Baselines"));
C.push(P("The baselines are those defined in Phase 2 (Step 6). Part A baselines are compared on the same 10,000 test images; Part B baselines are compared within the same participants."));
C.push(table(["Code", "Baseline", "Purpose", "Results"], [
  ["A1", "Uncalibrated softmax", "The default output of most neural networks", "Section 4.1"],
  ["A2", "MC dropout (30 passes)", "A common uncertainty-estimation method", "Section 4.1"],
  ["A3", "Sharpened softmax (T*/4)", "The overconfident condition", "Section 4.1"],
  ["Proposed", "Temperature scaling (T*)", "Calibrated confidence used in the calibrated group", "Section 4.1"],
  ["Human alone", "Participant’s first answer, before advice", "Human-only accuracy on the same trials", "Section 4.3"],
  ["V1", "AI label only", "Advice with no confidence cue", "Section 4.3"],
  ["V2", "Numeric confidence (“82%”)", "Numeric format (Phase 1; Phase 2 Paper 9)", "Section 4.3"],
  ["V3", "Confidence category (High / Medium / Low)", "Label format (Too Sure for Our Own Good, Phase 1)", "Section 4.3"],
  ["V4", "Visual uncertainty without guidance", "Separates the visual encoding from the guidance", "Section 4.3"],
], [12, 30, 40, 18]));
C.push(GAP());

// ===== 4 =====
C.push(H1("4. Results and Graphs"));
C.push(H2("4.1 Part A — confidence of the AI model"));
C.push(P(`The model reached **${(100 * M("A1", "accuracy").mean_over_seeds).toFixed(2)}% ± ${(100 * M("A1", "accuracy").sd_over_seeds).toFixed(2)}%** test accuracy over the three seeds. Validation accuracy levelled off after about 20 epochs (Figure 2). The fitted temperatures were T* = 1.637, 1.673 and 1.655, so the raw model was slightly overconfident. Temperature scaling and sharpening only rescale the probabilities, so all four methods have the same accuracy and the same top-1 answers.`));
C.push(table(["Metric", ...METHODS.map((m) => m[1])],
  METRICS.map(([k, label, kind]) => [label, ...METHODS.map(([key]) => { const r = M(key, k); return `${meanSd(r, kind)}\nseed 0: ${ci(r, kind)}`; })]),
  [28, 18, 18, 18, 18]));
C.push(CAP("Table 1. Part A results on the 10,000 test images: mean ± SD over 3 seeds; second line, seed-0 value with 95% bootstrap CI (1,000 resamples). ↓ lower is better, ↑ higher is better."));
C.push(...fig(FIG("fig4_training_curves.png"), 360, "Figure 2. Validation accuracy per epoch for the three training seeds."));
C.push(P(`**Calibration.** Temperature scaling reduced the expected calibration error from ${f3(M("A1", "ece").mean_over_seeds)} (A1) to **${f3(M("Proposed", "ece").mean_over_seeds)}**, the lowest of all methods, and also gave the best Brier score and NLL. Sharpening the same model (A3) raised ECE to **${f3(M("A3", "ece").mean_over_seeds)}**, about six times the calibrated value, and more than doubled NLL. MC dropout improved calibration only slightly over A1 (${f3(M("A2", "ece").mean_over_seeds)}). The reliability diagrams (Figure 3) show the calibrated bars close to the diagonal and the sharpened bars well below it: the overconfident AI claims more certainty than its accuracy justifies.`));
C.push(...fig(FIG("fig1_reliability_diagrams.png"), 640, "Figure 3. Reliability diagrams (seed 0). Bars show accuracy within each confidence bin; the dashed line is perfect calibration."));
C.push(P(`**Confident errors.** The key quantity for this study is how many AI errors are shown with at least 80% confidence. With the calibrated AI this is **${pc(M("Proposed", "confident_error_rate").mean_over_seeds)}** of errors; with the overconfident AI it is **${pc(M("A3", "confident_error_rate").mean_over_seeds)}**. The raw softmax lies in between (${pc(M("A1", "confident_error_rate").mean_over_seeds)}). Figure 4 shows why: after sharpening, almost all wrong predictions are pushed into the top confidence bin, next to the correct ones.`));
C.push(...fig(FIG("fig2_confidence_histograms.png"), 640, "Figure 4. Confidence of correct (blue) and wrong (orange) predictions (seed 0); the dotted line marks 80%."));
C.push(P(`**Error detection.** Ranking-based error detection changed much less. AUROC was ${f3(M("Proposed", "auroc").mean_over_seeds)} for the calibrated AI and ${f3(M("A3", "auroc").mean_over_seeds)} for the overconfident AI. The order of the confidence values is almost the same, but the overconfident numbers are inflated, so a user reading them at face value has no warning on most errors.`));
C.push(P(`**Human difficulty (RQ4).** Model confidence correlates only moderately with human accuracy on the same image (Spearman ρ = ${f3(M("Proposed", "spearman_human").mean_over_seeds)} calibrated; ${f3(M("A3", "spearman_human").mean_over_seeds)} overconfident). Figure 5 shows that confidence rises with human accuracy, but in the overconfident version it stays above 97% even for images that humans find hardest.`));
C.push(...fig(FIG("fig3_confidence_vs_human_difficulty.png"), 600, "Figure 5. Left: mean model confidence by human accuracy on the image (CIFAR-10H). Right: share of AI errors among images that are easy and hard for humans (seed 0)."));
C.push(P(`**H6 — supported.** Sharpening the confidence of the same model greatly increased the calibration error (ECE ${f3(M("Proposed", "ece").mean_over_seeds)} → ${f3(M("A3", "ece").mean_over_seeds)}) and the share of errors shown with at least 80% confidence (${pc(M("Proposed", "confident_error_rate").mean_over_seeds)} → ${pc(M("A3", "confident_error_rate").mean_over_seeds)}), while error-detection AUROC changed only slightly (${f3(M("Proposed", "auroc").mean_over_seeds)} → ${f3(M("A3", "auroc").mean_over_seeds)}).`));

C.push(H2("4.2 Part A — error analysis"));
C.push(P("The seed-0 model made 352 errors on the 10,000 test images. Figure 6 shows that they are concentrated in a few class pairs: cat → dog (44), dog → cat (44), automobile → truck (18), airplane → ship (16) and truck → automobile (14)."));
C.push(...fig(FIG("fig5_confusion_matrix.png"), 400, "Figure 6. Confusion matrix on the test set (seed 0)."));
C.push(P("**Errors that people are unlikely to catch.** The AI was wrong on only 56 of the 5,170 images that are easy for humans (1.1%), but on 296 of the 4,830 images that are hard for humans (6.1%). So **84% of the AI’s errors fall on images that humans also find hard**: exactly the errors where users must rely on the display rather than their own eyes. Figure 7 shows the AI’s highest-confidence errors. Many are shown at 99–100% even in the calibrated version, and on several of them most human annotators were also wrong (for example, an automobile labelled “truck” that only 21% of annotators recognised)."));
C.push(...fig(FIG("fig7_confident_errors_grid.png"), 560, "Figure 7. The AI’s 24 highest-confidence errors (seed 0), with the true class, the AI’s answer, the calibrated (cal) and overconfident (over) confidence, and the share of CIFAR-10H annotators who were right."));
C.push(P("**Capability profile and guidance (Step 4).** On the validation split the overall error rate was 3.4%. Among the 57 candidate weaknesses (each answer class, each class pair, dark and blurry images), only one reached the 2× rule: “when the AI answers _cat_” (8.2%, 2.4×). At least three rules are required, so the fallback rule applied, and the three strongest above-average weaknesses became the V5 guidance: **“When the AI answers ‘cat’”** (8.2%), **“When the AI answers ‘dog’”** (6.6%, 1.9×) and **“Telling a cat from a dog”** (4.5%, 1.3×). Dark (1.2×) and blurry (1.2×) images were weaker and were not used. These rules match the confusion matrix, where cat ↔ dog is by far the largest error pair."));

C.push(H2("4.3 Part B — behavioural results"));
C.push(P("**Sample.** The study link was opened 83 times (each opening reserves the next condition in the rotation); 42 students finished. Following Step 3 of the methodology, 9 were excluded for failing a comprehension check twice, leaving **33 participants (17 calibrated, 16 overconfident)**. Of their 825 trials, 43 were removed by the response-time rule (< 300 ms or > mean + 3 SD), leaving 782. Participants were 22 women and 11 men, aged 16–36 (mean 21.5); 18 used AI tools daily. The median completion time of all finishers was 9.2 minutes (IQR 7.6–11.5)."));
C.push(P(`**Sensitivity.** With about 16 participants per group, the study had 80% power only for large effects: d_z ≥ ${Number(BSENS[0].min_effect_80pct_power).toFixed(2)} for display contrasts within a group and d ≥ ${Number(BSENS[1].min_effect_80pct_power).toFixed(2)} for the calibration contrast. Null results below should be read as “no large effect found”, not as evidence of no effect.`));
C.push(P("**Overall behaviour.** Students were accurate on their own: 87.7% of first answers were correct (98.7% on easy and 85.5% on hard AI-correct pictures). After seeing the advice, final accuracy rose slightly to 89.3%. Students rarely changed their minds (7.3% of trials). When their first answer was wrong and the AI was right, 41.4% switched to the AI’s answer; when their first answer was right and the AI was wrong, only 9.7% switched to the wrong answer. Overall, 20.0% of final answers on AI-error trials matched the AI’s wrong answer (19.5% calibrated, 20.5% overconfident)."));
C.push(table(["Group", "Display", "Error detection", "Confident-error acceptance", "Appropriate reliance", "Final accuracy"],
  BD.map((r) => [r.calibration, r.display, pcB(r.error_detection_mean), pcB(r.confident_error_acceptance_mean), pcB(r.appropriate_reliance_mean), pcB(r.final_accuracy_mean)]),
  [18, 12, 17, 21, 17, 15]));
C.push(CAP("Table B1. Part B metrics by calibration group and display (means of participant values, n = 33). Confident-error acceptance needs an AI error shown with ≥ 80% confidence, so it does not exist for V1."));
C.push(P("**H1 (overconfident AI → more wrong advice accepted).** Not supported. Error detection did not differ between groups (80.5% vs 79.5% of AI errors rejected; mixed ANOVA calibration p = .65; no planned contrast significant after Holm correction). Pooled over V2–V5, confidently wrong advice was accepted somewhat more often in the overconfident group (22.6% vs 16.2%), the direction predicted by Too Sure for Our Own Good, but the difference was small and not significant."));
C.push(...fig(FIGB("B_fig1_confident_error_acceptance.png"), 520, "Figure B1. Acceptance of confidently wrong advice (≥ 80% shown) by display and group, with 95% CIs."));
C.push(P("**H2 (V4 best for appropriate reliance with a calibrated AI).** Not supported. In the calibrated group V4 did not differ from V2 (d = −0.14) or V3 (d = 0.06), for easy or hard pictures (all Holm-corrected p = 1.00). Appropriate reliance was close to the ceiling in every display (85–95% of trials; Figure B2)."));
C.push(...fig(FIGB("B_fig2_appropriate_reliance.png"), 600, "Figure B2. Appropriate reliance by display, group and human difficulty of the picture, with 95% CIs."));
C.push(P("**H3 (V5 guidance best against confident errors with an overconfident AI).** Not supported statistically, but the descriptive pattern points the predicted way. In the overconfident group, acceptance of confidently wrong advice fell steadily from V2 (36%) through V3 (25%) and V4 (19%) to V5 (13%) (Figure B1). None of the planned contrasts survived Holm correction; the only uncorrected difference was V5 vs V3 on easy errors (p = .039, Holm p = .54). Several contrasts could not be estimated precisely because almost nobody accepted errors in some cells, which gives very wide confidence intervals."));
C.push(P(`**H4 (trust drops more for the overconfident AI).** The first part is **supported**. After each round’s feedback, trust in the overconfident AI fell by ${Math.abs(Number(BSLOPE[1]["block_pos.trend"])).toFixed(2)} points per round (p ${pv(BSLOPE[1]["p.value"])}), while trust in the calibrated AI rose slightly (+${Number(BSLOPE[0]["block_pos.trend"]).toFixed(2)} per round, p ${pv(BSLOPE[0]["p.value"])}). The group × round interaction was significant (p ${pv(BTM.find((r) => r.term === "calibration:block_pos" && r.model === "trust")["Pr(>F)"])}). Mean trust went from 75 to 79 in the calibrated group and from 75 to 68 in the overconfident group (Figure B3), although both AIs were equally accurate (80% in every round). The second part was not supported: the gap between estimated and actual AI accuracy was not smaller in V5 rounds than in any other display (all adjusted p > .50).`));
C.push(...fig(FIGB("B_fig3_trust_trajectory.png"), 520, "Figure B3. Trust in the AI before the task (baseline) and after each round’s feedback, by group, with 95% CIs."));
C.push(P("**H5 (low-metacognition users benefit most from V4/V5).** Not supported. Metacognitive sensitivity did not moderate the effect of display on appropriate reliance (display × metacognition p = .81). The numeracy part of H5 could not be tested because the numeracy test was removed to shorten the study."));
C.push(P("**Reliance follows the displayed number.** In the calibrated group, students were more likely to follow the AI when its displayed confidence was higher in V2 (numeric, p = .028) and V4 (visual, p = .032), but not clearly in V3 or V5. In the overconfident group almost every confidence value was above 90%, so this slope could not be estimated reliably."));
C.push(P(`**Display preference.** Asked which display was most useful, students chose ${BPREF.slice().sort((a, b) => b.n_most_useful - a.n_most_useful).map((r) => `${r.display} (${r.n_most_useful})`).join(", ")}. The guidance display was the most popular, the dot display (V4) the least, even though V4 was predicted to support reliance best. Open comments mostly said that students trusted their own judgement and saw AI as “just a tool”.`));
C.push(...fig(FIGB("B_fig7_display_preference.png"), 400, "Figure B4. Number of participants who chose each display as the most useful (n = 33)."));
C.push(P("**Robustness.** Re-running the analysis with all 42 finishers (keeping the 9 who failed a comprehension check) gave the same conclusions: the trust interaction remained significant (p = .037) and all other tests remained non-significant."));

// ===== 5 =====
C.push(H1("5. Comparison with Existing Research"));
C.push(H2("5.1 Model accuracy — Phase 2 Paper 4"));
C.push(P("Paper 4 (Hao et al., 2026, _Scientific Reports_) is the only paper in our comparison table that also uses CIFAR-10 and reports model accuracy. Its Figure 12 compares the accuracy of its proposed method with five other methods."));
C.push(table(["Study", "Method", "Dataset", "Accuracy"], P4.map((r) => [
  r.study.replace("Phase 2 Paper 4 (Hao et al., 2026)", "Paper 4 (Hao et al., 2026), Figure 12"), r.method, r.dataset,
  r.accuracy_sd ? `${pc(r.accuracy, 1)} ± ${pc(r.accuracy_sd, 1)}` : pc(r.accuracy, 1)]), [30, 38, 16, 16]));
C.push(GAP());
C.push(P("Our model is about 4 percentage points more accurate than Paper 4’s best method. This comparison has clear limits. Paper 4’s values are model accuracies read from its figure, not results of its human-participant experiment. The models and training set-ups differ: our ResNet-18 is pretrained on ImageNet and fine-tuned at 224 px. The comparison only shows that our AI is a realistic, strong classifier. That matters because its errors are rare and hard, which is the situation in which overconfidence is most dangerous."));
C.push(H2("5.2 Human reliance — Papers 2 and 9 and Too Sure for Our Own Good"));
C.push(P("The Part A results already agree with the main premise taken from Phase 1. In Too Sure for Our Own Good, high stated confidence made people accept wrong advice. Here, sharpening raises the share of errors shown with at least 80% confidence from about one third to more than four fifths, without changing a single answer of the AI."));
C.push(table(["Measure", "Earlier study", "This study"], [
  ["Agreement with wrong advice on hard errors", "Paper 2, Exp. 1: 87% without and 61% with weakness information", "V1 (label only): 7% (n = 14 errors); V5 (guidance): 13% (n = 15)"],
  ["Reliance at the highest stated confidence", "Paper 9: 82.65% at 100% certainty", "V2: 84% when ≥ 91.5% was shown (n = 147 trials)"],
  ["Calibrated vs overconfident AI", "Too Sure for Our Own Good: high stated confidence → more acceptance of wrong advice", "Confidently wrong advice accepted 16% (calibrated) vs 23% (overconfident), V2–V5; not significant"],
], [28, 36, 36]));
C.push(CAP("Table B2. Part B results next to the earlier studies in the Phase 2 comparison table."));
C.push(P("Three points stand out. First, students in our study accepted far fewer AI errors than participants in Paper 2 (7–13% vs 61–87%). The most likely reason is the task: Paper 2 used a simulated medical detection task where people depend on the AI, while most of our pictures could be recognised without help. Because acceptance was already low, there was little room for guidance to lower it further, which also explains why V5 was not better than V1 here. Second, reliance at the highest displayed confidence (84%) was almost the same as Paper 9’s 82.65% at 100% certainty, even though the tasks differ. The lower confidence bins had too few trials in our data for a fair comparison. Third, the overconfident AI led to slightly more acceptance of wrong advice, in the direction reported by Too Sure for Our Own Good, but the effect was much weaker and not significant. The clearest agreement with that study is in trust: users noticed the overconfident AI’s confident mistakes after feedback and trusted it less over time (H4)."));

// ===== 6 =====
C.push(H1("6. Ablation Studies"));
C.push(H2("6.1 Part A ablations"));
C.push(P("Each ablation removes or changes one component and re-evaluates the seed-0 model on the 10,000 test images."));
const abRows = [
  ["− Temperature scaling", "Uncalibrated softmax (T=1)", A("Temperature scaling", "Uncalibrated softmax (T=1)")],
  ["", "Temperature-scaled (T*)", A("Temperature scaling", "Temperature-scaled (T*)")],
  ["Degree of overconfidence", "T*", A("Degree of overconfidence", "T*")],
  ["", "T*/2", A("Degree of overconfidence", "T*/2")],
  ["", "T*/4", A("Degree of overconfidence", "T*/4")],
  ["− Information about alternatives", "Top-1 confidence", A("Information about alternatives", "Top-1 confidence")],
  ["", "Top-1 minus top-2 margin", A("Information about alternatives", "Top-1 minus top-2 margin")],
  ["", "Negative entropy (10 classes)", A("Information about alternatives", "Negative entropy (all 10 classes)")],
  ["− MC dropout", "Single stochastic pass", A("MC dropout", "Single stochastic pass")],
  ["", "30-pass MC dropout", A("MC dropout", "30-pass MC dropout")],
  ["− Data augmentation", "With augmentation (T*)", A("Data augmentation", "With augmentation (T*)")],
  ["", "Without augmentation (T*)", A("Data augmentation", "Without augmentation (T*)")],
].map(([a, v, r]) => [a, v, pc(r.accuracy, 2), f4(r.ece), f4(r.brier), f4(r.auroc), pc(r.confident_error_rate)]);
C.push(table(["Ablation", "Variant", "Accuracy", "ECE", "Brier", "AUROC", "Conf.-error rate"], abRows, [22, 24, 11, 10, 10, 10, 13]));
C.push(CAP("Table 2. Part A ablations (seed 0, test set)."));
C.push(...fig(FIG("fig6_ablation_overconfidence.png"), 600, "Figure 8. Degree of overconfidence: ECE, confident-error rate and AUROC for T*, T*/2 and T*/4 (seed 0)."));
C.push(B(`**− Temperature scaling:** calibration cut ECE from ${f4(A("Temperature scaling", "Uncalibrated softmax (T=1)").ece)} to ${f4(A("Temperature scaling", "Temperature-scaled (T*)").ece)} and confident errors from ${pc(A("Temperature scaling", "Uncalibrated softmax (T=1)").confident_error_rate)} to ${pc(A("Temperature scaling", "Temperature-scaled (T*)").confident_error_rate)}, with no change in accuracy.`));
C.push(B(`**Degree of overconfidence:** halving the temperature already pushed confident errors from ${pc(A("Degree of overconfidence", "T*").confident_error_rate)} to ${pc(A("Degree of overconfidence", "T*/2").confident_error_rate)}; T*/4 reached ${pc(A("Degree of overconfidence", "T*/4").confident_error_rate)}. AUROC stayed the same at T*/2 and dropped only at T*/4 (${f3(A("Degree of overconfidence", "T*/4").auroc)}). Even moderate inflation makes most errors look confident.`));
C.push(B(`**− Information about alternatives:** the top-1 minus top-2 margin detected errors marginally better than top-1 confidence (AUROC ${f4(A("Information about alternatives", "Top-1 minus top-2 margin").auroc)} vs ${f4(A("Information about alternatives", "Top-1 confidence").auroc)}), and entropy slightly worse (${f4(A("Information about alternatives", "Negative entropy (all 10 classes)").auroc)}). Showing alternatives (the top-3 bars in V4/V5) carries about the same error signal as the top-1 value, so any V4 benefit in Part B would come from the visual form, not from extra information.`));
C.push(B(`**− MC dropout:** 30 passes improved on a single stochastic pass (ECE ${f4(A("MC dropout", "Single stochastic pass").ece)} → ${f4(A("MC dropout", "30-pass MC dropout").ece)}; AUROC ${f4(A("MC dropout", "Single stochastic pass").auroc)} → ${f4(A("MC dropout", "30-pass MC dropout").auroc)}) but remained far less calibrated than temperature scaling, which needs only one pass and one fitted number.`));
C.push(B(`**− Data augmentation:** without augmentation accuracy fell from ${pc(A("Data augmentation", "With augmentation (T*)").accuracy, 2)} to ${pc(A("Data augmentation", "Without augmentation (T*)").accuracy, 2)} and the Brier score worsened (${f4(A("Data augmentation", "With augmentation (T*)").brier)} → ${f4(A("Data augmentation", "Without augmentation (T*)").brier)}); after temperature scaling both models were similarly well calibrated.`));
C.push(H2("6.2 Guidance coverage"));
C.push(P(`The three guidance rules together flag **${pc(COV[0].share_of_test_errors_flagged)}** of the AI’s test-set errors, but also **${pc(COV[0].share_of_correct_flagged)}** of its correct answers. The guidance is therefore informative (errors are about twice as likely to be flagged) but not a perfect error detector, which is why the panel says it does not mean the particular answer is wrong. Removing any single rule leaves coverage unchanged, because the rules overlap: “telling a cat from a dog” applies whenever the AI answers cat or dog, which already includes the other two rules. In practice the guidance warns about one weakness: the cat–dog confusion.`));
C.push(H2("6.3 Part B ablations"));
C.push(P("The three planned Part B ablations compare each participant’s own rounds (Table B3). None was significant after Holm correction. The odds ratios are very imprecise because AI errors are only 1 in 5 trials and were accepted rarely, so several cells contain almost no accepted errors."));
C.push(table(["Ablation", "Comparison", "Outcome", "Result"], [
  ["− Guidance", "V5 vs V4", "Appropriate reliance; error detection", "No difference (Holm p = 1.00 for both)"],
  ["− Visual encoding", "V4 vs V2", "Appropriate reliance; error detection", "No difference (error detection OR = 2.0, 95% CI 0.3–12.4; Holm p = 1.00)"],
  ["− Confidence information", "mean of V2–V5 vs V1", "Appropriate reliance; error detection", "No difference (Holm p = 1.00 for both)"],
], [20, 20, 28, 32]));
C.push(CAP("Table B3. Part B ablations (contrasts from the trial-level GLMMs, n = 33)."));
C.push(P("Taken together with Part A, the ablations show that the AI’s numbers changed a lot (Part A) while student behaviour changed little (Part B). With a task this easy for humans, removing the guidance, the visual encoding or the confidence value did not measurably change how often students caught the AI’s errors."));

// ===== 7 =====
C.push(H1("7. Discussion"));
C.push(H2("7.1 What Part A shows"));
C.push(P("Part A answers RQ4 and supports H6. The same model can look honest or overconfident depending only on how its probabilities are scaled. With temperature scaling its confidence matches its accuracy closely (ECE 0.005). With sharpening, more than four in five of its mistakes are presented with at least 80% confidence. The ranking of its confidence values hardly changes (AUROC 0.951 vs 0.932), so a standard ranking metric would rate both versions as almost equally good at flagging errors. The difference lies in what the numbers say, and that is what a user sees. This is the central reason for Part B: if users read the displayed value at face value, an overconfident AI removes the warning on most of its errors, and the display design must work even in that case."));
C.push(P("Part A also shows where the danger is greatest. The AI’s errors are rare (3.6%), concentrated in a few confusions (especially cat ↔ dog), and mostly on images that humans also find hard (84%). Its confidence follows human difficulty only moderately (ρ ≈ 0.35). So users cannot rely on spotting the AI’s errors themselves, nor on the confidence value alone when it is inflated. This motivates testing a guidance panel (V5) whose warning does not depend on the confidence value."));
C.push(H2("7.2 What Part B shows"));
C.push(P("**RQ1 and RQ2 (which display helps).** With these students and this task, no display clearly improved error detection or appropriate reliance over the others, and the label-only display (V1) was not worse. The reason is visible in the data: students were right on 88% of pictures on their own and rejected about 80% of the AI’s errors overall (64–88% across displays and groups), so behaviour was close to the ceiling. The one trend in the predicted direction was in the overconfident group, where acceptance of confidently wrong advice fell from V2 (36%) to V5 (13%); a larger study would be needed to confirm it."));
C.push(P("**RQ3 (trust after confident mistakes).** This is the clearest result. Even though both versions of the AI were equally accurate, students who saw the overconfident AI trusted it less after each round’s feedback, while trust in the honest AI stayed stable or rose (H4 supported). Students therefore did punish confident mistakes once they saw them, but this did not translate into catching more errors during the task. Metacognition did not moderate display effects (H5 not supported)."));
C.push(P("**RQ4 (Part A).** The same model can look honest or overconfident depending only on how its probabilities are scaled, and ranking metrics hide this (H6 supported; Section 7.1)."));
C.push(P("**Design guidelines from this study.** (1) Show calibrated confidence: an inflated value buys no extra reliance and costs trust once users see the mistakes. (2) Give users feedback on the AI’s past mistakes, because this is what made trust adjust. (3) Guidance about known weaknesses was the display students preferred, so it is a promising format, but its benefit must be tested on tasks where humans genuinely need the AI. (4) Plain numbers (V2) were followed in line with the displayed value when the AI was calibrated, so a simple percentage is a reasonable default."));
C.push(H2("7.3 Limitations"));
[ "**One dataset and one model.** CIFAR-10 is a controlled, low-stakes task with everyday objects; results may differ for expert tasks or other model types.",
  "**Artificial overconfidence.** The overconfident version is created by sharpening the probabilities. This is a controlled manipulation that keeps every answer identical, but real overconfident models may also differ in which images they are confident about.",
  "**Weak guidance rules.** Only one weakness (“answers cat”) reached the planned 2× error rate, so the V5 panel uses the fallback rule and effectively names one confusion (cat ↔ dog). It covers 40% of errors but also flags 19% of correct answers.",
  "**Comparison with Paper 4.** That comparison uses model accuracies from a figure, with different models and training set-ups, so it is context rather than a benchmark.",
  "**Part B changes.** To make online participation realistic, the study was shortened to 25 pictures and the numeracy test was removed. Each display now has one AI error per participant, so per-person estimates are coarse and more participants are needed; H5 is tested with metacognition only. The sample is students from one university, recruited voluntarily and without supervision.",
  "**Small sample and ceiling effects.** Only 33 participants were analysed (power only for large effects), and students were already accurate on their own (88%), so displays had little room to change behaviour. A task where humans need the AI more (for example harder or noisier images) would be a fairer test of H1–H3.",
  "**Exclusions and uneven groups.** 9 of 42 finishers (21%) failed a comprehension check twice, which suggests that some display explanations were not clear enough. Because many people opened the link without finishing, the groups ended up uneven (19 vs 23 finishers; 17 vs 16 after exclusions), and the overconfident group happened to be less accurate on its own (85% vs 90% of first answers).",
].forEach((t) => C.push(B(t)));

const doc = new Document({
  creator: "Adina Ahmad and Khadija Bhatti",
  title: "Phase 3 — Implementation and Evaluation",
  styles: {
    default: { document: { run: { font: "Calibri", size: 24, color: "000000" } } },
    paragraphStyles: [
      { id: "Title", name: "Title", basedOn: "Normal", next: "Normal", run: { font: "Calibri", size: 32, bold: true, color: "000000" },
        paragraph: { spacing: { before: 120, after: 120 }, keepNext: true } },
      { id: "Heading1", name: "Heading 1", basedOn: "Normal", next: "Normal", quickFormat: true,
        run: { font: "Calibri", size: 28, bold: true, color: "000000" }, paragraph: { spacing: { before: 300, after: 140 }, keepNext: true, outlineLevel: 0 } },
      { id: "Heading2", name: "Heading 2", basedOn: "Normal", next: "Normal", quickFormat: true,
        run: { font: "Calibri", size: 26, bold: true, color: "000000" }, paragraph: { spacing: { before: 220, after: 100 }, keepNext: true, outlineLevel: 1 } },
      { id: "Heading3", name: "Heading 3", basedOn: "Normal", next: "Normal", quickFormat: true,
        run: { font: "Calibri", size: 24, bold: true, color: "000000" }, paragraph: { spacing: { before: 160, after: 60 }, keepNext: true, outlineLevel: 2 } },
    ],
  },
  numbering: { config: [{ reference: "bullets", levels: [{ level: 0, format: LevelFormat.BULLET, text: "•", alignment: AlignmentType.LEFT,
    style: { paragraph: { indent: { left: 540, hanging: 270 } } } }] }] },
  sections: [{ properties: { page: { size: { width: 11906, height: 16838 }, margin: { top: 1080, bottom: 1080, left: 1080, right: 1080 } } },
               children: C }],
});
Packer.toBuffer(doc).then((b) => { fs.writeFileSync(OUT, b); console.log("wrote", OUT); });
