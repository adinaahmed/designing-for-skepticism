/* Part B experiment — Designing for Skepticism (Phase 2 methodology, Steps 2 and 7).
   Design: 2 (AI calibration: calibrated vs overconfident; between) x 5 (display V1–V5; within, one round each)
   x 2 (AI correct vs error) x 2 (easy vs hard for humans).
   Short version (README decisions 20–22): 25 trials = 5 rounds x 5 pictures. The AI is right on 4 of 5 pictures (80%).
   From each prepared set of 10 pictures, a round shows 1 easy + 3 hard AI-correct pictures and 1 AI error.

   Condition c (0..19) sets everything a participant sees:
     group = c % 2                -> 0 = calibrated, 1 = overconfident
     order = floor(c / 2) % 5     -> cyclic Latin square: round position p shows display (p + order) % 5
     h     = floor(c / 10) % 2    -> which AI-correct pictures and which AI error (easy or hard) are shown
   so every 20 participants form one balanced cycle.

   Delivery modes:
     Google link (used in this study): the single-file build (AI_Advice_Study.html) is served by the Apps Script
       web app in google_apps_script/Code.gs, which hands out the next condition and saves each finished CSV in
       the researchers' Google Drive.
     Offline: open index.html; the participant number typed at the start gives c = pid - 1; the CSV downloads.
     DataPipe/OSF: if online_config.js holds a DataPipe ID, conditions come from DataPipe and data go to OSF.
   Adding ?pilot=1 to the link marks a pilot run (file name starts with PILOT_; ignored by the analysis). */

const S = window.STIMULI;
// image paths in stimuli.json are relative to the stimuli folder
S.trials.concat(S.practice).forEach(s => { if (!s.file.startsWith("stimuli/") && !s.file.startsWith("data:")) s.file = "stimuli/" + s.file; });
const CLASSES = S.classes;
// Google mode: the Apps Script server writes window.GAS_PARAMS (the link's ?pilot=1 etc.) into the page it serves.
const GP = window.GAS_PARAMS || null;
const GAS = !!GP && typeof google !== "undefined" && !!(google.script && google.script.run);
const params = GP ? new URLSearchParams(Object.entries(GP).filter(([k, v]) => v !== "")) : new URLSearchParams(window.location.search);
const BOT = params.get("bot") === "1";            // automated pipeline test only (adds no data to real runs)
const PIPE_ID = ((window.ONLINE && window.ONLINE.datapipe_id) || "").trim();
const ONLINE_MODE = (GAS || PIPE_ID !== "") && params.get("offline") !== "1";
const PILOT = params.get("pilot") === "1";
const PIPE_API = (window.ONLINE && window.ONLINE.api_base) || "https://pipe.jspsych.org/api";
if (S.smoke_test) {                               // stimuli from the code test, not from the trained model
  const b = document.createElement("div");
  b.textContent = "DEMO STIMULI (code test only) — do not use with real participants. Run the Part A notebook on Kaggle and copy its partB_stimuli folder here.";
  b.style.cssText = "position:fixed;top:0;left:0;right:0;background:#B00020;color:#fff;padding:6px;font:14px sans-serif;z-index:9999;text-align:center";
  document.addEventListener("DOMContentLoaded", () => document.body.appendChild(b));
  if (document.body) document.body.appendChild(b);
}

const jsPsych = initJsPsych({
  show_progress_bar: true,
  auto_update_progress_bar: false,
  on_finish: () => {
    if (!ONLINE_MODE) { saveData("final"); return; }
    const uploaded = jsPsych.data.get().filter({ task: "_upload" }).count() > 0;
    jsPsych.getDisplayElement().innerHTML = uploaded ? `<div class="text" style="margin-top:3em;text-align:center">
      <h2>Thank you!</h2><p>Your responses have been recorded. You can now close this page.</p></div>` :
      `<div class="text" style="margin-top:3em;text-align:center"><p>Session ended. You can close this page.</p></div>`;
  },
});

let P = { pid: null, group: null, calibration: null, order: null, displays: [] };

