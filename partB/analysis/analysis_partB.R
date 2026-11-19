# =====================================================================================
# Part B analysis — Designing for Skepticism (Phase 2 methodology, Steps 3b, 8, 9, 10, 11)
# Usage:  Rscript analysis_partB.R <folder_with_participant_csvs> <output_folder>
# Input:  one *_final.csv file per participant, as saved by the jsPsych experiment
# Output: tables (CSV), figures (PNG) and summary.txt in <output_folder>
# Packages: lme4, afex, emmeans, ggplot2, dplyr, tidyr, readr, purrr, jsonlite, pwr
# =====================================================================================
suppressPackageStartupMessages({
  library(dplyr); library(tidyr); library(readr); library(purrr); library(ggplot2)
  library(jsonlite); library(lme4); library(afex); library(emmeans); library(pwr)
})
options(dplyr.summarise.inform = FALSE, warn = 1)
set.seed(2026)
args <- commandArgs(trailingOnly = TRUE)
in_dir  <- ifelse(length(args) >= 1, args[1], "data")
out_dir <- ifelse(length(args) >= 2, args[2], "results_partB")
dir.create(file.path(out_dir, "figures"), recursive = TRUE, showWarnings = FALSE)
dir.create(file.path(out_dir, "tables"),  recursive = TRUE, showWarnings = FALSE)
tab <- function(x, name) write_csv(x, file.path(out_dir, "tables", paste0(name, ".csv")))
log_lines <- c()
say <- function(...) { s <- paste0(...); message(s); log_lines <<- c(log_lines, s) }
OI <- c(calibrated = "#0072B2", overconfident = "#E69F00")          # Okabe–Ito
DISPLAYS <- c("V1", "V2", "V3", "V4", "V5")
CONF_THRESHOLD <- 0.80
BLOCK_AI_ACC <- 0.80

# ---------------------------------------------------------------- 1. Read data
files <- list.files(in_dir, pattern = "_final\\.csv$", full.names = TRUE)
stopifnot(length(files) > 0)
raw <- map_dfr(files, ~ read_csv(.x, col_types = cols(.default = col_character()), show_col_types = FALSE) %>%
                 mutate(source_file = basename(.x)))
num <- function(x) suppressWarnings(as.numeric(x))
lgl <- function(x) toupper(x) %in% c("TRUE", "1")
raw <- raw %>% mutate(pid = as.integer(num(pid)), block_pos = num(block_pos), rt = num(rt))
# Pilot sessions are never analysed: offline participant numbers 900-999 (README B2), or online runs started with
# ?pilot=1 (column pilot = TRUE, file name starting with PILOT_). Online participant ids are random 6-digit numbers.
col_or <- function(df, nm, default) if (nm %in% names(df)) df[[nm]] else rep(default, nrow(df))
raw <- raw %>% mutate(is_pilot = (!is.na(pid) & pid >= 900 & pid <= 999) | lgl(col_or(raw, "pilot", "false")) |
                        startsWith(source_file, "PILOT_"))
pilot_ids <- sort(unique(raw$pid[raw$is_pilot]))
if (length(pilot_ids) > 0) message("Pilot participants ignored: ", paste(pilot_ids, collapse = ", "))
raw <- raw %>% filter(!is_pilot) %>% select(-is_pilot)
stopifnot(nrow(raw) > 0)
TEST_DATA <- any(lgl(col_or(raw, "stimuli_smoke_test", "false"))) || any(col_or(raw, "session", "") == "TEST", na.rm = TRUE) ||
  any(lgl(col_or(raw, "bot_test", "false")))
TAG <- if (TEST_DATA) "  [PIPELINE TEST DATA - NOT RESULTS]" else ""
if (TEST_DATA) say("WARNING: input contains test data (bot participants and/or demo stimuli). Outputs are NOT results.")
say("Files read: ", length(files), "; participants: ", n_distinct(raw$pid))

# ---------------------------------------------------------------- 2. Exclusions (Step 3b)
comp <- raw %>% filter(task == "comprehension") %>%
  mutate(attempt = num(attempt), comp_correct = lgl(comp_correct))
comp_fail <- comp %>% group_by(pid, display) %>% summarise(failed_twice = any(attempt == 2 & !comp_correct)) %>%
  group_by(pid) %>% summarise(failed_twice = any(failed_twice))
# Expected number of trials: 25 in the short version (README decision 20; recorded as n_conditions = 20), otherwise 50.
raw <- raw %>% mutate(n_expected = if_else(col_or(raw, "n_conditions", "") == "20", 25, 50))
finished <- raw %>% group_by(pid) %>% summarise(n_trials = sum(task == "trial_final"), n_expected = first(n_expected),
                                                debrief = any(task == "debrief"))
excl <- finished %>% left_join(comp_fail, by = "pid") %>%
  mutate(failed_twice = coalesce(failed_twice, FALSE),
         exclude = failed_twice | n_trials < n_expected | !debrief,
         reason = case_when(failed_twice ~ "failed a comprehension check twice", n_trials < n_expected | !debrief ~ "did not finish", TRUE ~ ""))
tab(excl, "B00_participant_exclusions")
keep_ids <- excl$pid[!excl$exclude]
say("Participants excluded: ", sum(excl$exclude), " (", paste(names(table(excl$reason[excl$exclude])), table(excl$reason[excl$exclude]), sep = ": ", collapse = "; "), ")")

