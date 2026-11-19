"""Builds AI_Advice_Study.html: the whole Part B experiment (code, styles, libraries and the 53 pictures) in ONE file,
for the Google Apps Script web app (google_apps_script/Code.gs).
Pictures are embedded as lossless WebP (pixel-identical to the PNG files from Part A, about 35% smaller).
Usage: python build_single_file.py <experiment_dir> <output_html>"""
import sys, re, json, base64, io
from pathlib import Path
from PIL import Image

exp, out = Path(sys.argv[1]).resolve(), Path(sys.argv[2]).resolve()
html = (exp / "index.html").read_text(encoding="utf-8")

def js_safe(code):            # an inlined script must not contain a closing script tag
    return code.replace("</script", "<\\/script")

def webp_uri(png_path):
    im = Image.open(png_path).convert("RGB")
    b = io.BytesIO(); im.save(b, "WEBP", lossless=True, method=6)
    assert Image.open(io.BytesIO(b.getvalue())).convert("RGB").tobytes() == im.tobytes(), png_path
    return "data:image/webp;base64," + base64.b64encode(b.getvalue()).decode()

# stimuli: replace image paths with embedded pictures
stim_js = (exp / "stimuli" / "stimuli.js").read_text(encoding="utf-8")
n_img = 0
def repl(m):
    global n_img; n_img += 1
    return '"file": "' + webp_uri(exp / "stimuli" / m.group(1)) + '"'
stim_js = re.sub(r'"file":\s*"(img/[^"]+\.png)"', repl, stim_js)

def inline_css(m):
    return "<style>\n" + (exp / m.group(1)).read_text(encoding="utf-8") + "\n</style>"
def inline_js(m):
    src = m.group(1)
    code = stim_js if src == "stimuli/stimuli.js" else (exp / src).read_text(encoding="utf-8")
    return "<script>\n" + js_safe(code) + "\n</script>"

html = re.sub(r'<link rel="stylesheet" href="([^"]+)">', inline_css, html)
html = re.sub(r'<script src="([^"]+)"></script>', inline_js, html)
html = html.replace("<head>", "<head>\n  <script>/*__GAS_PARAMS__*/</script>", 1)
assert 'src="' not in re.sub(r'src="\$\{[^}]*\}"', "", html.replace('src="data:', "")), "an external file is still referenced"
out.write_text(html, encoding="utf-8")
print(f"wrote {out} ({out.stat().st_size/1e6:.2f} MB), pictures embedded: {n_img}")