/* Assignment shared by both modes: k = pid - 1 (offline) or the DataPipe condition (online). */
function assign(pid, k, extra) {
  k = ((k % 20) + 20) % 20;
  P.pid = pid; P.group = k % 2; P.calibration = P.group === 0 ? "calibrated" : "overconfident";
  P.order = Math.floor(k / 2) % 5;
  P.half = Math.floor(k / 10) % 2;      // short version: which error / which half of the AI-correct pictures
  P.displays = [0, 1, 2, 3, 4].map(p => DISPLAY_CODES[(p + P.order) % 5]);
  jsPsych.data.addProperties(Object.assign({ pid: pid, calibration: P.calibration, latin_order: P.order,
    display_order: P.displays.join("-"), item_half: P.half, n_conditions: 20, stimuli_smoke_test: !!S.smoke_test, mode: ONLINE_MODE ? "online" : "offline",
    pilot: PILOT, bot_test: BOT, screen_width: window.screen ? window.screen.width : null,
    touch_device: ("ontouchstart" in window) || (navigator.maxTouchPoints > 0) }, extra || {}));
}
function fileName(kind) {
  return `${PILOT ? "PILOT_" : ""}P${String(P.pid).padStart(3, "0")}_${P.calibration}_${kind}.csv`;
}

function saveData(kind) {
  const fname = fileName(kind);
  if (kind === "final") {
    jsPsych.data.get().localSave("csv", fname);
  } else {
    try { window.localStorage.setItem("backup_" + fname, jsPsych.data.get().csv()); } catch (e) { /* storage may be blocked */ }
  }
}
function shuffle(a) { return jsPsych.randomization.shuffle(a); }
function cap(s) { return s.charAt(0).toUpperCase() + s.slice(1); }

/* ---------- reusable answer form (judge and revise screens) ---------- */
function classButtons(name) {
  return `<div class="classes">` + CLASSES.map(c =>
    `<label class="cls"><input type="radio" name="${name}" value="${c}"><span>${cap(c)}</span></label>`).join("") + `</div>`;
}
function confSlider(name) {
  return `<div class="slider-row"><span class="sl-end">0<br>Not at all sure</span>
      <input type="range" min="0" max="100" step="1" value="50" name="${name}" id="${name}" class="conf">
      <span class="sl-end">100<br>Completely sure</span></div>
      <div class="sl-val">Your confidence: <b id="${name}_val">— move the slider</b></div>
      <input type="hidden" name="${name}_touched" id="${name}_touched" value="0">`;
}
// Easy version (README decision 21): confidence is one tap on 4 buttons, recorded as 1-4 (ordinal)
const CONF_LEVELS = ["Just guessing", "Not sure", "Fairly sure", "Very sure"];
function confButtons(name) {
  return `<div class="classes confs">` + CONF_LEVELS.map((c, i) =>
    `<label class="cls"><input type="radio" name="${name}" value="${i + 1}"><span>${c}</span></label>`).join("") + `</div>`;
}
function requireInputs(radioName, sliderName, botChoice) {
  const btn = document.querySelector("#jspsych-survey-html-form-next");
  const sl = document.getElementById(sliderName);
  const check = () => {
    const r = document.querySelector(`input[name="${radioName}"]:checked`);
    const confR = sliderName && !sl ? document.querySelector(`input[name="${sliderName}"]:checked`) : true;
    btn.disabled = !(r && confR && (!sl || document.getElementById(sliderName + "_touched").value === "1"));
  };
  btn.disabled = true;
  if (sl) {
    const touch = () => { document.getElementById(sliderName + "_touched").value = "1";
                          document.getElementById(sliderName + "_val").textContent = sl.value; check(); };
    sl.addEventListener("input", touch); sl.addEventListener("change", touch);
  }
  document.querySelectorAll(`input[name="${radioName}"]`).forEach(e => e.addEventListener("change", check));
  if (sliderName && !sl) document.querySelectorAll(`input[name="${sliderName}"]`).forEach(e => e.addEventListener("change", check));
  if (BOT) botAnswer(radioName, sliderName, botChoice);
}
function botAnswer(radioName, sliderName, botChoice) {   // automated test participant (pipeline test only)
  const opts = [...document.querySelectorAll(`input[name="${radioName}"]`)];
  const want = botChoice ? botChoice() : null;
  const el = want ? opts.find(o => o.value === want) : opts[Math.floor(Math.random() * opts.length)];
  el.click();
  const sl = sliderName ? document.getElementById(sliderName) : null;
  if (sl) { sl.value = Math.floor(Math.random() * 101); sl.dispatchEvent(new Event("input")); }
  else if (sliderName) { const c = [...document.querySelectorAll(`input[name="${sliderName}"]`)]; c[Math.floor(Math.random() * c.length)].click(); }
}