if (!"final_conf" %in% names(raw)) raw$final_conf <- NA_character_      # not asked in the short version (decision 20)
tr <- raw %>% filter(task == "trial_final", pid %in% keep_ids) %>%
  transmute(pid, calibration = factor(calibration, c("calibrated", "overconfident")),
            display = factor(display, DISPLAYS), block_pos, image_set = num(image_set), test_idx = num(test_idx),
            true_label, ai_label, ai_correct = lgl(ai_correct), difficulty = factor(difficulty, c("easy", "hard")),
            initial_label, final_label, initial_conf = num(initial_conf), final_conf = num(final_conf),
            initial_correct = lgl(initial_correct), final_correct = lgl(final_correct),
            follow_ai = lgl(follow_ai), switched = lgl(switched), displayed_conf = num(displayed_conf),
            rt_initial = num(rt_initial), rt_final = num(rt_final),
            guidance_warned = !is.na(guidance_rules_matched) & guidance_rules_matched != "")
# RT exclusions: < 300 ms or > participant mean + 3 SD (either response)
tr <- tr %>% group_by(pid) %>%
  mutate(lim_i = mean(rt_initial) + 3 * sd(rt_initial), lim_f = mean(rt_final) + 3 * sd(rt_final),
         rt_ok = rt_initial >= 300 & rt_final >= 300 & rt_initial <= lim_i & rt_final <= lim_f) %>% ungroup()
say("Trials removed for response time: ", sum(!tr$rt_ok), " of ", nrow(tr))
tr <- tr %>% filter(rt_ok) %>% select(-lim_i, -lim_f, -rt_ok) %>%
  mutate(appropriate = follow_ai == ai_correct,                 # follow when AI right, do not follow when AI wrong
         confident_shown = !is.na(displayed_conf) & displayed_conf >= CONF_THRESHOLD,
         rt_s = rt_final / 1000)
tab(tr, "B01_trial_level_data")

# ---------------------------------------------------------------- 3. Questionnaires and person-level features
parse_resp <- function(df) map_dfr(seq_len(nrow(df)), function(i) as_tibble(fromJSON(df$response[i])) %>% mutate(pid = df$pid[i]))
cronbach <- function(m) { m <- as.matrix(m); k <- ncol(m); k / (k - 1) * (1 - sum(apply(m, 2, var)) / var(rowSums(m))) }
# The attitude questionnaires (GAAIS, Trust in Automation) exist only in the full version; the short version
# (README decision 20) leaves them out, and then the reliability table and these columns are skipped.
has_gaais <- any(raw$task == "gaais"); has_tia <- any(raw$task == "tia")
rel <- tibble(scale = character(), alpha = numeric())
if (has_gaais) {
  gaais <- parse_resp(raw %>% filter(task == "gaais", pid %in% keep_ids)) %>% mutate(across(starts_with("gaais"), ~ as.numeric(.x) + 1))
  gaais <- gaais %>% mutate(across(all_of(paste0("gaais", 13:20)), ~ 6 - .x))                 # reverse negative subscale
  rel <- bind_rows(rel, tibble(scale = c("GAAIS (20 items)", "GAAIS positive (12)", "GAAIS negative (8, reversed)"),
                   alpha = c(cronbach(select(gaais, paste0("gaais", 1:20))), cronbach(select(gaais, paste0("gaais", 1:12))),
                             cronbach(select(gaais, paste0("gaais", 13:20))))))
}
if (has_tia) {
  tia <- parse_resp(raw %>% filter(task == "tia", pid %in% keep_ids)) %>% mutate(across(starts_with("tia"), ~ as.numeric(.x) + 1))
  tia <- tia %>% mutate(across(all_of(paste0("tia", 1:5)), ~ 8 - .x))                         # reverse distrust items
  rel <- bind_rows(rel, tibble(scale = "Trust in Automation (12)", alpha = cronbach(select(tia, paste0("tia", 1:12)))))
}
if (nrow(rel) > 0) tab(rel, "B02_scale_reliability")
demo <- parse_resp(raw %>% filter(task == "demographics", pid %in% keep_ids))
if (!"programme" %in% names(demo)) demo$programme <- NA_character_          # not asked in the short version
if (!"bnt_score" %in% names(raw)) raw$bnt_score <- NA_character_     # no numeracy test in the easy version (decision 21)
person <- tibble(pid = keep_ids) %>%
  left_join(raw %>% filter(task == "setup") %>% distinct(pid, calibration, latin_order, display_order), by = "pid") %>%
  left_join(raw %>% filter(task == "bnt") %>% transmute(pid, numeracy = num(bnt_score)), by = "pid") %>%
  left_join(raw %>% filter(task == "trust_baseline") %>% transmute(pid, trust_baseline = num(trust)), by = "pid") %>%
  left_join(demo %>% transmute(pid, age = as.numeric(age), gender, programme, ai_use), by = "pid")
