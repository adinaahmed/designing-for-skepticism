"""PIPELINE TEST ONLY — runs automated 'bot' participants through the Part B experiment in Chromium.
The bots answer randomly / by simple rules; their data are NOT study results and must never be reported.
Usage: python run_bot_participants.py <experiment_dir> <output_dir> <n_bots> [first_pid]"""
import sys, os, random, time
from pathlib import Path
from playwright.sync_api import sync_playwright

exp_dir, out_dir, n = Path(sys.argv[1]).resolve(), Path(sys.argv[2]).resolve(), int(sys.argv[3])
first = int(sys.argv[4]) if len(sys.argv) > 4 else 1
out_dir.mkdir(parents=True, exist_ok=True)

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

def run_one(pw, pid):
    browser = pw.chromium.launch()
    page = browser.new_page(accept_downloads=True)
    saved = {}
    page.on("download", lambda d: (d.save_as(out_dir / d.suggested_filename), saved.setdefault("f", d.suggested_filename)))
    errors = []
    page.on("pageerror", lambda e: errors.append(str(e)))
    page.goto((exp_dir / "index.html").as_uri() + f"?bot=1&pid={pid}&session=TEST")
    wrong_once = set()
    for _ in range(3000):
        if "f" in saved: break
        page.wait_for_timeout(30)
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
                page.wait_for_timeout(random.randint(350, 900))      # human-like response time on trial screens
            btn = page.query_selector("#jspsych-survey-html-form-next")
            if btn.is_enabled(): btn.click()
            continue
        btns = page.query_selector_all(".jspsych-html-button-response-button button")
        if btns:
            txt = page.inner_text("#jspsych-content")
            # every 3rd bot answers the first comprehension question wrongly once (tests the retry loop)
            if "Round" in txt and len(btns) == 3 and pid % 3 == 0 and "comp" not in wrong_once:
                wrong_once.add("comp"); btns[1].click(); continue
            btns[0].click(); continue
    page.wait_for_timeout(500)
    browser.close()
    return saved.get("f"), errors

with sync_playwright() as pw:
    for pid in range(first, first + n):
        t0 = time.time(); f, errs = run_one(pw, pid)
        print(f"bot {pid}: file={f} js_errors={len(errs)} ({time.time()-t0:.0f}s)", errs[:2])
