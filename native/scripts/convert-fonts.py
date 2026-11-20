"""Losslessly unpack the existing licensed WOFF2 fonts for Rune's native font loader.
Run with python3-fonttools and python3-brotli installed; no font redesign/substitution.
"""
from pathlib import Path
from fontTools.ttLib import TTFont
root = Path(__file__).resolve().parents[2]
for name in ("geist-latin-wght-normal", "geist-latin-ext-wght-normal"):
    font = TTFont(root / "public/fonts" / f"{name}.woff2")
    font.flavor = None
    font.save(root / "native/assets" / f"{name}.ttf")