# Metacognitive sensitivity: type-2 AUROC of initial confidence for initial correctness (all trials)
auroc2 <- function(conf, correct) {
  if (length(unique(correct)) < 2) return(NA_real_)
  r <- rank(conf); n1 <- sum(correct); n0 <- sum(!correct)
  (sum(r[correct]) - n1 * (n1 + 1) / 2) / (n1 * n0)
}
person <- person %>% left_join(tr %>% group_by(pid) %>% summarise(metacog_auroc2 = auroc2(initial_conf, initial_correct)), by = "pid")
if (has_gaais) person <- person %>% left_join(gaais %>% transmute(pid, gaais = rowMeans(across(paste0("gaais", 1:20)))), by = "pid")
if (has_tia) person <- person %>% left_join(tia %>% transmute(pid, tia_post = rowMeans(across(paste0("tia", 1:12)))), by = "pid")
tab(person, "B03_person_level")
if (nrow(rel) > 0) say("Scale reliability (alpha): ", paste(sprintf("%s = %.2f", rel$scale, rel$alpha), collapse = "; "))

# ---------------------------------------------------------------- 4. Metrics per participant x display (Step 8)
safe_mean <- function(x) if (length(x) == 0) NA_real_ else mean(x)
pm <- tr %>% group_by(pid, calibration, display) %>% summarise(
  error_detection = safe_mean(!follow_ai[!ai_correct]),
  confident_error_acceptance = safe_mean(follow_ai[!ai_correct & confident_shown]),
  rair = safe_mean(follow_ai[!initial_correct & ai_correct]),
  rsr = safe_mean((final_label == initial_label)[initial_correct & !ai_correct]),
  final_accuracy = mean(final_correct), human_alone_accuracy = mean(initial_correct),
  appropriate_reliance = mean(appropriate), mean_rt_s = mean(rt_s)) %>%
  mutate(complementarity = final_accuracy - pmax(human_alone_accuracy, BLOCK_AI_ACC)) %>% ungroup()
tab(pm, "B04_metrics_participant_by_display")
desc <- pm %>% group_by(calibration, display) %>%
  summarise(across(c(error_detection, confident_error_acceptance, rair, rsr, final_accuracy, complementarity,
                     appropriate_reliance, mean_rt_s), list(mean = ~ mean(.x, na.rm = TRUE), sd = ~ sd(.x, na.rm = TRUE))), n = n())
tab(desc, "B05_metrics_descriptives")

# ---------------------------------------------------------------- 5. Trial-level GLMMs (Step 9)
ctrl <- glmerControl(optimizer = "bobyqa", optCtrl = list(maxfun = 2e5))
# Numerical safety net: if the standard fit fails, retry with another optimiser, then with the faster
# Laplace-free approximation (nAGQ = 0). The model formula is never changed; the method used is logged.
safe_glmer <- function(formula, data, name) {
  tries <- list(list(ctrl = ctrl, nAGQ = 1, lab = "bobyqa"),
                list(ctrl = glmerControl(optimizer = "Nelder_Mead", optCtrl = list(maxfun = 2e5)), nAGQ = 1, lab = "Nelder-Mead"),
                list(ctrl = ctrl, nAGQ = 0, lab = "nAGQ = 0 approximation"))
  for (t in tries) {
    m <- tryCatch(glmer(formula, data = data, family = binomial, control = t$ctrl, nAGQ = t$nAGQ), error = function(e) NULL)
    if (!is.null(m)) { if (t$lab != "bobyqa") say(name, ": standard fit failed numerically; fitted with ", t$lab); return(m) }
  }
  stop(name, ": model could not be fitted with any optimiser")
}
fit_glmm <- function(formula_slope, formula_simple, data, name) {
  m <- tryCatch(glmer(formula_slope, data = data, family = binomial, control = ctrl), error = function(e) NULL)
  ok <- !is.null(m) && is.null(m@optinfo$conv$lme4$messages) && !isSingular(m)
  if (!ok) { m <- safe_glmer(formula_simple, data, name); used <- "random intercepts" }
  else used <- "random intercepts + slope for AI correctness"
  say(name, ": fitted with ", used)
  m
}
tr <- tr %>% mutate(block_c = block_pos - 3)
m_follow <- fit_glmm(follow_ai ~ display * calibration * ai_correct * difficulty + block_c + (1 + ai_correct | pid) + (1 | test_idx),
                     follow_ai ~ display * calibration * ai_correct * difficulty + block_c + (1 | pid) + (1 | test_idx), tr, "GLMM follow_AI")
m_appr <- fit_glmm(appropriate ~ display * calibration * ai_correct * difficulty + block_c + (1 + ai_correct | pid) + (1 | test_idx),
                   appropriate ~ display * calibration * ai_correct * difficulty + block_c + (1 | pid) + (1 | test_idx), tr, "GLMM appropriate reliance")
m_acc <- fit_glmm(final_correct ~ display * calibration * ai_correct * difficulty + block_c + (1 + ai_correct | pid) + (1 | test_idx),
                  final_correct ~ display * calibration * ai_correct * difficulty + block_c + (1 | pid) + (1 | test_idx), tr, "GLMM final accuracy")
err_tr <- tr %>% filter(!ai_correct)
m_detect <- safe_glmer(I(!follow_ai) ~ display * calibration * difficulty + block_c + (1 | pid) + (1 | test_idx),
                       err_tr, "GLMM error detection")
anova_tab <- function(m, name) { a <- car::Anova(m, type = 3); tibble(model = name, term = rownames(a), chisq = a$Chisq, df = a$Df, p = a$`Pr(>Chisq)`) }
glmm_tests <- bind_rows(anova_tab(m_follow, "follow_AI"), anova_tab(m_appr, "appropriate reliance"),
                        anova_tab(m_acc, "final accuracy"), anova_tab(m_detect, "error detection (AI-error trials)"))
