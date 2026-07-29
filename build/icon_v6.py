"""Two families explored: brackets and rings.

Brackets say "an excerpt lifted out of something longer", but the plain [ ]
reads like a code editor — these try to shake that off. Rings say "a room being
listened to", but concentric circles read as a target — these break the ring or
open it so the eye reads sound instead.
"""
import math
import os

from PIL import Image, ImageDraw

HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(HERE, "icon-v6")
os.makedirs(OUT, exist_ok=True)

S, SS = 512, 4
W = S * SS

AMBER = (224, 164, 88, 255)
INK = (12, 13, 16, 255)


def tile(bg=AMBER):
    img = Image.new("RGBA", (W, W), (0, 0, 0, 0))
    mask = Image.new("L", (W, W), 0)
    ImageDraw.Draw(mask).rounded_rectangle([0, 0, W - 1, W - 1], radius=int(W * 0.225), fill=255)
    img.paste(Image.new("RGBA", (W, W), bg), (0, 0), mask)
    return img


def hbar(d, x0, x1, y, t, fill=INK):
    r = t * W / 2
    d.rounded_rectangle([x0 * W, y * W - r, x1 * W, y * W + r], radius=r, fill=fill)


def vbar(d, x, y0, y1, t, fill=INK):
    r = t * W / 2
    d.rounded_rectangle([x * W - r, y0 * W, x * W + r, y1 * W], radius=r, fill=fill)


def ring(d, r, t, fill=INK):
    d.ellipse([(0.5 - r) * W, (0.5 - r) * W, (0.5 + r) * W, (0.5 + r) * W],
              outline=fill, width=int(t * W))


def arc(d, r, t, a0, a1, fill=INK):
    d.arc([(0.5 - r) * W, (0.5 - r) * W, (0.5 + r) * W, (0.5 + r) * W],
          a0, a1, fill=fill, width=int(t * W))


def dot(d, r, cx=0.5, cy=0.5, fill=INK):
    d.ellipse([(cx - r) * W, (cy - r) * W, (cx + r) * W, (cy + r) * W], fill=fill)


# ------------------------------------------------------------- brackets
def bracket(d, x, side, top, bot, t, arm):
    vbar(d, x, top, bot, t)
    hbar(d, min(x, x + side * arm), max(x, x + side * arm), top + t / 2, t)
    hbar(d, min(x, x + side * arm), max(x, x + side * arm), bot - t / 2, t)


def b1_classic():
    """Heavier and tighter than the first attempt."""
    img = tile(); d = ImageDraw.Draw(img)
    bracket(d, 0.30, 1, 0.24, 0.76, 0.085, 0.145)
    bracket(d, 0.70, -1, 0.24, 0.76, 0.085, 0.145)
    return img


def b2_lines():
    """The excerpt is actually in there: three rules held by the brackets."""
    img = tile(); d = ImageDraw.Draw(img)
    bracket(d, 0.245, 1, 0.245, 0.755, 0.07, 0.10)
    bracket(d, 0.755, -1, 0.245, 0.755, 0.07, 0.10)
    for y, w in ((0.40, 0.26), (0.50, 0.34), (0.60, 0.20)):
        hbar(d, 0.5 - w / 2, 0.5 + w / 2, y, 0.062)
    return img


def b3_single():
    """One bracket only — asymmetric, and far less like code."""
    img = tile(); d = ImageDraw.Draw(img)
    bracket(d, 0.335, 1, 0.215, 0.785, 0.10, 0.20)
    for y, w in ((0.375, 0.20), (0.50, 0.26), (0.625, 0.15)):
        hbar(d, 0.60, 0.60 + w, y, 0.07)
    return img


def b4_corners():
    """Crop marks: framing a moment rather than quoting it."""
    img = tile(); d = ImageDraw.Draw(img)
    t, arm = 0.085, 0.20
    for cx, cy, sx, sy in ((0.255, 0.255, 1, 1), (0.745, 0.255, -1, 1),
                           (0.255, 0.745, 1, -1), (0.745, 0.745, -1, -1)):
        hbar(d, min(cx, cx + sx * arm), max(cx, cx + sx * arm), cy, t)
        vbar(d, cx, min(cy, cy + sy * arm), max(cy, cy + sy * arm), t)
    return img


