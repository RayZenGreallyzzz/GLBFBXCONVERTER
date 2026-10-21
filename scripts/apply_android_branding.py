"""Generate Android launcher icon and startup artwork from user's raccoon mascot.
Only native branding resources are changed; converter logic remains intact.
"""
from pathlib import Path
from PIL import Image, ImageDraw, ImageFilter

ROOT=Path(__file__).resolve().parent.parent
APP=ROOT/"android"/"app"/"src"/"main"/"res"
ART=ROOT/"public"/"branding"/"mascot.webp"
if not ART.exists(): raise SystemExit("Missing public/branding/mascot.webp")
mascot=Image.open(ART).convert("RGB")
W,H=mascot.size
palette=(9,13,31)
# Icon: cropped face & chest, a safe central square for round/adaptive launchers.
icon=mascot.crop((int(W*.125),0,int(W*.875),int(W*.75)))
icon=icon.resize((512,512),Image.Resampling.LANCZOS)
canvas=Image.new("RGBA",(512,512),palette+(255,))
draw=ImageDraw.Draw(canvas)
draw.ellipse((15,15,497,497),outline=(34,216,246,255),width=12)
draw.arc((28,28,484,484),15,220,fill=(234,42,220,255),width=9)
canvas.alpha_composite(icon.convert("RGBA"))
draw=ImageDraw.Draw(canvas)
draw.ellipse((15,15,497,497),outline=(34,216,246,255),width=10)
draw.arc((28,28,484,484),15,220,fill=(234,42,220,255),width=8)
# Compact launcher densities.
for density,size in {"mdpi":48,"hdpi":72,"xhdpi":96,"xxhdpi":144,"xxxhdpi":192}.items():
    folder=APP/f"mipmap-{density}";folder.mkdir(parents=True,exist_ok=True)
    bitmap=canvas.resize((size,size),Image.Resampling.LANCZOS)
    bitmap.save(folder/"ic_launcher.png",optimize=True)
    circle=Image.new("L",(size,size));ImageDraw.Draw(circle).ellipse((0,0,size-1,size-1),fill=255)
    bitmap.putalpha(circle)
    bitmap.save(folder/"ic_launcher_round.png",optimize=True)
drawable=APP/"drawable";drawable.mkdir(parents=True,exist_ok=True)
foreground=Image.new("RGBA",(432,432),(0,0,0,0))
foreground.alpha_composite(canvas.resize((306,306),Image.Resampling.LANCZOS),(63,63))
foreground.save(drawable/"ic_launcher_foreground.png",optimize=True)
old=drawable/"ic_launcher_foreground.xml"
if old.exists():old.unlink()
values=APP/"values";values.mkdir(parents=True,exist_ok=True)
(values/"phoenix_brand_colors.xml").write_text(
 '<resources><color name="phoenix_launcher_bg">#090d1f</color></resources>',encoding="utf-8")
anydpi=APP/"mipmap-anydpi-v26";anydpi.mkdir(parents=True,exist_ok=True)
xml='''<?xml version="1.0" encoding="utf-8"?>
<adaptive-icon xmlns:android="http://schemas.android.com/apk/res/android">
<background android:drawable="@color/phoenix_launcher_bg"/>
<foreground android:drawable="@drawable/ic_launcher_foreground"/>
</adaptive-icon>
'''
for f in ("ic_launcher.xml","ic_launcher_round.xml"):(anydpi/f).write_text(xml,encoding="utf-8")
# Portrait splash centered without clipping legs and tail.
splash=Image.new("RGB",(720,1280),palette)
art=mascot.copy()
art.thumbnail((680,1000),Image.Resampling.LANCZOS)
splash.paste(art,((720-art.width)//2,140))
d=ImageDraw.Draw(splash)
d.text((165,1180),"PHOENIX MODEL FORGE",fill=(102,227,249))
splash.save(drawable/"splash.png",optimize=True)
web_splash=ROOT/"dist"/"branding"/"splash.png"
web_splash.parent.mkdir(parents=True,exist_ok=True)
splash.save(web_splash,optimize=True)
print("Installed mascot launcher and portrait splash",canvas.size,splash.size)
