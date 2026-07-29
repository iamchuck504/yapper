"""Dial, continued — the fix for "it looks like a spinner" is a hand.

A ring of even marks reads as loading. Add something that points, or break the
ring, and the eye reads a dial instead. These keep the mark count low so the
shape still holds at 16 px.
"""
import math
import os

from PIL import Image, ImageDraw

HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(HERE, "icon-v5")
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


def polar(angle_deg, r):
    a = math.radians(angle_deg - 90)
    return (0.5 + math.cos(a) * r, 0.5 + math.sin(a) * r)


def seg(d, p0, p1, t, fill=INK):
    d.line([(p0[0] * W, p0[1] * W), (p1[0] * W, p1[1] * W)], fill=fill, width=int(t * W))
    r = t * W / 2
    for p in (p0, p1):
        d.ellipse([p[0] * W - r, p[1] * W - r, p[0] * W + r, p[1] * W + r], fill=fill)


def tick(d, angle, r0, r1, t, fill=INK):
    seg(d, polar(angle, r0), polar(angle, r1), t, fill)


def dot(d, r, fill=INK):
    d.ellipse([(0.5 - r) * W, (0.5 - r) * W, (0.5 + r) * W, (0.5 + r) * W], fill=fill)


# ------------------------------------------------------------------ variants
def a_hand8():
    """Eight marks and a hand: a dial, not a spinner."""
    img = tile()
    d = ImageDraw.Draw(img)
    for i in range(8):
        tick(d, i * 45, 0.275, 0.375, 0.062)
    seg(d, (0.5, 0.5), polar(60, 0.20), 0.085)
    dot(d, 0.055)
    return img


def b_hand4():
    """Only the quarters, and a hand — the least it can be and still read."""
    img = tile()
    d = ImageDraw.Draw(img)
    for i in range(4):
        tick(d, i * 90, 0.275, 0.385, 0.085)
    seg(d, (0.5, 0.5), polar(55, 0.215), 0.09)
    dot(d, 0.06)
    return img


def c_two_hands():
    """Two hands: unmistakably time, and the pair makes an asymmetric shape."""
    img = tile()
    d = ImageDraw.Draw(img)
    for i in range(4):
        tick(d, i * 90, 0.30, 0.385, 0.07)
    seg(d, (0.5, 0.5), polar(60, 0.225), 0.082)
    seg(d, (0.5, 0.5), polar(200, 0.155), 0.082)
    dot(d, 0.055)
    return img


def d_gap_hand():
    """Open dial plus hand: a gauge reading somewhere along its range."""
    img = tile()
    d = ImageDraw.Draw(img)
    for i in range(12):
        if i in (5, 6, 7):
            continue
        tick(d, i * 30, 0.285, 0.375, 0.058)
    seg(d, (0.5, 0.5), polar(45, 0.215), 0.088)
    dot(d, 0.058)
    return img


def e_arc_hand():
    """A three-quarter arc of marks with the hand at the open end."""
    img = tile()
    d = ImageDraw.Draw(img)
    for i in range(7):
        tick(d, -120 + i * 40, 0.285, 0.38, 0.068)
    seg(d, (0.5, 0.5), polar(120, 0.225), 0.09)
    dot(d, 0.06)
    return img


def f_hand_only():
    """No ring at all: a hand and a single mark for where it started."""
    img = tile()
    d = ImageDraw.Draw(img)
    tick(d, 0, 0.245, 0.375, 0.09)
    seg(d, (0.5, 0.5), polar(65, 0.235), 0.095)
    dot(d, 0.07)
    return img


CANDIDATES = [
    ("v5-a-hand8", a_hand8),
    ("v5-b-hand4", b_hand4),
    ("v5-c-two-hands", c_two_hands),
    ("v5-d-gap-hand", d_gap_hand),
    ("v5-e-arc-hand", e_arc_hand),
    ("v5-f-hand-only", f_hand_only),
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
    sheet.save(os.path.join(OUT, f"v5-{bname}.png"))
    print("wrote", f"v5-{bname}.png")

for name, fn in CANDIDATES:
    fn().resize((256, 256), Image.LANCZOS).save(os.path.join(OUT, f"{name}.png"))
print("listo")
