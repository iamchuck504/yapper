"""Yapper mark — variations on the dial.

The first dial looked good large but turned into a fuzzy radial blur at 24 and
16 px, and perfectly uniform ticks read as a loading spinner. Every variation
here does something about that: fewer and heavier marks, or a broken symmetry
so the eye reads a dial rather than "loading".
"""
import math
import os

from PIL import Image, ImageDraw

HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(HERE, "icon-v4")
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


def tick(d, angle_deg, r0, r1, t, fill=INK):
    """A radial mark from radius r0 to r1, thickness t (tile fractions)."""
    a = math.radians(angle_deg - 90)
    p0 = (0.5 + math.cos(a) * r0, 0.5 + math.sin(a) * r0)
    p1 = (0.5 + math.cos(a) * r1, 0.5 + math.sin(a) * r1)
    d.line([(p0[0] * W, p0[1] * W), (p1[0] * W, p1[1] * W)], fill=fill, width=int(t * W))
    r = t * W / 2
    for p in (p0, p1):
        d.ellipse([p[0] * W - r, p[1] * W - r, p[0] * W + r, p[1] * W + r], fill=fill)


def dot(d, r, fill=INK):
    d.ellipse([(0.5 - r) * W, (0.5 - r) * W, (0.5 + r) * W, (0.5 + r) * W], fill=fill)


# ------------------------------------------------------------------ variants
def a_eight():
    """Eight heavy marks: the same dial, rebuilt to survive 16 px."""
    img = tile()
    d = ImageDraw.Draw(img)
    for i in range(8):
        tick(d, i * 45, 0.215, 0.365, 0.088)
    return img


def b_quarters():
    """Twelve marks with the quarters emphasised — hierarchy, not a spinner."""
    img = tile()
    d = ImageDraw.Draw(img)
    for i in range(12):
        quarter = i % 3 == 0
        r0 = 0.205 if quarter else 0.275
        tick(d, i * 30, r0, 0.365, 0.09 if quarter else 0.05)
    return img


def c_gap():
    """An open dial: the missing marks read as a gauge, never as loading."""
    img = tile()
    d = ImageDraw.Draw(img)
    for i in range(12):
        if i in (5, 6, 7):
            continue
        tick(d, i * 30, 0.215, 0.365, 0.078)
    return img


def d_dot():
    """Marks around a solid centre: unmistakably a dial."""
    img = tile()
    d = ImageDraw.Draw(img)
    for i in range(8):
        tick(d, i * 45, 0.255, 0.385, 0.075)
    dot(d, 0.125)
    return img


def e_wave():
    """Mark length follows the room's volume — the meeting's audio, wrapped."""
    img = tile()
    d = ImageDraw.Draw(img)
    n = 16
    for i in range(n):
        amp = 0.5 + 0.5 * math.sin(i / n * math.pi * 4)
        tick(d, i * (360 / n), 0.215, 0.245 + amp * 0.125, 0.056)
    return img


def f_marker():
    """One mark reaches further: the moment the meeting turned."""
    img = tile()
    d = ImageDraw.Draw(img)
    for i in range(12):
        if i == 2:
            continue
        tick(d, i * 30, 0.255, 0.355, 0.056)
    tick(d, 60, 0.10, 0.375, 0.098)
    return img


def g_arc():
    """Three quarters of a dial: reads as progress rather than a circle."""
    img = tile()
    d = ImageDraw.Draw(img)
    for i in range(9):
        tick(d, -135 + i * 33.75, 0.215, 0.365, 0.08)
    return img


def h_dual():
    """Two rings of marks: denser, more ornamental, still legible."""
    img = tile()
    d = ImageDraw.Draw(img)
    for i in range(6):
        tick(d, i * 60, 0.245, 0.375, 0.086)
    for i in range(6):
        tick(d, 30 + i * 60, 0.105, 0.185, 0.07)
    return img


CANDIDATES = [
    ("v4-a-eight", a_eight),
    ("v4-b-quarters", b_quarters),
    ("v4-c-gap", c_gap),
    ("v4-d-dot", d_dot),
    ("v4-e-wave", e_wave),
    ("v4-f-marker", f_marker),
    ("v4-g-arc", g_arc),
    ("v4-h-dual", h_dual),
]

SIZES = [128, 48, 24, 16]
PAD = 26
col_x, x = [], PAD + 165
for s in SIZES:
    col_x.append(x)
    x += 128 + PAD
sheet_w, row_h = x + PAD, 128 + PAD + 26

for backdrop, bname in (((24, 25, 28, 255), "dark"), ((238, 238, 234, 255), "light")):
    sheet = Image.new("RGBA", (sheet_w, PAD + len(CANDIDATES) * row_h + PAD), backdrop)
    sd = ImageDraw.Draw(sheet)
    txt = (235, 235, 232) if bname == "dark" else (30, 30, 28)
    y = PAD
    for name, fn in CANDIDATES:
        big = fn().resize((S, S), Image.LANCZOS)
        sd.text((PAD, y + 54), name, fill=txt)
        for i, s in enumerate(SIZES):
            sheet.alpha_composite(big.resize((s, s), Image.LANCZOS), (col_x[i], y + (128 - s) // 2))
            sd.text((col_x[i], y + 132), f"{s}px", fill=txt)
        y += row_h
    sheet.save(os.path.join(OUT, f"v4-{bname}.png"))
    print("wrote", f"v4-{bname}.png")

for name, fn in CANDIDATES:
    fn().resize((256, 256), Image.LANCZOS).save(os.path.join(OUT, f"{name}.png"))
print("listo")
