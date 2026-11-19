/* Advice displays V1–V5 (Phase 2 methodology, Steps 4–6).
   V1 label only · V2 numeric % · V3 categorical (high / medium / low)
   V4 visual uncertainty (top-3 bar chart + 10x10 icon array)
   V5 visual uncertainty + capability-guidance panel
   Colours: Okabe–Ito colour-blind-safe palette; every value is also shown as text. */

const DISPLAY_CODES = ["V1", "V2", "V3", "V4", "V5"];
const DISPLAY_NAMES = {
  V1: "Label only",
  V2: "Numeric confidence",
  V3: "Confidence category",
  V4: "Visual uncertainty",
  V5: "Visual uncertainty + guidance",
};
// V3 thresholds (implementation decision, documented in the Phase 3 report):
// High >= 80% (same threshold the methodology uses for "confident"), Medium 50–79%, Low < 50%.
function confidenceCategory(p) {
  if (p >= 0.8) return "High";
  if (p >= 0.5) return "Medium";
  return "Low";
}
function pct(p) { return Math.round(p * 100); }
function cap(s) { return s.charAt(0).toUpperCase() + s.slice(1); }

function barChartSVG(top3) {
  const w = 300, rowH = 30, labelW = 92, barMax = w - labelW - 46;
  let rows = "";
  top3.forEach((t, i) => {
    const y = i * rowH + 6;
    const bw = Math.max(1, Math.round(t.p * barMax));
    const col = i === 0 ? "#0072B2" : "#9AA5B1";
    rows += `<text x="${labelW - 8}" y="${y + 15}" text-anchor="end" font-size="14" fill="#222">${cap(t.label)}</text>
             <rect x="${labelW}" y="${y}" width="${barMax}" height="20" fill="#EEF1F4" rx="3"></rect>
             <rect x="${labelW}" y="${y}" width="${bw}" height="20" fill="${col}" rx="3"></rect>
             <text x="${labelW + barMax + 6}" y="${y + 15}" font-size="14" fill="#222">${pct(t.p)}%</text>`;
  });
  return `<svg class="bars" width="${w}" height="${3 * rowH + 6}" viewBox="0 0 ${w} ${3 * rowH + 6}" role="img"
           aria-label="Bar chart of the AI's top three answers">${rows}</svg>`;
}

function iconArraySVG(p) {
  const n = pct(p), size = 12, gap = 3;
  let dots = "";
  for (let k = 0; k < 100; k++) {
    const r = Math.floor(k / 10), c = k % 10;
    const filled = k < n;
    dots += `<circle cx="${c * (size + gap) + size / 2 + 1}" cy="${r * (size + gap) + size / 2 + 1}" r="${size / 2}"
              fill="${filled ? "#0072B2" : "#FFFFFF"}" stroke="${filled ? "#0072B2" : "#9AA5B1"}" stroke-width="1"></circle>`;
  }
  const dim = 10 * (size + gap);
  return `<svg class="icons" width="${dim}" height="${dim}" viewBox="0 0 ${dim} ${dim}" role="img"
           aria-label="${n} of 100 dots filled">${dots}</svg>`;
}

function guidancePanel(guidance) {
  const items = guidance.rules.map(r => `<li>${r.text}</li>`).join("");
  return `<div class="guidance">
      <div class="guidance-title">Where this AI often makes mistakes</div>
      <ul>${items}</ul>
      <div class="guidance-note">These are general weaknesses of this AI, found by testing it on other images.
      They do not mean that this particular answer is wrong. Please check the answer yourself.</div>
    </div>`;
}

/* Returns the HTML of the advice box. `conf` = {conf, top3} for the participant's calibration group. */
function renderAdvice(display, aiLabel, conf, guidance) {
  const head = `<div class="ai-answer">AI's answer: <b>${cap(aiLabel)}</b></div>`;
  if (display === "V1") return `<div class="advice">${head}</div>`;
  if (display === "V2") return `<div class="advice">${head}<div class="ai-conf">Confidence: <b>${pct(conf.conf)}%</b></div></div>`;
  if (display === "V3") return `<div class="advice">${head}<div class="ai-conf">Confidence: <b>${confidenceCategory(conf.conf)}</b></div></div>`;
  const visual = `<div class="visual">
        <div class="vis-block"><div class="vis-cap">AI's top three answers</div>${barChartSVG(conf.top3)}</div>
        <div class="vis-block"><div class="vis-cap">In 100 similar images, the AI is right about <b>${pct(conf.conf)}</b> times</div>${iconArraySVG(conf.conf)}</div>
      </div>`;
  if (display === "V4") return `<div class="advice">${head}${visual}</div>`;
  if (display === "V5") return `<div class="advice">${head}${visual}${guidancePanel(guidance)}</div>`;
  throw new Error("Unknown display " + display);
}

/* One-screen explanation shown before each block, and its comprehension question. */
const DISPLAY_EXPLANATION = {
  V1: "In this round, the AI shows <b>only its answer</b>.",
  V2: "In this round, the AI shows its answer and <b>a percentage</b>: how confident the AI says it is in that answer (0–100%).",
  V3: "In this round, the AI shows its answer and a <b>confidence category</b>: <b>High</b> (80% or more), <b>Medium</b> (50–79%) or <b>Low</b> (below 50%).",
  V4: "In this round, the AI shows its answer, a <b>bar chart</b> of its three most likely answers with their percentages, and a <b>dot picture</b>: the filled dots show how many times out of 100 similar images the AI says it is right.",
  V5: "In this round, the AI shows the same bar chart and dot picture, plus a box called <b>“Where this AI often makes mistakes”</b>. The box lists general weaknesses of this AI found by testing it on other images.",
};
const COMPREHENSION = {
  V1: { q: "What will the AI show you in this round?",
        options: ["Only its answer", "Its answer and a percentage", "Its answer and a dot picture"], correct: 0 },
  V2: { q: "If the AI shows “Confidence: 82%”, what does that mean?",
        options: ["The AI says it is 82% confident in its answer", "82% of people chose this answer", "The picture is 82% clear"], correct: 0 },
  V3: { q: "What does the category “High” mean?",
        options: ["The AI's confidence is 80% or more", "The AI's confidence is between 50% and 79%", "The picture is easy for people"], correct: 0 },
  V4: { q: "In the dot picture, what do the filled dots show?",
        options: ["How many times out of 100 similar images the AI says it is right", "How many people agreed with the AI", "How many pixels are in the image"], correct: 0 },
  V5: { q: "What does the box “Where this AI often makes mistakes” tell you?",
        options: ["Situations where this AI is often wrong in general", "That this particular answer is definitely wrong", "Which answer most people chose"], correct: 0 },
};
