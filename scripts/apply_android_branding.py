"""Bundle approved separate icon and portrait splash into Phoenix Model Forge Android.
No changes to model import/export logic. Works offline in GitHub Actions.
"""
from pathlib import Path
from PIL import Image, ImageDraw

ROOT = Path(__file__).resolve().parent.parent
RES = ROOT / "android" / "app" / "src" / "main" / "res"
ICON = ROOT / "public" / "branding" / "icon.webp"
SPLASH = ROOT / "public" / "branding" / "splash.webp"
for f in (ICON, SPLASH):
    if not f.is_file() or f.stat().st_size < 15_000:
        raise SystemExit(f"Missing or too-small branding image: {f}")

icon = Image.open(ICON).convert("RGBA")
splash = Image.open(SPLASH).convert("RGB")
if icon.width < 400 or icon.height < 400 or splash.height < 900:
    raise SystemExit("Brand images have unexpectedly small dimensions")

# Legacy launchers: use full face portrait, not the former tiny mascot in the center.
icon = icon.resize((512, 512), Image.Resampling.LANCZOS)
for density, size in {
    "mdpi": 48, "hdpi": 72, "xhdpi": 96,
    "xxhdpi": 144, "xxxhdpi": 192
}.items():
    folder = RES / f"mipmap-{density}"
    folder.mkdir(parents=True, exist_ok=True)
    bitmap = icon.resize((size, size), Image.Resampling.LANCZOS)
    bitmap.save(folder / "ic_launcher.png", optimize=True)
    mask = Image.new("L", (size, size), 0)
    ImageDraw.Draw(mask).ellipse((0, 0, size - 1, size - 1), fill=255)
    bitmap.putalpha(mask)
    bitmap.save(folder / "ic_launcher_round.png", optimize=True)

# Adaptive launchers (Android 8+) crop foreground to a circular mask.
# Make face big (400/432 instead of 306/432) to avoid a tiny icon on Android.
drawable = RES / "drawable"
drawable.mkdir(parents=True, exist_ok=True)
foreground = Image.new("RGBA", (432, 432), (0, 0, 0, 0))
foreground.alpha_composite(
    icon.resize((400, 400), Image.Resampling.LANCZOS), (16, 16)
)
foreground.save(drawable / "ic_launcher_foreground.png", optimize=True)
old_vector_foreground = drawable / "ic_launcher_foreground.xml"
if old_vector_foreground.exists():
    old_vector_foreground.unlink()

values = RES / "values"
values.mkdir(parents=True, exist_ok=True)
(values / "phoenix_brand_colors.xml").write_text(
    '<resources><color name="phoenix_launcher_bg">#090d1f</color></resources>',
    encoding="utf-8"
)
adaptive = RES / "mipmap-anydpi-v26"
adaptive.mkdir(parents=True, exist_ok=True)
xml = """<?xml version="1.0" encoding="utf-8"?>
<adaptive-icon xmlns:android="http://schemas.android.com/apk/res/android">
  <background android:drawable="@color/phoenix_launcher_bg"/>
  <foreground android:drawable="@drawable/ic_launcher_foreground"/>
</adaptive-icon>
"""
for name in ("ic_launcher.xml", "ic_launcher_round.xml"):
    (adaptive / name).write_text(xml, encoding="utf-8")

# Exactly-approved portrait splash, full height without earlier 140 px inset
# or a small character centered on a mostly empty background.
full_splash = splash.resize((720, 1280), Image.Resampling.LANCZOS)
full_splash.save(drawable / "splash.png", optimize=True)
web_splash = ROOT / "dist" / "branding" / "splash.png"
web_splash.parent.mkdir(parents=True, exist_ok=True)
full_splash.save(web_splash, optimize=True)
assert Image.open(drawable / "splash.png").size == (720, 1280)
assert Image.open(RES / "mipmap-xxxhdpi" / "ic_launcher.png").size == (192, 192)
print("APPROVED NEON BRANDING: icon=512x512 splash=720x1280; Android resources updated")
