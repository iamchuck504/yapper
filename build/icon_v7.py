"""Expanding the soft-bracket idea.

Two facing curves read as parentheses — an aside, a moment held — and also as
two people turned toward each other. These push the idea: tapered brush-like
strokes, an overlap that forms a lens, a rule held between them, nesting.
"""
import math
import os

from PIL import Image, ImageDraw

HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(HERE, "icon-v7")
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


def arc_points(cx, cy, rx, ry, a0, a1, n=90):
    """Sampled ellipse arc, angles in degrees (0 = right, clockwise)."""
    pts = []
    for i in range(n + 1):
        a = math.radians(a0 + (a1 - a0) * i / n)
        pts.append((cx + math.cos(a) * rx, cy + math.sin(a) * ry))
    return pts


def ribbon(d, pts, w_end, w_mid, fill=INK):
    """Stroke whose width swells from w_end at the tips to w_mid in the middle."""
    left, right = [], []
    n = len(pts)
    for i, (x, y) in enumerate(pts):
        t = i / (n - 1)
        w = (w_end + (w_mid - w_end) * math.sin(t * math.pi)) / 2
        a = pts[max(0, i - 1)]
        b = pts[min(n - 1, i + 1)]
        dx, dy = b[0] - a[0], b[1] - a[1]
        ln = math.hypot(dx, dy) or 1e-6
        nx, ny = -dy / ln, dx / ln
        left.append(((x + nx * w) * W, (y + ny * w) * W))
        right.append(((x - nx * w) * W, (y - ny * w) * W))
    d.polygon(left + right[::-1], fill=fill)


def plain_arc(d, cx, cy, r, t, a0, a1, fill=INK):
    d.arc([(cx - r) * W, (cy - r) * W, (cx + r) * W, (cy + r) * W],
          a0, a1, fill=fill, width=int(t * W))


def hbar(d, x0, x1, y, t, fill=INK):
    r = t * W / 2
    d.rounded_rectangle([x0 * W, y * W - r, x1 * W, y * W + r], radius=r, fill=fill)


def dot(d, r, cx=0.5, cy=0.5, fill=INK):
    d.ellipse([(cx - r) * W, (cy - r) * W, (cx + r) * W, (cy + r) * W], fill=fill)


# ------------------------------------------------------------------ variants
def a_refined():
    """The original, tuned: heavier, and the gap opened up."""
    img = tile(); d = ImageDraw.Draw(img)
    plain_arc(d, 0.375, 0.5, 0.235, 0.105, 105, 255)
    plain_arc(d, 0.625, 0.5, 0.235, 0.105, -75, 75)
    return img


def b_taper():
    """Brush-like: thin at the tips, full in the belly."""
    img = tile(); d = ImageDraw.Draw(img)
    ribbon(d, arc_points(0.395, 0.5, 0.235, 0.265, 105, 255), 0.035, 0.135)
    ribbon(d, arc_points(0.605, 0.5, 0.235, 0.265, -75, 75), 0.035, 0.135)
    return img


def c_lens():
    """The curves overlap and cut a lens out of the middle."""
    img = tile(); d = ImageDraw.Draw(img)
    ribbon(d, arc_points(0.46, 0.5, 0.245, 0.275, 100, 260), 0.045, 0.145)
    ribbon(d, arc_points(0.54, 0.5, 0.245, 0.275, -80, 80), 0.045, 0.145)
    return img


def d_dot():
    """Two curves holding a single point between them."""
    img = tile(); d = ImageDraw.Draw(img)
    ribbon(d, arc_points(0.365, 0.5, 0.215, 0.255, 105, 255), 0.035, 0.12)
    ribbon(d, arc_points(0.635, 0.5, 0.215, 0.255, -75, 75), 0.035, 0.12)
    dot(d, 0.085)
    return img


def e_nested():
    """Two pairs: listening inside listening."""
    img = tile(); d = ImageDraw.Draw(img)
    ribbon(d, arc_points(0.335, 0.5, 0.245, 0.275, 108, 252), 0.03, 0.10)
    ribbon(d, arc_points(0.665, 0.5, 0.245, 0.275, -72, 72), 0.03, 0.10)
    ribbon(d, arc_points(0.435, 0.5, 0.145, 0.165, 108, 252), 0.03, 0.085)
    ribbon(d, arc_points(0.565, 0.5, 0.145, 0.165, -72, 72), 0.03, 0.085)
    return img


def f_asym():
    """One voice carries further than the other."""
    img = tile(); d = ImageDraw.Draw(img)
    ribbon(d, arc_points(0.375, 0.5, 0.265, 0.30, 100, 260), 0.04, 0.155)
    ribbon(d, arc_points(0.645, 0.5, 0.175, 0.20, -70, 70), 0.03, 0.095)
    return img


def g_rule():
    """The curves hold a chapter rule — the app's own motif, quoted."""
    img = tile(); d = ImageDraw.Draw(img)
    ribbon(d, arc_points(0.335, 0.5, 0.20, 0.255, 105, 255), 0.035, 0.115)
    ribbon(d, arc_points(0.665, 0.5, 0.20, 0.255, -75, 75), 0.035, 0.115)
    hbar(d, 0.40, 0.60, 0.5, 0.075)
    return img


def h_cradle():
    """Turned on its side: something resting in the middle."""
    img = tile(); d = ImageDraw.Draw(img)
    ribbon(d, arc_points(0.5, 0.375, 0.265, 0.235, 195, 345), 0.035, 0.135)
    ribbon(d, arc_points(0.5, 0.625, 0.265, 0.235, 15, 165), 0.035, 0.135)
    return img


CANDIDATES = [
    ("v7-a-refined", a_refined),
    ("v7-b-taper", b_taper),
    ("v7-c-lens", c_lens),
    ("v7-d-dot", d_dot),
    ("v7-e-nested", e_nested),
    ("v7-f-asym", f_asym),
    ("v7-g-rule", g_rule),
    ("v7-h-cradle", h_cradle),
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
    sheet.save(os.path.join(OUT, f"v7-{bname}.png"))
    print("wrote", f"v7-{bname}.png")

for name, fn in CANDIDATES:
    fn().resize((256, 256), Image.LANCZOS).save(os.path.join(OUT, f"{name}.png"))
print("listo")