tab(glmm_tests, "B06_glmm_type3_tests")

# ---------------------------------------------------------------- 6. Planned contrasts H1–H3 (Holm), odds ratios
emm_follow_err <- emmeans(m_follow, ~ calibration | display * ai_correct * difficulty, type = "response")
# H1: acceptance of wrong advice, overconfident vs calibrated, within each of V2–V5 (averaged over difficulty)
em_h1 <- emmeans(m_detect, ~ calibration | display)
h1 <- contrast(em_h1, method = "revpairwise", by = "display", type = "response", adjust = "none") %>% summary(infer = TRUE) %>%
  as_tibble() %>% filter(display %in% c("V2", "V3", "V4", "V5")) %>% mutate(hypothesis = "H1", outcome = "detection of AI errors (odds ratio overconfident / calibrated)")
# H2: appropriate reliance, calibrated group: V4 vs V2 and V4 vs V3, overall and by difficulty
em_h2 <- emmeans(m_appr, ~ display | calibration * difficulty, at = list(calibration = "calibrated"))
h2 <- contrast(em_h2, list("V4 vs V2" = c(0, -1, 0, 1, 0), "V4 vs V3" = c(0, 0, -1, 1, 0)), by = c("calibration", "difficulty"),
               type = "response", adjust = "none") %>% summary(infer = TRUE) %>% as_tibble() %>% mutate(hypothesis = "H2", outcome = "appropriate reliance (odds ratio)")
# H3: acceptance of wrong advice, overconfident group: V5 vs V2, V3, V4, overall and by difficulty
em_h3 <- emmeans(m_detect, ~ display | calibration * difficulty, at = list(calibration = "overconfident"))
h3 <- contrast(em_h3, list("V5 vs V2" = c(0, -1, 0, 0, 1), "V5 vs V3" = c(0, 0, -1, 0, 1), "V5 vs V4" = c(0, 0, 0, -1, 1)),
               by = c("calibration", "difficulty"), type = "response", adjust = "none") %>% summary(infer = TRUE) %>% as_tibble() %>%
  mutate(hypothesis = "H3", outcome = "detection of AI errors (odds ratio)")
contr <- bind_rows(h1, h2, h3) %>% mutate(p_holm = p.adjust(p.value, method = "holm"))
tab(contr, "B07_planned_contrasts_H1_H3")

# ---------------------------------------------------------------- 7. Participant-level mixed ANOVA (display within, calibration between)
mixed_anova <- function(var, displays = DISPLAYS) {
  d <- pm %>% filter(display %in% displays) %>% select(pid, calibration, display, y = all_of(var)) %>% filter(!is.na(y))
  complete <- d %>% count(pid) %>% filter(n == length(displays)) %>% pull(pid)
  d <- d %>% filter(pid %in% complete) %>% mutate(display = droplevels(display), calibration = droplevels(calibration))
  # A metric can exist for one calibration group only (e.g., calibrated participants rarely see an AI error shown at >= 80%,
  # so confident-error acceptance is undefined for them). Then the between-subjects factor is dropped and this is reported.
  n_per_group <- d %>% distinct(pid, calibration) %>% count(calibration)
  use_between <- nrow(n_per_group) == 2 && all(n_per_group$n >= 2)
  if (length(complete) < 3) {
    return(list(anova = tibble(outcome = var, term = NA_character_, note = "too few participants with this metric in every display"),
                nonparam = tibble(outcome = var, test = NA_character_, p = NA_real_)))
  }
  a <- if (use_between) aov_ez("pid", "y", d, within = "display", between = "calibration", anova_table = list(es = "pes")) else
         aov_ez("pid", "y", d, within = "display", anova_table = list(es = "pes"))
  out <- as_tibble(a$anova_table, rownames = "term") %>%
    mutate(outcome = var, note = if (use_between) "display (within) x calibration (between)" else
             paste0("within-subjects only: metric defined for ", paste(levels(d$calibration), collapse = "/"), " group only"))
  # assumption check (normality of residuals) and non-parametric alternatives
  shp <- tryCatch(shapiro.test(residuals(a$lm))$p.value, error = function(e) NA)
  fr <- d %>% group_by(calibration) %>% group_map(~ tryCatch(friedman.test(y ~ display | pid, data = .x)$p.value, error = function(e) NA)) %>% unlist()
  mw <- d %>% group_by(display) %>% summarise(p = tryCatch(wilcox.test(y ~ calibration)$p.value, error = function(e) NA))
  list(anova = out %>% mutate(shapiro_p_residuals = shp, n_participants = length(complete)),
       nonparam = bind_rows(tibble(outcome = var, test = paste0("Friedman (display) in ", levels(d$calibration)), p = fr),
                            mw %>% transmute(outcome = var, test = paste0("Mann-Whitney (calibration) in ", display), p)))
}
anovas <- list(mixed_anova("rair"), mixed_anova("rsr"), mixed_anova("confident_error_acceptance", c("V2", "V3", "V4", "V5")),
               mixed_anova("appropriate_reliance"), mixed_anova("error_detection"))
tab(bind_rows(map(anovas, "anova")), "B08_mixed_anova")
tab(bind_rows(map(anovas, "nonparam")), "B09_nonparametric_alternatives")

