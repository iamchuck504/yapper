"""Yapper mark, take two.

The first mark was a plain geometric Y: the "several voices becoming one" idea
was not visible, and a uniform round-capped stroke has no craft in it. These
candidates draw real shapes — tapered ribbons, curves, uneven ink — so the
merge reads, and so the glyph looks drawn rather than defaulted.
"""
import math
import os

from PIL import Image, ImageDraw

HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(HERE, "icon-v2")
os.makedirs(OUT, exist_ok=True)

S, SS = 512, 4
W = S * SS

AMBER = (224, 164, 88, 255)
AMBER_DEEP = (206, 141, 62, 255)
INK = (12, 13, 16, 255)
BONE = (235, 231, 223, 255)


# ---------------------------------------------------------------- primitives
def bezier(p0, p1, p2, n=64):
    """Quadratic bezier sampled into points (tile fractions)."""
    out = []
    for i in range(n + 1):
        t = i / n
        u = 1 - t
        out.append((u * u * p0[0] + 2 * u * t * p1[0] + t * t * p2[0],
                    u * u * p0[1] + 2 * u * t * p1[1] + t * t * p2[1]))
    return out


def ribbon(pts, w0, w1, wobble=0.0):
    """Outline polygon of a stroke whose width runs from w0 to w1."""
    left, right = [], []
    n = len(pts)
    for i, (x, y) in enumerate(pts):
        t = i / (n - 1)
        w = (w0 + (w1 - w0) * t) / 2
        if wobble:
            w *= 1 + math.sin(t * 9.1 + x * 7) * wobble
        # direction from neighbours
        a = pts[max(0, i - 1)]
        b = pts[min(n - 1, i + 1)]
        dx, dy = b[0] - a[0], b[1] - a[1]
        ln = math.hypot(dx, dy) or 1e-6
        nx, ny = -dy / ln, dx / ln
        left.append(((x + nx * w) * W, (y + ny * w) * W))
        right.append(((x - nx * w) * W, (y - ny * w) * W))
    return left + right[::-1]


def tile(bg):
    img = Image.new("RGBA", (W, W), (0, 0, 0, 0))
    mask = Image.new("L", (W, W), 0)
    ImageDraw.Draw(mask).rounded_rectangle([0, 0, W - 1, W - 1], radius=int(W * 0.225), fill=255)
    img.paste(Image.new("RGBA", (W, W), bg), (0, 0), mask)
    return img, mask


def cap(d, p, r, fill):
    d.ellipse([p[0] * W - r * W / 2, p[1] * W - r * W / 2,
               p[0] * W + r * W / 2, p[1] * W + r * W / 2], fill=fill)


# ---------------------------------------------------------------- candidates
def a_taper():
    """Two voices, different weights, thinning as they join a solid stem."""
    img, _ = tile(AMBER)
    d = ImageDraw.Draw(img)
    join = (0.50, 0.56)
    d.polygon(ribbon([(0.245, 0.25), join], 0.145, 0.085), fill=INK)
    d.polygon(ribbon([(0.755, 0.30), join], 0.105, 0.085), fill=INK)
    d.polygon(ribbon([join, (0.50, 0.775)], 0.155, 0.155), fill=INK)
    cap(d, (0.50, 0.775), 0.155, INK)
    return img


def b_confluence():
    """Curved, like two streams meeting — the join is a swell, not a corner."""
    img, _ = tile(AMBER)
    d = ImageDraw.Draw(img)
    join = (0.50, 0.60)
    d.polygon(ribbon(bezier((0.235, 0.235), (0.30, 0.47), join), 0.135, 0.10), fill=INK)
    d.polygon(ribbon(bezier((0.765, 0.235), (0.70, 0.47), join), 0.135, 0.10), fill=INK)
    d.polygon(ribbon([join, (0.50, 0.79)], 0.175, 0.145), fill=INK)
    cap(d, (0.50, 0.79), 0.145, INK)
    return img


def c_three():
    """A meeting is more than two people: three strokes into one stem."""
    img, _ = tile(AMBER)
    d = ImageDraw.Draw(img)
    join = (0.50, 0.58)
    d.polygon(ribbon(bezier((0.20, 0.29), (0.30, 0.48), join), 0.115, 0.085), fill=INK)
    d.polygon(ribbon([(0.50, 0.20), join], 0.10, 0.085), fill=INK)
    d.polygon(ribbon(bezier((0.80, 0.29), (0.70, 0.48), join), 0.115, 0.085), fill=INK)
    d.polygon(ribbon([join, (0.50, 0.80)], 0.16, 0.16), fill=INK)
    cap(d, (0.50, 0.80), 0.16, INK)
    return img


def d_ink():
    """Drawn, not constructed: uneven edges and a little pooling at the join."""
    img, _ = tile(AMBER)
    d = ImageDraw.Draw(img)
    join = (0.505, 0.575)
    d.polygon(ribbon(bezier((0.245, 0.245), (0.315, 0.45), join), 0.14, 0.10, wobble=0.10), fill=INK)
    d.polygon(ribbon(bezier((0.765, 0.255), (0.695, 0.46), join), 0.125, 0.095, wobble=0.10), fill=INK)
    d.polygon(ribbon([join, (0.495, 0.785)], 0.165, 0.13, wobble=0.08), fill=INK)
    cap(d, join, 0.185, INK)                 # ink pools where the strokes meet
    cap(d, (0.495, 0.785), 0.13, INK)
    return img


def e_knockout():
    """The glyph cut out of the tile — the counter does the work."""
    img, mask = tile(AMBER)
    glyph = Image.new("L", (W, W), 0)
    g = ImageDraw.Draw(glyph)
    join = (0.50, 0.575)
    g.polygon(ribbon(bezier((0.235, 0.24), (0.31, 0.46), join), 0.15, 0.11), fill=255)
    g.polygon(ribbon(bezier((0.765, 0.24), (0.69, 0.46), join), 0.15, 0.11), fill=255)
    g.polygon(ribbon([join, (0.50, 0.80)], 0.175, 0.175), fill=255)
    g.ellipse([0.50 * W - 0.0875 * W, 0.80 * W - 0.0875 * W,
               0.50 * W + 0.0875 * W, 0.80 * W + 0.0875 * W], fill=255)
    out = Image.new("RGBA", (W, W), (0, 0, 0, 0))
    keep = Image.composite(Image.new("L", (W, W), 0), mask, glyph)
    out.paste(Image.new("RGBA", (W, W), AMBER), (0, 0), keep)
    return out


def f_quotes():
    """Speech, abstracted: two heavy marks that imply the same convergence."""
    img, _ = tile(AMBER)
    d = ImageDraw.Draw(img)
    for x, lean in ((0.335, 0.055), (0.605, 0.055)):
        pts = bezier((x + lean, 0.275), (x + lean * 0.2, 0.45), (x - lean * 0.6, 0.60))
        d.polygon(ribbon(pts, 0.155, 0.055), fill=INK)
        cap(d, (x + lean, 0.275), 0.155, INK)
    return img


CANDIDATES = [
    ("v2-a-taper", a_taper),
    ("v2-b-confluence", b_confluence),
    ("v2-c-three", c_three),
    ("v2-d-ink", d_ink),
    ("v2-e-knockout", e_knockout),
    ("v2-f-quotes", f_quotes),
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
    sheet.save(os.path.join(OUT, f"v2-{bname}.png"))
    print("wrote", f"v2-{bname}.png")

for name, fn in CANDIDATES:
    fn().resize((256, 256), Image.LANCZOS).save(os.path.join(OUT, f"{name}.png"))
print("listo")
