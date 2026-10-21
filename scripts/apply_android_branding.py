"""Generate Android launcher assets and a native splash image from bundled art.
Executed after \`npx cap add android\`, before \`npx cap sync android\`.
Never touches application model processing or any MultiFormat branch.
"""
from pathlib import Path
from PIL import Image, ImageDraw
from xml.sax.saxutils import escape

ROOT = Path(__file__).resolve().parent.parent
APP = ROOT / "android" / "app" / "src" / "main" / "res"
icon_file = ROOT / "public" / "branding" / "icon.webp"
splash_file = ROOT / "public" / "branding" / "splash.webp"
if not icon_file.exists() or not splash_file.exists():
    raise SystemExit("Branding files missing (icon.webp, splash.webp)")

icon = Image.open(icon_file).convert("RGBA")
splash = Image.open(splash_file).convert("RGB")
SIZES = {"mdpi": 48, "hdpi": 72, "xhdpi": 96, "xxhdpi": 144, "xxxhdpi": 192}
for density, size in SIZES.items():
    folder = APP / f"mipmap-{density}"
    folder.mkdir(parents=True, exist_ok=True)
    bitmap = icon.resize((size,size),Image.Resampling.LANCZOS)
    bitmap.save(folder / "ic_launcher.png", optimize=True)
    mask = Image.new("L",(size,size),0)
    ImageDraw.Draw(mask).ellipse((0,0,size-1,size-1),fill=255)
    round_icon=bitmap.copy()
    round_icon.putalpha(mask)
    round_icon.save(folder/"ic_launcher_round.png", optimize=True)

# Safe area for adaptive launcher icon. Android masks its outer region.
drawable = APP / "drawable"
drawable.mkdir(parents=True, exist_ok=True)
foreground = drawable / "ic_launcher_foreground.xml"
if foreground.exists():
    foreground.unlink()
canvas = Image.new("RGBA",(432,432),(0,0,0,0))
picture = icon.resize((310,310),Image.Resampling.LANCZOS)
canvas.alpha_composite(picture,((432-310)//2,(432-310)//2))
canvas.save(drawable / "ic_launcher_foreground.png", optimize=True)

colors=APP/"values"/"phoenix_brand_colors.xml"
colors.parent.mkdir(parents=True,exist_ok=True)
colors.write_text('<resources><color name="phoenix_launcher_bg">#160822</color></resources>',encoding="utf-8")
adaptive = APP/"mipmap-anydpi-v26"
adaptive.mkdir(parents=True,exist_ok=True)
xml = '''<?xml version="1.0" encoding="utf-8"?>
<adaptive-icon xmlns:android="http://schemas.android.com/apk/res/android">
  <background android:drawable="@color/phoenix_launcher_bg"/>
  <foreground android:drawable="@drawable/ic_launcher_foreground"/>
</adaptive-icon>
'''
for filename in ["ic_launcher.xml","ic_launcher_round.xml"]:
    (adaptive / filename).write_text(xml,encoding="utf-8")

# On pre-Android-12 devices the native splash drawable may be used.
splash.save(drawable/"splash.png",optimize=True)
assert (drawable/"ic_launcher_foreground.png").stat().st_size>1000
assert (drawable/"splash.png").stat().st_size>1000
print("Installed Phoenix Model Forge turtle icon and startup artwork")