# Cohen's d with 95% CI: paired (display contrasts) and independent (calibration contrasts)
d_paired <- function(var, a, b, grp) {
  w <- pm %>% filter(calibration == grp, display %in% c(a, b)) %>% select(pid, display, y = all_of(var)) %>%
    pivot_wider(names_from = display, values_from = y) %>% drop_na()
  diff <- w[[a]] - w[[b]]; n <- length(diff); if (n < 3 || sd(diff) == 0) return(NULL)
  dz <- mean(diff) / sd(diff); se <- sqrt(1 / n + dz^2 / (2 * n))
  tibble(outcome = var, group = grp, comparison = paste(a, "vs", b), n = n, mean_diff = mean(diff), d_z = dz,
         ci_low = dz - 1.96 * se, ci_high = dz + 1.96 * se, p = t.test(diff)$p.value)
}
d_indep <- function(var, disp) {
  w <- pm %>% filter(display == disp) %>% select(calibration, y = all_of(var)) %>% drop_na()
  x <- w$y[w$calibration == "overconfident"]; y <- w$y[w$calibration == "calibrated"]
  if (length(x) < 3 || length(y) < 3) return(NULL)
  sp <- sqrt(((length(x) - 1) * var(x) + (length(y) - 1) * var(y)) / (length(x) + length(y) - 2)); if (sp == 0) return(NULL)
  d <- (mean(x) - mean(y)) / sp; se <- sqrt((length(x) + length(y)) / (length(x) * length(y)) + d^2 / (2 * (length(x) + length(y))))
  tibble(outcome = var, group = "overconfident - calibrated", comparison = disp, n = length(x) + length(y),
         mean_diff = mean(x) - mean(y), d_z = d, ci_low = d - 1.96 * se, ci_high = d + 1.96 * se, p = t.test(x, y)$p.value)
}
eff <- bind_rows(
  map_dfr(c("V2", "V3", "V4", "V5"), ~ d_indep("confident_error_acceptance", .x)),
  d_paired("appropriate_reliance", "V4", "V2", "calibrated"), d_paired("appropriate_reliance", "V4", "V3", "calibrated"),
  d_paired("error_detection", "V5", "V2", "overconfident"), d_paired("error_detection", "V5", "V3", "overconfident"),
  d_paired("error_detection", "V5", "V4", "overconfident")) %>% rename(cohens_d = d_z)
tab(eff, "B10_effect_sizes_cohens_d")

# ---------------------------------------------------------------- 8. Trust dynamics and perceived reliability (H4)
trust <- raw %>% filter(task == "trust_block", pid %in% keep_ids) %>%
  transmute(pid, calibration = factor(calibration, c("calibrated", "overconfident")), display = factor(display, DISPLAYS),
            block_pos, trust = num(trust), est_acc = num(est_acc), block_ai_accuracy = num(block_ai_accuracy)) %>%
  mutate(perceived_gap = abs(est_acc - 100 * block_ai_accuracy))
tab(trust, "B11_trust_by_block")
m_trust <- lmer(trust ~ calibration * block_pos + display + (1 | pid), data = trust)
m_gap <- lmer(perceived_gap ~ calibration * block_pos + display + (1 | pid), data = trust)
trust_tests <- bind_rows(as_tibble(anova(m_trust), rownames = "term") %>% mutate(model = "trust"),
                         as_tibble(anova(m_gap), rownames = "term") %>% mutate(model = "perceived-reliability gap"))
tab(trust_tests, "B12_trust_models")
gap_disp <- contrast(emmeans(m_gap, ~ display), method = "trt.vs.ctrl", ref = "V5", adjust = "holm") %>% summary(infer = TRUE) %>% as_tibble()
tab(gap_disp, "B13_perceived_gap_V5_vs_others")
trust_slope <- summary(emtrends(m_trust, ~ calibration, var = "block_pos"), infer = TRUE) %>% as_tibble()
tab(trust_slope, "B14_trust_slope_by_calibration")

# ---------------------------------------------------------------- 9. Moderation (H5)
# The easy version (README decision 21) has no numeracy test; H5 is then tested with metacognition only.
has_numeracy <- any(!is.na(person$numeracy))
trm <- tr %>% left_join(person %>% select(pid, numeracy, metacog_auroc2), by = "pid") %>%
  mutate(numeracy_z = if (has_numeracy) as.numeric(scale(numeracy)) else NA_real_, metacog_z = as.numeric(scale(metacog_auroc2)))
f_mod <- if (has_numeracy) appropriate ~ display * (numeracy_z + metacog_z) + calibration + ai_correct + (1 | pid) + (1 | test_idx) else
                           appropriate ~ display * metacog_z + calibration + ai_correct + (1 | pid) + (1 | test_idx)
m_mod <- tryCatch(glmer(f_mod, data = trm, family = binomial, control = ctrl), error = function(e) { say("Moderation model failed: ", conditionMessage(e)); NULL })
if (!is.null(m_mod)) tab(anova_tab(m_mod, if (has_numeracy) "appropriate reliance ~ display x (numeracy + metacognition)" else
                                          "appropriate reliance ~ display x metacognition (no numeracy test in the easy version)"), "B15_moderation_H5")

