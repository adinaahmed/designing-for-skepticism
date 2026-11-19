"""PIPELINE TEST ONLY — runs automated 'bot' participants through the ONLINE mode of the Part B experiment.
DataPipe (pipe.jspsych.org) is replaced by a local mock, so nothing is sent anywhere. Bot data are NOT study results.
Usage: python run_bot_online.py <experiment_dir_with_online_config> <output_dir> <n_bots> [mode] [device]
  mode:   normal (default) | pilot | fail   (fail = the upload is refused, the participant downloads the file instead)
  device: desktop (default) | phone         (phone = iPhone 13 screen and touch input)"""
import sys, json, random, time
from pathlib import Path
from playwright.sync_api import sync_playwright

exp_dir, out_dir, n = Path(sys.argv[1]).resolve(), Path(sys.argv[2]).resolve(), int(sys.argv[3])
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

def mock_condition(route):
    body = json.loads(route.request.post_data or "{}")
    assert body.get("experimentID") == "TESTPIPEID01", body
    state["condition_calls"] += 1
    c = state["next_condition"]; state["next_condition"] = (c + 1) % 10
    route.fulfill(status=200, content_type="application/json", body=json.dumps({"condition": c}))

def mock_data(route):
    if mode == "fail":
        return route.fulfill(status=500, content_type="application/json", body=json.dumps({"error": "mock failure"}))
    body = json.loads(route.request.post_data or "{}")
    (out_dir / body["filename"]).write_text(body["data"])
    state["uploads"].append(body["filename"])
    route.fulfill(status=201, content_type="application/json", body=json.dumps({"message": "Success"}))

def run_one(pw, k):
    browser = pw.chromium.launch()
    ctx = browser.new_context(**pw.devices["iPhone 13"], accept_downloads=True) if device == "phone" else browser.new_context(accept_downloads=True)
    page = ctx.new_page()
    page.route("**/api/condition/", mock_condition); page.route("**/api/data/", mock_data)
    saved, errors = {}, []
    page.on("download", lambda d: (d.save_as(out_dir / d.suggested_filename), saved.setdefault("download", d.suggested_filename)))
    page.on("pageerror", lambda e: errors.append(str(e)))
    url = (exp_dir / "index.html").as_uri() + "?bot=1" + ("&pilot=1" if mode == "pilot" else "")
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
