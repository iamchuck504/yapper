"""Generate the Actas app icon (.ico) — modern indigo->cyan gradient squircle
with a clean white soundwave glyph (audio / transcription)."""
import os

from PIL import Image, ImageDraw, ImageFilter

S = 1024
SS = 2  # supersample factor
W = S * SS
HERE = os.path.dirname(os.path.abspath(__file__))


def lerp(a, b, t):
    return tuple(int(a[i] + (b[i] - a[i]) * t) for i in range(3))


def diagonal_gradient(size, c1, c2):
    """Smooth top-left -> bottom-right gradient."""
    base = Image.new("RGB", (size, size))
    px = base.load()
    for y in range(size):
        for x in range(size):
            t = (x + y) / (2 * (size - 1))
            px[x, y] = lerp(c1, c2, t)
    return base


def rounded_mask(size, radius):
    m = Image.new("L", (size, size), 0)
    ImageDraw.Draw(m).rounded_rectangle([0, 0, size - 1, size - 1], radius=radius, fill=255)
    return m


# ---- background squircle ----
indigo = (99, 91, 240)   # deeper, richer indigo
cyan = (34, 197, 230)    # vivid cyan
grad = diagonal_gradient(W, indigo, cyan).convert("RGBA")

# soft radial sheen, top-center (subtle, keeps the colors saturated)
sheen = Image.new("L", (W, W), 0)
ImageDraw.Draw(sheen).ellipse([W * 0.05, -W * 0.55, W * 0.95, W * 0.4], fill=55)
sheen = sheen.filter(ImageFilter.GaussianBlur(W * 0.14))
grad = Image.composite(Image.new("RGBA", (W, W), (255, 255, 255, 255)), grad, sheen)

mask = rounded_mask(W, int(W * 0.235))
icon = Image.new("RGBA", (W, W), (0, 0, 0, 0))
icon.paste(grad, (0, 0), mask)

# ---- soundwave glyph ----
# bar heights as fraction of the glyph height, symmetric and lively
heights = [0.34, 0.62, 0.92, 1.0, 0.72, 0.46, 0.28]
n = len(heights)
glyph_h = W * 0.46
gap = W * 0.018
bar_w = (W * 0.52 - gap * (n - 1)) / n
total_w = bar_w * n + gap * (n - 1)
x0 = (W - total_w) / 2
cy = W * 0.5

shadow = Image.new("RGBA", (W, W), (0, 0, 0, 0))
ds = ImageDraw.Draw(shadow)
bars = Image.new("RGBA", (W, W), (0, 0, 0, 0))
db = ImageDraw.Draw(bars)

for i, hf in enumerate(heights):
    h = glyph_h * hf
    x = x0 + i * (bar_w + gap)
    rect = [x, cy - h / 2, x + bar_w, cy + h / 2]
    r = bar_w / 2
    ds.rounded_rectangle([rect[0], rect[1] + W * 0.012, rect[2], rect[3] + W * 0.012],
                         radius=r, fill=(20, 30, 70, 90))
    db.rounded_rectangle(rect, radius=r, fill=(255, 255, 255, 255))

shadow = shadow.filter(ImageFilter.GaussianBlur(W * 0.012))
icon = Image.alpha_composite(icon, shadow)
icon = Image.alpha_composite(icon, bars)

# subtle inner edge for crispness
edge = Image.new("RGBA", (W, W), (0, 0, 0, 0))
ImageDraw.Draw(edge).rounded_rectangle([2, 2, W - 3, W - 3], radius=int(W * 0.235),
                                       outline=(255, 255, 255, 40), width=max(2, SS * 2))
icon = Image.alpha_composite(icon, edge)

# ---- downsample & export ----
icon = icon.resize((S, S), Image.LANCZOS)
out_ico = os.path.join(HERE, "app.ico")
out_png = os.path.join(HERE, "app.png")
base = icon.resize((256, 256), Image.LANCZOS)
base.save(out_png)
base.save(out_ico, sizes=[(256, 256), (128, 128), (64, 64), (48, 48), (32, 32), (24, 24), (16, 16)])
print(f"wrote {out_ico} and {out_png}")