# ---------------------------------------------------------------- 10. Ablations, Part B (Step 10)
em_appr_disp <- emmeans(m_appr, ~ display)
em_det_disp <- emmeans(m_detect, ~ display)
abl <- bind_rows(
  contrast(em_appr_disp, list("- Guidance (V5 vs V4)" = c(0, 0, 0, -1, 1), "- Visual encoding (V4 vs V2)" = c(0, -1, 0, 1, 0),
                              "- Confidence information (mean V2-V5 vs V1)" = c(-1, .25, .25, .25, .25)), type = "response") %>%
    summary(infer = TRUE) %>% as_tibble() %>% mutate(outcome = "appropriate reliance"),
  contrast(em_det_disp, list("- Guidance (V5 vs V4)" = c(0, 0, 0, -1, 1), "- Visual encoding (V4 vs V2)" = c(0, -1, 0, 1, 0),
                             "- Confidence information (mean V2-V5 vs V1)" = c(-1, .25, .25, .25, .25)), type = "response") %>%
    summary(infer = TRUE) %>% as_tibble() %>% mutate(outcome = "error detection")) %>% mutate(p_holm = p.adjust(p.value, "holm"))
tab(abl, "B16_ablations_partB")

# ---------------------------------------------------------------- 11. Reliance-confidence slope (Step 8)
conf_tr <- tr %>% filter(display != "V1") %>% mutate(display = droplevels(display))
# confidence is centred (minus its mean) only for numerical stability; the slope per unit of confidence is unchanged
conf_tr <- conf_tr %>% mutate(conf_c = displayed_conf - mean(displayed_conf))
m_slope <- tryCatch(safe_glmer(follow_ai ~ conf_c * display * calibration + (1 | pid) + (1 | test_idx), conf_tr, "GLMM reliance-confidence slope"),
                    error = function(e) { say("Reliance-confidence slope model could not be fitted (", conditionMessage(e), "); B17 skipped"); NULL })
if (!is.null(m_slope)) {
  slopes <- summary(emtrends(m_slope, ~ display * calibration, var = "conf_c"), infer = TRUE) %>% as_tibble() %>%
    rename(displayed_conf.trend = conf_c.trend)
  tab(slopes, "B17_reliance_confidence_slopes")
}

# ---------------------------------------------------------------- 12. Error / failure analysis (Step 11)
fail <- tr %>% filter(!ai_correct) %>% mutate(conf_bin = cut(displayed_conf, c(0, .5, .8, .9, 1.0001), right = FALSE,
                                                              labels = c("<50%", "50-79%", "80-89%", ">=90%")))
tab(fail %>% group_by(calibration, display, conf_bin, difficulty) %>% summarise(n = n(), accepted = mean(follow_ai)), "B18_accepted_errors_by_bin")
tab(fail %>% group_by(calibration, display, block_pos) %>% summarise(n = n(), accepted = mean(follow_ai)), "B19_accepted_errors_by_block")
tab(tr %>% filter(ai_correct, !follow_ai) %>% count(calibration, display, difficulty, name = "rejected_correct_advice"), "B20_rejected_correct_advice")
tab(fail %>% filter(display == "V5") %>% group_by(calibration, guidance_warned) %>% summarise(n = n(), accepted = mean(follow_ai)),
    "B21_V5_acceptance_when_guidance_warned")
# participant profiles (k-means on RAIR, RSR, trust change)
prof <- pm %>% group_by(pid) %>% summarise(rair = mean(rair, na.rm = TRUE), rsr = mean(rsr, na.rm = TRUE)) %>%
  left_join(trust %>% group_by(pid) %>% summarise(last = trust[which.max(block_pos)]), by = "pid") %>%
  left_join(person %>% select(pid, trust_baseline, numeracy, metacog_auroc2, calibration), by = "pid") %>%
  mutate(trust_change = last - trust_baseline) %>% drop_na(rair, rsr, trust_change)
km <- kmeans(scale(prof[, c("rair", "rsr", "trust_change")]), centers = 3, nstart = 50)
prof$cluster <- factor(km$cluster)
tab(prof, "B22_participant_profiles")
tab(prof %>% group_by(cluster) %>% summarise(n = n(), rair = mean(rair), rsr = mean(rsr), trust_change = mean(trust_change),
                                              numeracy = mean(numeracy, na.rm = TRUE), metacog = mean(metacog_auroc2, na.rm = TRUE),
                                              share_overconfident = mean(calibration == "overconfident")), "B23_profile_summary")
comments <- raw %>% filter(task == "comment", pid %in% keep_ids) %>% transmute(pid, calibration, comment = map_chr(response, ~ fromJSON(.x)$comment %||% ""))
tab(comments %>% filter(comment != ""), "B24_open_comments_for_coding")
# Easy version (decision 21): one tap for the most useful display (column preferred_display); full version: ranking 1-5.
pref_raw <- raw %>% filter(task == "preference", pid %in% keep_ids)
pref_ranked <- !("preferred_display" %in% names(pref_raw)) || all(is.na(pref_raw$preferred_display) | pref_raw$preferred_display == "")
if (pref_ranked) {
  pref <- parse_resp(pref_raw) %>% pivot_longer(starts_with("rank_"), names_to = "display", values_to = "rank") %>%
    mutate(display = sub("rank_", "", display), rank = as.numeric(rank))
  tab(pref %>% group_by(display) %>% summarise(mean_rank = mean(rank), n_ranked_first = sum(rank == 1)), "B25_display_preference")
} else {
  pref <- tibble(display = DISPLAYS) %>% left_join(pref_raw %>% count(display = preferred_display, name = "n_most_useful"), by = "display") %>%
    mutate(n_most_useful = replace_na(n_most_useful, 0L), share = n_most_useful / sum(n_most_useful))
  tab(pref, "B25_display_preference")
}

