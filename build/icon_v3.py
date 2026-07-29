"""Yapper mark, take three — patterns instead of a monogram.

Each one tries to say something the app actually does: a long conversation
condensed, time being marked, several voices converging, a moment captured.
"""
import math
import os

from PIL import Image, ImageDraw

HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(HERE, "icon-v3")
os.makedirs(OUT, exist_ok=True)

S, SS = 512, 4
W = S * SS

AMBER = (224, 164, 88, 255)
INK = (12, 13, 16, 255)
INK_SOFT = (12, 13, 16, 110)


def tile(bg=AMBER):
    img = Image.new("RGBA", (W, W), (0, 0, 0, 0))
    mask = Image.new("L", (W, W), 0)
    ImageDraw.Draw(mask).rounded_rectangle([0, 0, W - 1, W - 1], radius=int(W * 0.225), fill=255)
    img.paste(Image.new("RGBA", (W, W), bg), (0, 0), mask)
    return img, mask


def hbar(d, x0, x1, y, t, fill=INK):
    r = t * W / 2
    d.rounded_rectangle([x0 * W, y * W - r, x1 * W, y * W + r], radius=r, fill=fill)


def vbar(d, x, y0, y1, t, fill=INK):
    r = t * W / 2
    d.rounded_rectangle([x * W - r, y0 * W, x * W + r, y1 * W], radius=r, fill=fill)


def stroke(d, p0, p1, t, fill=INK):
    d.line([(p0[0] * W, p0[1] * W), (p1[0] * W, p1[1] * W)], fill=fill, width=int(t * W))
    r = t * W / 2
    for p in (p0, p1):
        d.ellipse([p[0] * W - r, p[1] * W - r, p[0] * W + r, p[1] * W + r], fill=fill)


# ------------------------------------------------------------------ marks
def a_condense():
    """Lines getting shorter: an hour of talk becoming a handful of notes."""
    img, _ = tile()
    d = ImageDraw.Draw(img)
    ys = [0.30, 0.435, 0.57, 0.705]
    widths = [0.545, 0.435, 0.325, 0.185]
    for y, wdt in zip(ys, widths):
        hbar(d, 0.228, 0.228 + wdt, y, 0.082)
    return img


def b_clock():
    """Marks around a dial: the meeting measured, without drawing a clock."""
    img, _ = tile()
    d = ImageDraw.Draw(img)
    cx = cy = 0.5
    for i in range(12):
        a = math.radians(i * 30 - 90)
        long_tick = i % 3 == 0
        r0 = 0.245 if long_tick else 0.275
        r1 = 0.355
        stroke(d, (cx + math.cos(a) * r0, cy + math.sin(a) * r0),
               (cx + math.cos(a) * r1, cy + math.sin(a) * r1),
               0.062 if long_tick else 0.05)
    return img


def c_rings():
    """Rings spreading out — a room being listened to."""
    img, _ = tile()
    d = ImageDraw.Draw(img)
    for r, t in ((0.345, 0.062), (0.235, 0.062), (0.125, 0.125)):
        if t >= 0.12:
            d.ellipse([(0.5 - r) * W, (0.5 - r) * W, (0.5 + r) * W, (0.5 + r) * W], fill=INK)
        else:
            d.ellipse([(0.5 - r) * W, (0.5 - r) * W, (0.5 + r) * W, (0.5 + r) * W],
                      outline=INK, width=int(t * W))
    return img


def d_converge():
    """Many lines running into one point: voices arriving at a single note."""
    img, _ = tile()
    d = ImageDraw.Draw(img)
    focus = (0.5, 0.80)
    for i in range(7):
        x = 0.18 + i * (0.64 / 6)
        stroke(d, (x, 0.22), focus, 0.045)
    d.ellipse([(0.5 - 0.075) * W, (0.80 - 0.075) * W, (0.5 + 0.075) * W, (0.80 + 0.075) * W], fill=INK)
    return img


def e_fold():
    """A folded sheet: the page that comes out of the meeting."""
    img, _ = tile()
    d = ImageDraw.Draw(img)
    d.polygon([(0.24 * W, 0.24 * W), (0.76 * W, 0.24 * W),
               (0.76 * W, 0.545 * W), (0.24 * W, 0.76 * W)], fill=INK)
    d.polygon([(0.76 * W, 0.545 * W), (0.76 * W, 0.76 * W), (0.24 * W, 0.76 * W)], fill=INK_SOFT)
    return img


def f_bracket():
    """Brackets: an excerpt lifted out of a longer thing."""
    img, _ = tile()
    d = ImageDraw.Draw(img)
    t = 0.075
    for x, side in ((0.285, 1), (0.715, -1)):
        vbar(d, x, 0.255, 0.745, t)
        hbar(d, min(x, x + side * 0.135), max(x, x + side * 0.135), 0.255 + t / 2, t)
        hbar(d, min(x, x + side * 0.135), max(x, x + side * 0.135), 0.745 - t / 2, t)
    return img


def g_pulse():
    """A rule with one beat lifted out of it: the moment that mattered."""
    img, _ = tile()
    d = ImageDraw.Draw(img)
    hbar(d, 0.19, 0.435, 0.60, 0.075)
    hbar(d, 0.565, 0.81, 0.60, 0.075)
    hbar(d, 0.435, 0.565, 0.365, 0.075)
    vbar(d, 0.4655, 0.365, 0.60, 0.075)
    return img


def h_spine():
    """The app's own motif: a column of time with its chapters marked."""
    img, _ = tile()
    d = ImageDraw.Draw(img)
    vbar(d, 0.335, 0.215, 0.785, 0.055)
    for y, ln in ((0.30, 0.30), (0.44, 0.22), (0.58, 0.34), (0.715, 0.17)):
        hbar(d, 0.395, 0.395 + ln, y, 0.075)
    return img


CANDIDATES = [
    ("v3-a-condense", a_condense),
    ("v3-b-clock", b_clock),
    ("v3-c-rings", c_rings),
    ("v3-d-converge", d_converge),
    ("v3-e-fold", e_fold),
    ("v3-f-bracket", f_bracket),
    ("v3-g-pulse", g_pulse),
    ("v3-h-spine", h_spine),
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
    sheet.save(os.path.join(OUT, f"v3-{bname}.png"))
    print("wrote", f"v3-{bname}.png")

for name, fn in CANDIDATES:
    fn().resize((256, 256), Image.LANCZOS).save(os.path.join(OUT, f"{name}.png"))
print("listo")