/* ---------- 1. Facilitator setup ---------- */
const setup = {
  type: jsPsychSurveyHtmlForm,
  preamble: "<h2>Facilitator setup</h2><p>Enter the participant number from the session sheet (1, 2, 3, …). " +
            "The number decides the calibration group and the block order.</p>",
  html: `<p><label>Participant number: <input name="pid" type="number" min="1" max="999" required autofocus
          value="${params.get("pid") || ""}"></label></p>
         <p><label>Session code (optional): <input name="session" type="text" value="${params.get("session") || ""}"></label></p>`,
  button_label: "Start",
  data: { task: "setup" },
  on_finish: (d) => {
    const pid = parseInt(d.response.pid, 10);
    assign(pid, pid - 1, { session: d.response.session || "", assignment_source: "participant_number" });
  },
};

/* ---------- 1b. Online: automatic assignment from DataPipe ---------- */
async function pipePost(path, body) {
  const r = await fetch(`${PIPE_API}/${path}/`, { method: "POST", headers: { "Content-Type": "application/json", Accept: "*/*" },
                                                  body: JSON.stringify(body) });
  let j = null; try { j = await r.json(); } catch (e) { /* non-JSON reply */ }
  return { ok: r.ok, status: r.status, json: j };
}
function gasCall(fn, ...args) {
  return new Promise((resolve, reject) => google.script.run.withSuccessHandler(resolve).withFailureHandler(reject)[fn](...args));
}
// next condition from the server: Google Apps Script (Google mode) or DataPipe
async function getCondition() {
  if (GAS) { const c = await gasCall("nextCondition"); return { c: Number.isInteger(c) ? c : null, status: "gas", source: "google_server" }; }
  const res = await pipePost("condition", { experimentID: PIPE_ID });
  return { c: res.json && Number.isInteger(res.json.condition) ? res.json.condition : null, status: res.status, source: "datapipe" };
}
// upload the finished CSV: into the researchers' Google Drive folder (Google mode) or OSF through DataPipe
async function uploadData(fname, csv) {
  if (GAS) { const r = await gasCall("saveData", fname, csv); return { ok: r === "ok", status: r }; }
  const res = await pipePost("data", { experimentID: PIPE_ID, filename: fname, data: csv });
  return { ok: res.ok, status: res.status };
}
const onlineSetup = {
  type: jsPsychCallFunction,
  async: true,
  data: { task: "setup" },
  func: (done) => {
    const pid = 100000 + Math.floor(Math.random() * 900000);   // anonymous 6-digit id
    const fallback = (why) => { assign(pid, Math.floor(Math.random() * 20), { assignment_source: why }); done({ condition: null }); };
    if (PILOT) return fallback("pilot_random");
    getCondition()
      .then(res => {
        if (res.c === null) return fallback("random_fallback_" + res.status);
        assign(pid, res.c % 20, { assignment_source: res.source, server_condition: res.c }); done({ condition: res.c });
      })
      .catch(() => fallback("random_fallback_network"));
  },
};