def b5_soft():
    """Wide, rounded, generous — a quotation without the sharp corners."""
    img = tile(); d = ImageDraw.Draw(img)
    t = 0.10
    for x, a0, a1 in ((0.36, 90, 270), (0.64, -90, 90)):
        d.arc([(x - 0.16) * W, 0.24 * W, (x + 0.16) * W, 0.76 * W],
              a0, a1, fill=INK, width=int(t * W))
    return img


def b6_dot():
    """Brackets holding a single point: this moment, right here."""
    img = tile(); d = ImageDraw.Draw(img)
    bracket(d, 0.275, 1, 0.27, 0.73, 0.08, 0.13)
    bracket(d, 0.725, -1, 0.27, 0.73, 0.08, 0.13)
    dot(d, 0.085)
    return img


# ---------------------------------------------------------------- rings
def r1_classic():
    """The baseline, tuned: two rings and a solid centre."""
    img = tile(); d = ImageDraw.Draw(img)
    ring(d, 0.345, 0.07)
    ring(d, 0.225, 0.07)
    dot(d, 0.085)
    return img


def r2_broken():
    """Rings with a bite taken out — no longer a target."""
    img = tile(); d = ImageDraw.Draw(img)
    arc(d, 0.345, 0.075, 55, 335)
    arc(d, 0.225, 0.075, 55, 335)
    dot(d, 0.085)
    return img


def r3_emanate():
    """Arcs opening away from a point: sound leaving a mouth."""
    img = tile(); d = ImageDraw.Draw(img)
    dot(d, 0.085, cx=0.315, cy=0.5)
    for r, t in ((0.20, 0.075), (0.325, 0.075), (0.45, 0.075)):
        d.arc([(0.315 - r) * W, (0.5 - r) * W, (0.315 + r) * W, (0.5 + r) * W],
              -58, 58, fill=INK, width=int(t * W))
    return img


def r4_grow():
    """Each ring heavier than the last: something building in the room."""
    img = tile(); d = ImageDraw.Draw(img)
    ring(d, 0.355, 0.095)
    ring(d, 0.235, 0.062)
    dot(d, 0.055)
    return img


def r5_offset():
    """Concentric rings, off-centre core — static shape, moving feel."""
    img = tile(); d = ImageDraw.Draw(img)
    ring(d, 0.345, 0.07)
    ring(d, 0.225, 0.07)
    dot(d, 0.085, cx=0.575, cy=0.44)
    return img


def r6_two():
    """The simplest it gets: one ring, one core. Holds at any size."""
    img = tile(); d = ImageDraw.Draw(img)
    ring(d, 0.335, 0.095)
    dot(d, 0.135)
    return img


FAMILIES = [
    ("brackets", [("v6-b1-classic", b1_classic), ("v6-b2-lines", b2_lines),
                  ("v6-b3-single", b3_single), ("v6-b4-corners", b4_corners),
                  ("v6-b5-soft", b5_soft), ("v6-b6-dot", b6_dot)]),
    ("rings", [("v6-r1-classic", r1_classic), ("v6-r2-broken", r2_broken),
               ("v6-r3-emanate", r3_emanate), ("v6-r4-grow", r4_grow),
               ("v6-r5-offset", r5_offset), ("v6-r6-two", r6_two)]),
]

SIZES = [128, 48, 24, 16]
PAD = 26
col_x, x = [], PAD + 165
for s in SIZES:
    col_x.append(x)
    x += 128 + PAD
sheet_w, row_h = x + PAD, 128 + PAD + 26

for fam, items in FAMILIES:
    for backdrop, bname in (((24, 25, 28, 255), "dark"), ((238, 238, 234, 255), "light")):
        sheet = Image.new("RGBA", (sheet_w, PAD + len(items) * row_h + PAD), backdrop)
        sd = ImageDraw.Draw(sheet)
        txt = (235, 235, 232) if bname == "dark" else (30, 30, 28)
        y = PAD
        for name, fn in items:
            big = fn().resize((S, S), Image.LANCZOS)
            sd.text((PAD, y + 54), name, fill=txt)
            for i, s in enumerate(SIZES):
                sheet.alpha_composite(big.resize((s, s), Image.LANCZOS), (col_x[i], y + (128 - s) // 2))
                sd.text((col_x[i], y + 132), f"{s}px", fill=txt)
            y += row_h
        sheet.save(os.path.join(OUT, f"{fam}-{bname}.png"))
        print("wrote", f"{fam}-{bname}.png")
    for name, fn in items:
        fn().resize((256, 256), Image.LANCZOS).save(os.path.join(OUT, f"{name}.png"))
print("listo")
