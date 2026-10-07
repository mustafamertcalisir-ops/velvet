"""Verify bundled fonts contain the Turkish glyphs the product requires.
Run: python3 scripts/check-fonts.py   (needs `pip install fonttools`)"""
import glob, sys
from fontTools.ttLib import TTFont

REQUIRED = "ÇçĞğİıÖöŞşÜü"
paths = [p for fam in ("newsreader", "instrument-sans")
         for p in glob.glob(f"node_modules/@expo-google-fonts/{fam}/*/*.ttf")]
used = ("400Regular", "400Regular_Italic", "500Medium", "600SemiBold")
failed = False
for p in sorted(paths):
    if not any(p.endswith(f"_{u}.ttf") for u in used):
        continue
    cmap = TTFont(p).getBestCmap()
    missing = [c for c in REQUIRED if ord(c) not in cmap]
    print(("FAIL " if missing else "ok   ") + p.split("/")[-1], "".join(missing))
    failed |= bool(missing)
sys.exit(1 if failed else 0)