/* ---------- Online: upload the data to OSF through DataPipe ---------- */
const onlineSave = {
  type: jsPsychHtmlButtonResponse,
  stimulus: `<div class="text" id="save_box"><h2>Saving your responses…</h2><p>Please keep this page open for a few seconds.</p></div>`,
  choices: ["Finish"],
  data: { task: "_upload" },
  on_load: () => {
    const btn = document.querySelector(".jspsych-btn"); btn.style.display = "none";
    const box = document.getElementById("save_box");
    const fname = fileName("final");
    const attempt = () => {
      box.innerHTML = "<h2>Saving your responses…</h2><p>Please keep this page open for a few seconds.</p>";
      uploadData(fname, jsPsych.data.get().csv())
        .then(res => {
          if (res.ok) { box.innerHTML = "<h2>Saved — thank you!</h2><p>Your responses have been recorded.</p>"; btn.style.display = ""; btn.textContent = "Finish"; }
          else fail(`code ${res.status}`);
        })
        .catch(() => fail("no internet connection"));
    };
    const fail = (why) => {
      box.innerHTML = `<h2>Your responses could not be uploaded (${why}).</h2>
        <p><button class="jspsych-btn" id="retry">Try again</button></p>
        <p>If it keeps failing, tap <b>Download my data</b> and send the file to the researchers.</p>
        <p><button class="jspsych-btn" id="dl">Download my data</button></p>`;
      document.getElementById("retry").onclick = attempt;
      document.getElementById("dl").onclick = () => { jsPsych.data.get().localSave("csv", fname); btn.style.display = ""; };
    };
    attempt();
  },
};

/* ---------- 2. Consent ---------- */
const consent = {
  type: jsPsychHtmlButtonResponse,
  stimulus: `<div class="text">
    <h2>Information and consent</h2>
    <p>This study is part of a university course project on how people use advice from artificial intelligence (AI).
    You will look at 28 small pictures of everyday objects, say what each one shows, and see the answer of an AI
    image-recognition system, in 5 short rounds. You will also answer a few quick questions. It takes about 8–10 minutes.</p>
    <p>Participation is voluntary and unpaid. You may stop at any time without giving a reason. Your answers are stored
    under a participant number only; no name or contact details are recorded. The anonymised data will be used for
    the course project and may be shared in anonymised form.</p>
    <p>Do you agree to take part?</p></div>`,
  choices: ["I agree to take part", "I do not agree"],
  data: { task: "consent" },
};
const noConsentEnd = {
  timeline: [{ type: jsPsychHtmlButtonResponse, stimulus: () => ONLINE_MODE ? "<p>Thank you. You have chosen not to take part. You can close this page.</p>" : "<p>Thank you. You have chosen not to take part. Please tell the facilitator.</p>",
               choices: ["Close"], data: { task: "no_consent" }, on_finish: () => jsPsych.endExperiment("Session ended.") }],
  conditional_function: () => jsPsych.data.get().filter({ task: "consent" }).last(1).values()[0].response !== 0,
};

/* ---------- 3. Pre-survey ---------- */
const demographics = {
  type: jsPsychSurveyHtmlForm,
  preamble: "<h3>About you</h3>",
  html: `<p><label>Age (years): <input name="age" type="number" min="16" max="99" required></label></p>
    <p>Gender: <label><input type="radio" name="gender" value="female" required> Female</label>
       <label><input type="radio" name="gender" value="male"> Male</label>
       <label><input type="radio" name="gender" value="prefer_not"> Prefer not to say</label></p>
    <p>How often do you use AI tools (e.g., ChatGPT, image recognition apps)?<br>
       <select name="ai_use" required><option value="">— choose —</option><option>Never</option><option>Less than once a month</option>
       <option>A few times a month</option><option>A few times a week</option><option>Daily</option></select></p>`,
  data: { task: "demographics" },
};
const gaais = {
  type: jsPsychSurveyLikert,
  preamble: `<div class="text"><h3>Attitudes towards Artificial Intelligence</h3><p>${GAAIS_INTRO}</p></div>`,
  questions: GAAIS_ITEMS.map((t, i) => ({ prompt: t, labels: GAAIS_LABELS, required: true, name: `gaais${i + 1}` })),
  randomize_question_order: true,
  data: { task: "gaais" },
};
const bnt = {
  type: jsPsychSurveyHtmlForm,
  preamble: "<h3>Four short number questions</h3><p>Please answer without a calculator. Write a whole number.</p>",
  html: BNT_ITEMS.map((b, i) => `<div class="bnt"><p><b>${i + 1}.</b> ${b.text}</p>
         <p><input name="${b.name}" type="number" min="0" max="1000" required> ${b.unit}</p></div>`).join(""),
  data: { task: "bnt" },
  on_finish: (d) => { d.bnt_score = BNT_ITEMS.reduce((s, b) => s + (parseInt(d.response[b.name], 10) === b.answer ? 1 : 0), 0); },
};
function trustForm(task, withAccuracy, title) {
  return {
    type: jsPsychSurveyHtmlForm,
    preamble: title,
    html: `<p>How much do you trust the AI assistant${task === "trust_baseline" ? " you are about to work with" : ""}?</p>
      <div class="slider-row"><span class="sl-end">0<br>Not at all</span><input type="range" min="0" max="100" value="50" name="trust" id="trust" class="conf"><span class="sl-end">100<br>Completely</span></div>
      <div class="sl-val">Your answer: <b id="trust_val">— move the slider</b></div><input type="hidden" name="trust_touched" id="trust_touched" value="0">` +
      (withAccuracy ? `<p style="margin-top:28px">Out of 100 pictures like these, how many do you think this AI gets right?</p>
      <div class="slider-row"><span class="sl-end">0</span><input type="range" min="0" max="100" value="50" name="est_acc" id="est_acc" class="conf"><span class="sl-end">100</span></div>
      <div class="sl-val">Your answer: <b id="est_acc_val">— move the slider</b></div>` : ""),
    data: { task: task },
    on_load: () => {
      const btn = document.querySelector("#jspsych-survey-html-form-next"); btn.disabled = true;
      const moved = new Set(); const need = withAccuracy ? 2 : 1;
      ["trust", "est_acc"].forEach(id => {
        const sl = document.getElementById(id); if (!sl) return;
        const t = () => { moved.add(id); if (id === "trust") document.getElementById("trust_touched").value = "1";
                          document.getElementById(id + "_val").textContent = sl.value; btn.disabled = moved.size < need; };
        sl.addEventListener("input", t); sl.addEventListener("change", t);
        if (BOT) { sl.value = Math.floor(Math.random() * 101); sl.dispatchEvent(new Event("input")); }
      });
    },
    on_finish: (d) => { d.trust = parseInt(d.response.trust, 10); if (withAccuracy) d.est_acc = parseInt(d.response.est_acc, 10); },
  };
}

