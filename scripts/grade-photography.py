"""Apply the product's photographic grade to placeholder images.

Partial desaturation, highlight roll-off (bright skies never fight text),
slightly lifted blacks, warmth in the light areas only, fine grain.
Sources live in assets-source/ (not bundled). Run:
    python3 scripts/grade-photography.py
Replace the sources with commissioned photography when available (DEC-028)."""
import numpy as np
from PIL import Image

def grade(src, dst, highlight_comp=0.78, sat=0.62, lift=0.035, warm=(1.03, 1.0, 0.95), seed=1):
    im = np.asarray(Image.open(src).convert('RGB')).astype(np.float32) / 255.0
    lum = (0.2126 * im[..., 0] + 0.7152 * im[..., 1] + 0.0722 * im[..., 2])[..., None]
    im = lum + (im - lum) * sat
    k = 0.55
    im = np.where(im > k, k + (im - k) * highlight_comp, im)
    im = im * (1 - lift) + lift
    l2 = (0.2126 * im[..., 0] + 0.7152 * im[..., 1] + 0.0722 * im[..., 2])[..., None]
    im = im * (1 + (np.array(warm, dtype=np.float32) - 1) * np.clip(l2 * 1.4, 0, 1))
    im = im + np.random.default_rng(seed).normal(0, 0.012, im.shape[:2])[..., None]
    im = np.clip(im * 0.92, 0, 1)
    Image.fromarray((im * 255).astype(np.uint8)).save(dst, quality=78, optimize=True, progressive=True)

if __name__ == '__main__':
    grade('assets-source/photography/launch.jpg', 'assets/photography/launch-graded.jpg')
    grade('assets-source/photography/bosphorus.jpg', 'assets/photography/bosphorus-graded.jpg',
          highlight_comp=0.7, sat=0.55)
