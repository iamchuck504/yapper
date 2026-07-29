"""Generate the Yapper app icon (.ico + preview .png).

The mark is two strokes merging into one: several voices going in, a single set
of notes coming out. It is deliberately not a picture of audio — the marks that
stand out (Claude's burst, Granola's spiral) are abstract, and the tile carries
the accent colour so the icon does not vanish in a dock or taskbar.
"""
import os

from PIL import Image, ImageDraw

HERE = os.path.dirname(os.path.abspath(__file__))

S = 512          # exported working size
SS = 4           # supersample factor
W = S * SS

AMBER = (224, 164, 88, 255)
INK = (12, 13, 16, 255)

# glyph geometry, as fractions of the tile
STROKE = 0.115
ARM_L = (0.27, 0.28)
ARM_R = (0.73, 0.28)
JOIN = (0.50, 0.55)
FOOT = (0.50, 0.75)


def bar(d, p0, p1, width, fill):
    """A stroke with round caps, in tile fractions."""
    a = (p0[0] * W, p0[1] * W)
    b = (p1[0] * W, p1[1] * W)
    d.line([a, b], fill=fill, width=width, joint="curve")
    r = width // 2
    for x, y in (a, b):
        d.ellipse([x - r, y - r, x + r, y + r], fill=fill)


def render():
    tile = Image.new("RGBA", (W, W), (0, 0, 0, 0))
    mask = Image.new("L", (W, W), 0)
    ImageDraw.Draw(mask).rounded_rectangle([0, 0, W - 1, W - 1], radius=int(W * 0.225), fill=255)
    tile.paste(Image.new("RGBA", (W, W), AMBER), (0, 0), mask)

    d = ImageDraw.Draw(tile)
    w = int(W * STROKE)
    bar(d, ARM_L, JOIN, w, INK)
    bar(d, ARM_R, JOIN, w, INK)
    bar(d, JOIN, FOOT, w, INK)

    return tile.resize((S, S), Image.LANCZOS)


icon = render()
out_ico = os.path.join(HERE, "app.ico")
out_png = os.path.join(HERE, "app.png")
base = icon.resize((256, 256), Image.LANCZOS)
base.save(out_png)
base.save(out_ico, sizes=[(256, 256), (128, 128), (64, 64), (48, 48), (32, 32), (24, 24), (16, 16)])
print(f"wrote {out_ico} and {out_png}")