/* ---------- 4. Tutorial and practice ---------- */
const tutorial = {
  type: jsPsychInstructions,
  pages: [
    `<div class="text"><h2>Your task</h2><p>You will see small pictures. Each picture shows one of ten things:
      ${CLASSES.map(cap).join(", ")}. The pictures are small and some are hard to recognise.</p></div>`,
    `<div class="text"><h2>Three steps for every picture</h2><ol>
      <li><b>Your answer:</b> tap what the picture shows and how sure you are.</li>
      <li><b>AI advice:</b> you then see the answer of an AI image-recognition system.</li>
      <li><b>Final answer:</b> choose your final answer. You may keep your first answer or change it.</li></ol>
      <p>The AI is not always right. Try to get as many final answers right as you can.</p></div>`,
    `<div class="text"><h2>5 rounds</h2><p>There are 5 rounds of 5 pictures. In each round the AI's advice is shown in a different way;
      a short explanation comes before each round. After each round you will see your score, the AI's score and which answers were correct,
      and you will rate the AI. At the end you get your total score.</p><p>First, 3 practice pictures.</p></div>`,
  ],
  show_clickable_nav: true,
  data: { task: "tutorial" },
};
function judgeTrial(stim, meta) {
  return {
    type: jsPsychSurveyHtmlForm,
    preamble: `<div class="trial-head">${meta.header}</div><img class="stim" src="${stim.file}" alt="picture">`,
    html: `<p class="q">What does this picture show?</p>${classButtons("initial")}<p class="q">How sure are you?</p>${confButtons("initial_conf")}`,
    button_label: "Continue",
    data: Object.assign({ task: meta.task + "_initial" }, meta.data),
    on_load: () => requireInputs("initial", "initial_conf", () => {
      const pc = stim.difficulty === "easy" ? 0.85 : 0.55;           // bot only: plausible accuracy
      return Math.random() < pc ? stim.true_label : CLASSES[Math.floor(Math.random() * 10)];
    }),
    on_finish: (d) => { d.initial_label = d.response.initial; d.initial_conf = parseInt(d.response.initial_conf, 10);
                        d.initial_correct = d.initial_label === stim.true_label; },
  };
}
function reviseTrial(stim, meta) {
  const conf = P.calibration === "calibrated" ? stim.calibrated : stim.overconfident;
  return {
    type: jsPsychSurveyHtmlForm,
    preamble: () => {
      const init = jsPsych.data.get().last(1).values()[0].initial_label;
      return `<div class="trial-head">${meta.header}</div><div class="revise-wrap"><div><img class="stim" src="${stim.file}" alt="picture">
        <div class="your-first">Your first answer: <b>${cap(init)}</b></div></div>
        ${renderAdvice(meta.display, stim.ai_label, conf, S.guidance)}</div>`;
    },
    html: `<p class="q">Your final answer:</p>${classButtons("final")}`,
    button_label: "Next picture",
    data: Object.assign({ task: meta.task + "_final" }, meta.data),
    on_load: () => requireInputs("final", null, () => {
      const init = jsPsych.data.get().last(1).values()[0].initial_label;      // bot only: follows AI sometimes
      const shown = meta.display === "V1" ? 0.8 : conf.conf;
      return Math.random() < 0.25 + 0.5 * shown ? stim.ai_label : init;
    }),
    on_finish: (d) => {
      const first = jsPsych.data.get().last(2).values()[0];
      d.final_label = d.response.final;
      d.initial_label = first.initial_label; d.initial_conf = first.initial_conf; d.initial_correct = first.initial_correct;
      d.rt_initial = first.rt; d.rt_final = d.rt;
      d.final_correct = d.final_label === stim.true_label;
      d.follow_ai = d.final_label === stim.ai_label;
      d.switched = d.final_label !== d.initial_label;
      d.displayed_conf = meta.display === "V1" ? null : conf.conf;
    },
  };
}
function stimData(stim) {
  return { test_idx: stim.test_idx, image_set: stim.set, true_label: stim.true_label, ai_label: stim.ai_label,
           ai_correct: stim.ai_correct, difficulty: stim.difficulty, human_acc: stim.human_acc,
           conf_calibrated: stim.calibrated.conf, conf_overconfident: stim.overconfident.conf,
           guidance_rules_matched: (stim.guidance_rules_matched || []).join("|") };
}
const practice = {
  timeline: S.practice.flatMap((stim, k) => [
    judgeTrial(stim, { task: "practice", header: `Practice ${k + 1} of 3`, data: stimData(stim) }),
    reviseTrial(stim, { task: "practice", display: "V1", header: `Practice ${k + 1} of 3`, data: stimData(stim) }),
    { type: jsPsychHtmlButtonResponse, stimulus: `<p>The correct answer was <b>${cap(stim.true_label)}</b>.</p>`,
      choices: ["Continue"], data: { task: "practice_feedback" } },
  ]),
};

