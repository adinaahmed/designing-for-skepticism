"""PIPELINE TEST ONLY — runs automated 'bot' participants through the GOOGLE mode (single-file build served by
Google Apps Script). The Apps Script server (doGet, nextCondition, saveData in Code.gs) is replaced by a local mock,
so nothing is sent anywhere. Bot data are NOT study results.
Usage: python run_bot_google.py <AI_Advice_Study.html> <output_dir> <n_bots> [mode] [device]
  mode:   normal (default) | pilot | fail   (fail = the upload is refused, the participant downloads the file instead)
  device: desktop (default) | phone         (phone = iPhone 13 screen and touch input)"""
import sys, json, random, time
from pathlib import Path
from playwright.sync_api import sync_playwright

html_file, out_dir, n = Path(sys.argv[1]).resolve(), Path(sys.argv[2]).resolve(), int(sys.argv[3])
mode = sys.argv[4] if len(sys.argv) > 4 else "normal"
device = sys.argv[5] if len(sys.argv) > 5 else "desktop"
out_dir.mkdir(parents=True, exist_ok=True)
state = {"next_condition": 0, "condition_calls": 0, "uploads": []}

def visible(page, sel):
    el = page.query_selector(sel)
    return el is not None and el.is_visible()

def fill_html_form(page):
    for inp in page.query_selector_all("#jspsych-survey-html-form input[type=number]"):
        if not inp.input_value():
            lo, hi = int(inp.get_attribute("min") or 0), int(inp.get_attribute("max") or 100)
            inp.fill(str(random.randint(lo, min(hi, lo + 60))))
    for inp in page.query_selector_all("#jspsych-survey-html-form input[type=text]"):
        if inp.get_attribute("required") is not None and not inp.input_value():
            inp.fill("BS Data Science")
    for sel in page.query_selector_all("#jspsych-survey-html-form select"):
        if not sel.input_value() and not (sel.get_attribute("name") or "").startswith("rank_"):
            opts = [o.inner_text() for o in sel.query_selector_all("option") if o.get_attribute("value") != ""]
            sel.select_option(label=random.choice(opts))
    names = {r.get_attribute("name") for r in page.query_selector_all("#jspsych-survey-html-form input[type=radio][required]")}
    for nm in names:
        if not page.query_selector(f'input[name="{nm}"]:checked'):
            random.choice(page.query_selector_all(f'input[name="{nm}"]')).check()

def served_page(pilot):
    """What doGet() in Code.gs returns: the HTML with window.GAS_PARAMS filled in."""
    html = html_file.read_text(encoding="utf-8")
    assert "/*__GAS_PARAMS__*/" in html
    html = html.replace("/*__GAS_PARAMS__*/", "window.GAS_PARAMS = " + json.dumps({"pilot": "1" if pilot else "", "offline": "", "bot": "1"}) + ";")
    p = out_dir / "_served.html"; p.write_text(html, encoding="utf-8"); return p

def py_next_condition():
    state["condition_calls"] += 1
    c = state["next_condition"]; state["next_condition"] += 1     # Code.gs counts 0, 1, 2, ... (page uses c % 10)
    return c

def py_save(filename, csv):
    if mode == "fail": return "mock failure"
    (out_dir / filename).write_text(csv); state["uploads"].append(filename); return "ok"

MOCK_GOOGLE = """
window.google = { script: { get run() {
  let ok = () => {}, bad = () => {};
  const r = {
    withSuccessHandler(f) { ok = f; return r; },
    withFailureHandler(f) { bad = f; return r; },
    nextCondition() { window.py_next_condition().then(ok, bad); },
    saveData(fn, csv) { window.py_save(fn, csv).then(ok, bad); },
  };
  return r;
} } };
"""

def run_one(pw, k):
    browser = pw.chromium.launch()
    ctx = browser.new_context(**pw.devices["iPhone 13"], accept_downloads=True) if device == "phone" else browser.new_context(accept_downloads=True)
    page = ctx.new_page()
    page.expose_function("py_next_condition", py_next_condition); page.expose_function("py_save", py_save)
    page.add_init_script(MOCK_GOOGLE)
    saved, errors = {}, []
    page.on("download", lambda d: (d.save_as(out_dir / d.suggested_filename), saved.setdefault("download", d.suggested_filename)))
    page.on("pageerror", lambda e: errors.append(str(e)))
    url = served_page(mode == "pilot").as_uri()
    page.goto(url)
    wrong_once, overflow = set(), 0
    for _ in range(4000):
        page.wait_for_timeout(30)
        if "download" in saved: break
        txt = page.inner_text("body")
        if "Your responses have been recorded" in txt: break
        if device == "phone":   # the page must never be wider than the phone screen
            overflow = max(overflow, page.evaluate("document.documentElement.scrollWidth - window.innerWidth"))
        if visible(page, "#dl"):
            page.click("#dl"); continue
        if visible(page, "#jspsych-instructions-next"):
            page.click("#jspsych-instructions-next"); continue
        if visible(page, "#jspsych-survey-likert-next"):
            for q in page.query_selector_all(".jspsych-survey-likert-opts"):
                random.choice(q.query_selector_all("input[type=radio]")).check()
            page.click("#jspsych-survey-likert-next"); continue
        if visible(page, "#jspsych-survey-text-next"):
            page.click("#jspsych-survey-text-next"); continue
        if visible(page, "#jspsych-survey-html-form-next"):
            fill_html_form(page)
            if page.query_selector('input[name="initial"], input[name="final"]'):
                page.wait_for_timeout(random.randint(350, 900))
            btn = page.query_selector("#jspsych-survey-html-form-next")
            if btn.is_enabled(): btn.click()
            continue
        btns = [b for b in page.query_selector_all(".jspsych-html-button-response-button button") if b.is_visible()]
        if btns:
            if "Round" in txt and len(btns) == 3 and k % 3 == 0 and "comp" not in wrong_once:
                wrong_once.add("comp"); btns[1].click(); continue
            btns[0].click(); continue
    final_text = page.inner_text("body")[:200].replace("\n", " ")
    browser.close()
    return saved.get("download"), errors, overflow, final_text

with sync_playwright() as pw:
    for k in range(1, n + 1):
        t0 = time.time(); dl, errs, ov, fin = run_one(pw, k)
        print(f"bot {k} [{mode}/{device}]: uploads_so_far={len(state['uploads'])} download={dl} js_errors={len(errs)} "
              f"max_horizontal_overflow_px={ov} ({time.time()-t0:.0f}s) end='{fin[:70]}'", errs[:2])
print("condition requests:", state["condition_calls"], "| uploaded files:", state["uploads"])