# ---------------------------------------------------------------- 13. Comparison with existing research (Step 9)
ours_p2 <- tr %>% filter(!ai_correct, difficulty == "hard", display %in% c("V1", "V5")) %>% group_by(display) %>%
  summarise(agreement_with_incorrect = mean(follow_ai), n = n())
v2b <- tr %>% filter(display == "V2") %>% mutate(bin = cut(displayed_conf, c(0, .745, .915, 1.0001), right = FALSE,
                                                             labels = c("~66% (<74.5%)", "~83% (74.5-91.4%)", "~100% (>=91.5%)"))) %>%
  group_by(bin) %>% summarise(reliance = mean(follow_ai), n = n())
compare <- bind_rows(
  tibble(source = "Paper 2 (Exp. 1)", measure = "Agreement with incorrect advice, difficult errors",
         condition = c("without explanations", "with weakness information"), value = c(0.87, 0.61), n = NA,
         note = "simulated medical detection task; weakness information"),
  ours_p2 %>% transmute(source = "This study", measure = "Agreement with incorrect advice, hard errors",
                        condition = ifelse(display == "V1", "V1 label only", "V5 visual + capability guidance"),
                        value = agreement_with_incorrect, n, note = "both calibration groups pooled"),
  tibble(source = "Paper 9", measure = "Reliance by stated numerical certainty", condition = c("66%", "83%", "100%"),
         value = c(0.6449, 0.6761, 0.8265), n = NA, note = "certainty shown as text; classification tasks"),
  v2b %>% transmute(source = "This study", measure = "Reliance by displayed numeric confidence (V2)", condition = as.character(bin),
                    value = reliance, n, note = "both calibration groups pooled"),
  pm %>% filter(display %in% c("V2", "V3", "V4", "V5")) %>% group_by(calibration) %>%
    summarise(value = mean(confident_error_acceptance, na.rm = TRUE), n = n_distinct(pid)) %>%
    transmute(source = "This study", measure = "Acceptance of confidently wrong advice (V2-V5)", condition = as.character(calibration),
              value, n, note = "compare direction with Too Sure for Our Own Good (Phase 1): high confidence -> more acceptance"))
tab(compare, "B26_comparison_with_existing_research")

# ---------------------------------------------------------------- 14. Sensitivity analysis (Step 2)
n_grp <- min(table(person$calibration))
sens <- tibble(design = c("within-subjects display contrast (paired, per group)", "between-groups calibration contrast"),
               n = c(n_grp, n_grp),
               min_effect_80pct_power = c(pwr.t.test(n = n_grp, power = .8, sig.level = .05, type = "paired")$d,
                                          pwr.t.test(n = n_grp, power = .8, sig.level = .05, type = "two.sample")$d),
               effect_metric = c("d_z", "Cohen's d"))
tab(sens, "B27_sensitivity_analysis")

# ---------------------------------------------------------------- 15. Figures (Step 9: visual reporting)
th <- theme_minimal(base_size = 11) + theme(panel.grid.minor = element_blank(), legend.position = "top")
ci <- function(x) { x <- x[!is.na(x)]; m <- mean(x); s <- sd(x) / sqrt(length(x)); c(m = m, lo = m - 1.96 * s, hi = m + 1.96 * s) }
sumci <- function(df, var) df %>% group_by(calibration, display) %>% summarise(m = ci(.data[[var]])["m"], lo = ci(.data[[var]])["lo"], hi = ci(.data[[var]])["hi"])
save_fig <- function(p, name, w = 7, h = 4.2) ggsave(file.path(out_dir, "figures", name), p, width = w, height = h, dpi = 200, bg = "white")

p1 <- ggplot(sumci(pm, "confident_error_acceptance") %>% filter(display != "V1"), aes(display, m, colour = calibration, group = calibration)) +
  geom_point(position = position_dodge(.3), size = 2.5) + geom_errorbar(aes(ymin = pmax(lo, 0), ymax = pmin(hi, 1)), width = .15, position = position_dodge(.3)) +
  geom_line(position = position_dodge(.3)) + scale_colour_manual(values = OI) + scale_y_continuous(labels = scales::percent) + coord_cartesian(ylim = c(0, 1)) +
  labs(x = "Display", y = "Acceptance of confidently wrong advice", colour = NULL, title = paste0("Confident-error acceptance by display (H1, H3)", TAG)) + th
save_fig(p1, "B_fig1_confident_error_acceptance.png")
ar <- tr %>% group_by(pid, calibration, display, difficulty) %>% summarise(y = mean(appropriate)) %>%
  group_by(calibration, display, difficulty) %>% summarise(m = ci(y)["m"], lo = ci(y)["lo"], hi = ci(y)["hi"])
