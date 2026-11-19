# Additional checks reported in the paper (run after analysis_partB.R).
# Usage: Rscript partB/analysis/robustness_checks.R partB/results partB/experiment/stimuli/stimuli.json
suppressPackageStartupMessages({library(lme4); library(lmerTest); library(dplyr); library(readr); library(emmeans); library(jsonlite)})
args <- commandArgs(TRUE); RES <- args[1]; STIM <- args[2]
tab <- function(f) read_csv(file.path(RES, "tables", f), show_col_types = FALSE)
tr <- tab("B01_trial_level_data.csv")
st <- fromJSON(STIM)$trials
conf <- bind_rows(tibble(test_idx = st$test_idx, calibration = "calibrated", conf = st$calibrated$conf),
                  tibble(test_idx = st$test_idx, calibration = "overconfident", conf = st$overconfident$conf)) %>% distinct()
tr <- tr %>% left_join(conf, by = c("test_idx", "calibration")) %>% mutate(follow = as.integer(follow_ai))

cat("\n1. Acceptance of wrong advice on the same error images (V2-V5)\n")
print(tr %>% filter(!ai_correct, display != "V1") %>% group_by(calibration) %>%
        summarise(trials = n(), accepted = mean(final_label == ai_label)))

cat("\n2. Reliance-confidence slope in the calibrated group, without and with AI correctness (V1 = confidence hidden)\n")
for (d in c("V1", "V2", "V3", "V4", "V5")) {
  x <- tr %>% filter(calibration == "calibrated", display == d) %>% mutate(cc = conf - mean(conf))
  a <- coef(summary(glm(follow ~ cc, data = x, family = binomial)))["cc", ]
  b <- coef(summary(glm(follow ~ cc + ai_correct, data = x, family = binomial)))["cc", ]
  cat(sprintf("%s  slope %.2f (p = %.4f) | controlling for AI correctness: %.2f (p = %.3f)\n", d, a[1], a[4], b[1], b[4]))
}

cat("\n3. H4 with each participant's initial accuracy as a covariate\n")
tb <- tab("B11_trust_by_block.csv") %>%
  left_join(tr %>% group_by(pid) %>% summarise(init_acc = mean(initial_correct)), by = "pid") %>%
  mutate(init_acc_c = init_acc - mean(init_acc))
for (f in c(trust ~ calibration * block_pos + display + init_acc_c + (1 | pid),
            trust ~ calibration * block_pos + display + init_acc_c * block_pos + (1 | pid))) {
  m <- lmer(f, data = tb); a <- anova(m); print(a["calibration:block_pos", ])
  print(summary(emtrends(m, ~ calibration, var = "block_pos"), infer = TRUE))
}

cat("\n4. Trust change after rounds whose AI error was shown without (V1) or with (V2-V5) confidence\n")
tc <- tb %>% left_join(tab("B03_person_level.csv") %>% select(pid, trust_baseline), by = "pid") %>%
  arrange(pid, block_pos) %>% group_by(pid) %>%
  mutate(change = trust - lag(trust, default = first(trust_baseline))) %>% ungroup() %>%
  mutate(shown = ifelse(display == "V1", "V1 (hidden)", "V2-V5 (shown)"))
print(tc %>% group_by(calibration, shown) %>% summarise(rounds = n(), mean_change = mean(change), .groups = "drop"))
m <- lmer(change ~ calibration * shown + block_pos + (1 | pid), data = tc)
print(summary(contrast(emmeans(m, ~ shown | calibration), "revpairwise"), infer = TRUE))