/* ---------- 5. Blocks ---------- */
function blockOrder(items) {
  // trial order randomised within the round; the AI-error trial is placed at a random position from the 3rd picture on
  const errors = shuffle(items.filter(s => !s.ai_correct)), correct = shuffle(items.filter(s => s.ai_correct));
  const errPos = shuffle([2, 3, 4]).slice(0, errors.length).sort((a, b) => a - b);
  const out = []; let e = 0, c = 0;
  for (let i = 0; i < items.length; i++) out.push(errPos.includes(i) ? errors[e++] : correct[c++]);
  return out;
}
/* Short version: from the set of 10, choose 1 easy + 3 hard AI-correct pictures and 1 AI error (counterbalanced by h).
   The 4 AI-correct pictures of each type are split into two fixed halves, alternating after sorting by guidance coverage
   and test index, so both halves contain the same number of V5-guided pictures (as far as possible). */
function roundItems(pos) {
  const set = S.trials.filter(s => s.set === pos);
  const guided = s => (s.guidance_rules_matched || []).length > 0 ? 0 : 1;
  const sorted = (diff) => set.filter(s => s.ai_correct && s.difficulty === diff)
    .sort((a, b) => guided(a) - guided(b) || a.test_idx - b.test_idx);
  // harder version: 1 easy + 3 hard AI-correct pictures (which ones depends on h), plus 1 AI error
  const easy = sorted("easy").filter((s, i) => i === P.half);
  const hard = sorted("hard").filter((s, i) => i !== 2 * P.half);
  const errDiff = (pos + P.half) % 2 === 0 ? "easy" : "hard";
  const err = set.filter(s => !s.ai_correct && s.difficulty === errDiff);
  return easy.concat(hard, err);
}
function comprehension(display, pos) {
  const cq = COMPREHENSION[display];
  let attempts = 0;
  const screen = {
    type: jsPsychHtmlButtonResponse,
    stimulus: () => `<div class="text"><h2>Round ${pos + 1} of 5</h2><p>${DISPLAY_EXPLANATION[display]}</p>
       <div class="example-note">Example:</div>${renderAdvice(display, "dog",
         { conf: 0.82, top3: [{ label: "dog", p: 0.82 }, { label: "cat", p: 0.12 }, { label: "deer", p: 0.03 }] }, S.guidance)}
       <p class="q" style="margin-top:22px">${attempts > 0 ? "<span class='warn'>Not quite — please read the explanation again.</span><br>" : ""}${cq.q}</p></div>`,
    choices: cq.options,
    data: { task: "comprehension", display: display, block_pos: pos + 1 },
    on_finish: (d) => { attempts += 1; d.attempt = attempts; d.comp_correct = d.response === cq.correct; },
  };
  return { timeline: [screen],
           loop_function: (data) => !data.values()[0].comp_correct && attempts < 2 };
}
function blockFeedback(items, pos) {
  return {
    type: jsPsychHtmlButtonResponse,
    stimulus: () => {
      const rows = jsPsych.data.get().filter({ task: "trial_final", block_pos: pos + 1 }).values();
      const tbl = rows.map(r => `<tr><td><img src="${S.trials.find(s => s.test_idx === r.test_idx).file}" class="thumb"></td>
          <td>${cap(r.true_label)}</td><td>${cap(r.ai_label)} ${r.ai_correct ? "<span class='ok'>✓ correct</span>" : "<span class='bad'>✗ wrong</span>"}</td>
          <td>${cap(r.final_label)} ${r.final_correct ? "<span class='ok'>✓</span>" : "<span class='bad'>✗</span>"}</td></tr>`).join("");
      const nAI = rows.filter(r => r.ai_correct).length, nYou = rows.filter(r => r.final_correct).length;
      return `<div class="text"><h2>Round ${pos + 1} results</h2>
        <div class="score"><div><span>You</span><b>${nYou} / ${rows.length}</b></div><div><span>AI</span><b>${nAI} / ${rows.length}</b></div></div>
        <table class="fb"><tr><th>Picture</th><th>Correct answer</th><th>AI's answer</th><th>Your final answer</th></tr>${tbl}</table></div>`;
    },
    choices: ["Continue"],
    data: { task: "block_feedback", block_pos: pos + 1 },
  };
}
/* Blocks are built after the participant number is known, because the display order depends on it. */
function makeBlock(pos) {
  const display = P.displays[pos];
  const items = blockOrder(roundItems(pos));
  const tl = [comprehension(display, pos)];
  items.forEach((stim, k) => {
    const meta = { task: "trial", display: display, header: `Round ${pos + 1} of 5 · picture ${k + 1} of ${items.length}`,
                   data: Object.assign({ block_pos: pos + 1, display: display, trial_in_block: k + 1 }, stimData(stim)) };
    tl.push(judgeTrial(stim, meta));
    tl.push(reviseTrial(stim, meta));
  });
  tl.push(blockFeedback(items, pos));
  tl.push(Object.assign(trustForm("trust_block", true, `<h3>Your view of the AI after round ${pos + 1}</h3>`),
                        { data: { task: "trust_block", block_pos: pos + 1, display: display,
                                  block_ai_accuracy: items.filter(s => s.ai_correct).length / items.length } }));
  tl.push({ type: jsPsychCallFunction, func: () => { saveData("backup_block" + (pos + 1));
            jsPsych.setProgressBar(0.2 + 0.14 * (pos + 1)); }, data: { task: "_backup" } });
  return { timeline: tl };
}