p2 <- ggplot(ar, aes(display, m, colour = calibration, group = calibration)) + facet_wrap(~ difficulty, labeller = label_both) +
  geom_point(position = position_dodge(.3)) + geom_errorbar(aes(ymin = pmax(lo, 0), ymax = pmin(hi, 1)), width = .15, position = position_dodge(.3)) +
  geom_line(position = position_dodge(.3)) + scale_colour_manual(values = OI) + scale_y_continuous(labels = scales::percent) +
  labs(x = "Display", y = "Appropriate reliance", colour = NULL, title = paste0("Appropriate reliance by display and human difficulty (H2)", TAG)) + th
save_fig(p2, "B_fig2_appropriate_reliance.png", 8.5)
tl <- bind_rows(person %>% transmute(pid, calibration, block_pos = 0, trust = trust_baseline), trust %>% select(pid, calibration, block_pos, trust)) %>%
  group_by(calibration, block_pos) %>% summarise(m = ci(trust)["m"], lo = ci(trust)["lo"], hi = ci(trust)["hi"])
p3 <- ggplot(tl, aes(block_pos, m, colour = calibration)) + geom_line() + geom_point() + geom_ribbon(aes(ymin = lo, ymax = hi, fill = calibration), alpha = .15, colour = NA) +
  scale_colour_manual(values = OI) + scale_fill_manual(values = OI, guide = "none") + scale_x_continuous(breaks = 0:5, labels = c("Baseline", 1:5)) +
  labs(x = "Block (after delayed feedback)", y = "Trust in the AI (0-100)", colour = NULL, title = paste0("Trust trajectory (H4)", TAG)) + th
save_fig(p3, "B_fig3_trust_trajectory.png")
gp <- trust %>% group_by(calibration, display) %>% summarise(m = ci(perceived_gap)["m"], lo = ci(perceived_gap)["lo"], hi = ci(perceived_gap)["hi"])
p4 <- ggplot(gp, aes(display, m, fill = calibration)) + geom_col(position = position_dodge(.8), width = .7) +
  geom_errorbar(aes(ymin = lo, ymax = hi), position = position_dodge(.8), width = .2) + scale_fill_manual(values = OI) +
  labs(x = "Display", y = "|estimated - actual AI accuracy| (points)", fill = NULL, title = paste0("Perceived-reliability calibration gap (H4)", TAG)) + th
save_fig(p4, "B_fig4_perceived_reliability_gap.png")
hm <- tr %>% filter(display != "V1") %>% mutate(conf_bin = cut(displayed_conf, c(0, .5, .65, .8, .9, 1.0001), right = FALSE,
                                                                labels = c("<50", "50-64", "65-79", "80-89", "90-100"))) %>%
  group_by(calibration, difficulty, conf_bin) %>% summarise(follow = mean(follow_ai), n = n())
p5 <- ggplot(hm, aes(conf_bin, difficulty, fill = follow)) + geom_tile(colour = "white") + facet_wrap(~ calibration) +
  geom_text(aes(label = sprintf("%.0f%%\nn=%d", 100 * follow, n)), size = 3) + scale_fill_gradient(low = "#F0F4F8", high = "#0072B2", labels = scales::percent) +
  labs(x = "Displayed confidence (%)", y = "Human difficulty", fill = "Followed AI", title = paste0("Reliance heat-map: displayed confidence x difficulty", TAG)) + th
save_fig(p5, "B_fig5_reliance_heatmap.png", 9, 4)
rr <- pm %>% pivot_longer(c(rair, rsr), names_to = "metric") %>% group_by(calibration, display, metric) %>% summarise(m = ci(value)["m"], lo = ci(value)["lo"], hi = ci(value)["hi"])
p6 <- ggplot(rr, aes(display, m, colour = calibration, group = calibration)) + facet_wrap(~ toupper(metric)) +
  geom_point(position = position_dodge(.3)) + geom_errorbar(aes(ymin = lo, ymax = hi), width = .15, position = position_dodge(.3)) +
  scale_colour_manual(values = OI) + scale_y_continuous(labels = scales::percent) + labs(x = "Display", y = NULL, colour = NULL,
  title = paste0("Relative AI reliance (RAIR) and relative self-reliance (RSR)", TAG)) + th
save_fig(p6, "B_fig6_rair_rsr.png", 8.5)
if (pref_ranked) {
  pf <- pref %>% group_by(display) %>% summarise(mean_rank = mean(rank))
  p7 <- ggplot(pf, aes(reorder(display, -mean_rank), mean_rank)) + geom_col(fill = "#0072B2") + coord_flip() +
    labs(x = NULL, y = "Mean preference rank (1 = most useful)", title = paste0("Display preference", TAG)) + th
} else {
  p7 <- ggplot(pref, aes(reorder(display, n_most_useful), n_most_useful)) + geom_col(fill = "#0072B2") + coord_flip() +
    labs(x = NULL, y = "Number of participants who chose it as most useful", title = paste0("Display preference", TAG)) + th
}
save_fig(p7, "B_fig7_display_preference.png", 6, 3.5)

# ---------------------------------------------------------------- 16. Summary
writeLines(c(if (TEST_DATA) "*** PIPELINE TEST DATA - THESE ARE NOT STUDY RESULTS ***" else "Part B analysis summary",
             log_lines, "", capture.output(sessionInfo())[1:3]), file.path(out_dir, "summary.txt"))
say("Done. Tables: ", length(list.files(file.path(out_dir, "tables"))), "; figures: ", length(list.files(file.path(out_dir, "figures"))))
