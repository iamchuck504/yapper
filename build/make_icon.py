"""Generate the Actas app icon (.ico) — lead-gray gradient background,
note sheet with a pencil in the center."""
import math
import os

from PIL import Image, ImageDraw, ImageFilter

S = 1024
HERE = os.path.dirname(os.path.abspath(__file__))


def rotate_point(x, y, cx, cy, deg):
    rad = math.radians(deg)
    dx, dy = x - cx, y - cy
    return (
        cx + dx * math.cos(rad) - dy * math.sin(rad),
        cy + dx * math.sin(rad) + dy * math.cos(rad),
    )


def vertical_gradient(size, top, bottom):
    strip = Image.new("RGB", (1, size))
    for y in range(size):
        t = y / (size - 1)
        strip.putpixel((0, y), tuple(int(top[i] + (bottom[i] - top[i]) * t) for i in range(3)))
    return strip.resize((size, size))


# ---- background: rounded square, lead-gray gradient ----
bg = vertical_gradient(S, (172, 178, 190), (84, 90, 104)).convert("RGBA")

# soft radial highlight top-center for the "difuminado" feel
hl = Image.new("L", (S, S), 0)
ImageDraw.Draw(hl).ellipse([S * 0.05, -S * 0.45, S * 0.95, S * 0.55], fill=70)
hl = hl.filter(ImageFilter.GaussianBlur(120))
bg = Image.composite(Image.new("RGBA", (S, S), (255, 255, 255, 255)), bg, hl.point(lambda v: v))

mask = Image.new("L", (S, S), 0)
ImageDraw.Draw(mask).rounded_rectangle([0, 0, S - 1, S - 1], radius=int(S * 0.22), fill=255)
icon = Image.new("RGBA", (S, S), (0, 0, 0, 0))
icon.paste(bg, (0, 0), mask)

# ---- note sheet shadow ----
shadow = Image.new("RGBA", (S, S), (0, 0, 0, 0))
ImageDraw.Draw(shadow).rounded_rectangle(
    [S * 0.255, S * 0.215, S * 0.755, S * 0.815], radius=int(S * 0.045), fill=(20, 24, 34, 110)
)
shadow = shadow.filter(ImageFilter.GaussianBlur(28))
icon = Image.alpha_composite(icon, shadow)

# ---- note sheet ----
sheet = Image.new("RGBA", (S, S), (0, 0, 0, 0))
d = ImageDraw.Draw(sheet)
x0, y0, x1, y1 = S * 0.245, S * 0.195, S * 0.745, S * 0.795
d.rounded_rectangle([x0, y0, x1, y1], radius=int(S * 0.045), fill=(248, 249, 252, 255))

# text lines: a wider title line + body lines
pad = S * 0.055
lw = int(S * 0.030)
line_x0 = x0 + pad
title_y = y0 + pad + lw // 2
d.rounded_rectangle(
    [line_x0, title_y - lw * 0.65, line_x0 + (x1 - x0) * 0.42, title_y + lw * 0.65],
    radius=lw, fill=(110, 123, 242, 255),
)
for i in range(4):
    ly = y0 + pad * 2.4 + i * S * 0.085
    width = (x1 - x0) - pad * 2 if i < 3 else (x1 - x0) * 0.45
    d.rounded_rectangle(
        [line_x0, ly - lw / 2, line_x0 + width, ly + lw / 2],
        radius=lw, fill=(196, 201, 213, 255),
    )

icon = Image.alpha_composite(icon, sheet)

# ---- pencil, rotated 45°, tip toward the sheet ----
pencil = Image.new("RGBA", (S, S), (0, 0, 0, 0))
d = ImageDraw.Draw(pencil)
pw = S * 0.085                      # pencil width
plen = S * 0.46                     # body length
cx, cy = S * 0.615, S * 0.615      # pivot near sheet lower-right
# pencil drawn pointing down (tip at bottom), then rotated -45 so tip points lower-left
bx0, bx1 = cx - pw / 2, cx + pw / 2
by0, by1 = cy - plen, cy
body = [(bx0, by0), (bx1, by0), (bx1, by1), (bx0, by1)]
tip = [(bx0, by1), (bx1, by1), (cx, by1 + pw * 1.25)]
lead = [(cx - pw * 0.18, by1 + pw * 0.79), (cx + pw * 0.18, by1 + pw * 0.79), (cx, by1 + pw * 1.25)]
eraser = [(bx0, by0), (bx1, by0), (bx1, by0 + pw * 0.55), (bx0, by0 + pw * 0.55)]

ANG = -45
d.polygon([rotate_point(x, y, cx, cy, ANG) for x, y in body], fill=(58, 63, 76, 255))
d.polygon([rotate_point(x, y, cx, cy, ANG) for x, y in tip], fill=(233, 196, 144, 255))
d.polygon([rotate_point(x, y, cx, cy, ANG) for x, y in lead], fill=(40, 44, 54, 255))
d.polygon([rotate_point(x, y, cx, cy, ANG) for x, y in eraser], fill=(110, 123, 242, 255))
# center groove along the body
g0 = rotate_point(cx, by0 + pw * 0.7, cx, cy, ANG)
g1 = rotate_point(cx, by1 - pw * 0.1, cx, cy, ANG)
d.line([g0, g1], fill=(78, 84, 99, 255), width=int(pw * 0.14))

icon = Image.alpha_composite(icon, pencil)

# ---- export ----
out_ico = os.path.join(HERE, "app.ico")
out_png = os.path.join(HERE, "app.png")
base = icon.resize((256, 256), Image.LANCZOS)
base.save(out_png)
base.save(out_ico, sizes=[(256, 256), (128, 128), (64, 64), (48, 48), (32, 32), (24, 24), (16, 16)])
print(f"wrote {out_ico} and {out_png}")