/* ---------- 6. Post-survey and debrief ---------- */
const tia = {
  type: jsPsychSurveyLikert,
  preamble: "<div class='text'><h3>Your overall view of the AI</h3><p>Please rate each statement about the AI you worked with today " +
            "(1 = not at all, 7 = extremely).</p></div>",
  questions: TIA_ITEMS.map((t, i) => ({ prompt: t, labels: TIA_LABELS, required: true, name: `tia${i + 1}` })),
  data: { task: "tia" },
};
const preference = {      // easy version: one tap for the most useful display (was a 1-5 ranking)
  type: jsPsychHtmlButtonResponse,
  stimulus: "<h3>Which way of showing the AI's advice was the most useful for you?</h3>",
  choices: () => DISPLAY_CODES.map(d => ({ V1: "Only the AI's answer", V2: "Answer + percentage", V3: "Answer + High / Medium / Low",
                                            V4: "Answer + bar chart and dots", V5: "Bar chart and dots + \u201cwhere this AI often makes mistakes\u201d box" })[d]),
  button_html: '<button class="jspsych-btn" style="display:block;width:100%;max-width:520px;margin:6px auto">%choice%</button>',
  css_classes: ["pref"],
  data: { task: "preference" },
  on_finish: (d) => { d.preferred_display = DISPLAY_CODES[d.response]; },
};
const comment = {
  type: jsPsychSurveyText,
  questions: [{ prompt: "Any comments about the AI or the way its advice was shown? (optional)", rows: 4, name: "comment", required: false }],
  data: { task: "comment" },
};
const scoreSummary = {
  type: jsPsychHtmlButtonResponse,
  stimulus: () => {
    const t = jsPsych.data.get().filter({ task: "trial_final" }).values();
    const fin = t.filter(r => r.final_correct).length, first = t.filter(r => r.initial_correct).length, ai = t.filter(r => r.ai_correct).length;
    return `<div class="text" style="text-align:center"><h2>Your total score</h2>
      <div class="score big"><div><span>You (final answers)</span><b>${fin} / ${t.length}</b></div>
      <div><span>You alone (first answers)</span><b>${first} / ${t.length}</b></div><div><span>AI alone</span><b>${ai} / ${t.length}</b></div></div>
      <p>${fin > ai ? "Well done: you and the AI together beat the AI on its own!" : fin === ai ? "You matched the AI's score." :
           "The AI on its own scored higher this time."}</p></div>`;
  },
  choices: ["Continue"],
  data: { task: "score_summary" },
};
const debrief = {
  type: jsPsychHtmlButtonResponse,
  stimulus: () => `<div class="text"><h2>Thank you — debriefing</h2>
    <p>This study compares different ways of showing how confident an AI is. Half of the participants worked with an AI whose
    confidence values were <b>honest (calibrated)</b>: when it said 80%, it was right about 80% of the time. The other half worked
    with the <b>same AI</b>, giving the same answers, but its confidence values were <b>deliberately inflated (overconfident)</b>,
    so it often said it was very sure even when it was wrong. You were in the <b>${P.calibration}</b> group.</p>
    <p>We did not tell you this in advance because we wanted to see how people react to overconfident AI. The AI's answers
    themselves were real outputs of an image-recognition model. Please do not tell other students about the two groups until
    the study is finished.</p><p>${ONLINE_MODE ? "Tap the button to save your responses." : "Your data will now be saved. Please tell the facilitator that you have finished."}</p></div>`,
  choices: ["Finish and save my data"],
  data: { task: "debrief" },
};

/* ---------- Assemble ---------- */
const preload = { type: jsPsychPreload, images: S.trials.map(s => s.file).concat(S.practice.map(s => s.file)), data: { task: "preload" } };
const timeline = [preload, ONLINE_MODE ? onlineSetup : setup, consent, noConsentEnd, demographics,
  trustForm("trust_baseline", false, "<h3>Before you start</h3>"), tutorial, practice];
let built = false;

const startBlocks = {
  type: jsPsychCallFunction,
  data: { task: "_build_blocks" },
  func: () => {
    if (built) return; built = true;
    const nodes = [0, 1, 2, 3, 4].map(makeBlock);
    nodes.concat([preference, comment, scoreSummary, debrief], ONLINE_MODE ? [onlineSave] : []).forEach(n => jsPsych.addNodeToEndOfTimeline(n));
  },
};
timeline.push(startBlocks);
jsPsych.run(timeline);
