#!/usr/bin/env python3
"""Generate Crate's app icon: a warm vinyl record on a graphite squircle."""
import os
from PIL import Image, ImageDraw

S = 2048  # supersample, downscaled to 1024 at the end
img = Image.new("RGBA", (S, S), (0, 0, 0, 0))
d = ImageDraw.Draw(img)

# squircle background with a vertical graphite gradient
margin = int(S * 0.045)
radius = int(S * 0.225)
box = [margin, margin, S - margin, S - margin]

top = (0x22, 0x24, 0x2b)
bot = (0x0e, 0x0e, 0x11)
grad = Image.new("RGBA", (1, S), (0, 0, 0, 0))
for y in range(S):
    t = y / S
    grad.putpixel((0, y), (
        int(top[0] + (bot[0] - top[0]) * t),
        int(top[1] + (bot[1] - top[1]) * t),
        int(top[2] + (bot[2] - top[2]) * t),
        255,
    ))
grad = grad.resize((S, S))
mask = Image.new("L", (S, S), 0)
ImageDraw.Draw(mask).rounded_rectangle(box, radius=radius, fill=255)
img.paste(grad, (0, 0), mask)

d = ImageDraw.Draw(img)
cx = cy = S // 2

# vinyl disc
disc_r = int(S * 0.33)
d.ellipse([cx - disc_r, cy - disc_r, cx + disc_r, cy + disc_r], fill=(0x14, 0x13, 0x17, 255))

# concentric grooves
for i in range(10):
    rr = int(disc_r * (0.42 + i * 0.058))
    a = 26 if i % 2 == 0 else 16
    d.ellipse([cx - rr, cy - rr, cx + rr, cy + rr], outline=(255, 255, 255, a), width=max(2, S // 900))

# sheen streak via a faint arc band
sheen = Image.new("RGBA", (S, S), (0, 0, 0, 0))
sd = ImageDraw.Draw(sheen)
sd.pieslice([cx - disc_r, cy - disc_r, cx + disc_r, cy + disc_r], 200, 250, fill=(255, 255, 255, 22))
disc_mask = Image.new("L", (S, S), 0)
ImageDraw.Draw(disc_mask).ellipse([cx - disc_r, cy - disc_r, cx + disc_r, cy + disc_r], fill=255)
img.paste(Image.alpha_composite(img.copy(), sheen), (0, 0), disc_mask)
d = ImageDraw.Draw(img)

# amber label
lab_r = int(S * 0.108)
d.ellipse([cx - lab_r, cy - lab_r, cx + lab_r, cy + lab_r], fill=(0xd9, 0xa4, 0x41, 255))
d.ellipse([cx - lab_r, cy - lab_r, cx + lab_r, cy + lab_r], outline=(0x20, 0x17, 0x00, 40), width=S // 340)

# center hole
hole_r = int(S * 0.022)
d.ellipse([cx - hole_r, cy - hole_r, cx + hole_r, cy + hole_r], fill=(0x12, 0x13, 0x16, 255))

out = img.resize((1024, 1024), Image.LANCZOS)
here = os.path.dirname(os.path.abspath(__file__))
png = os.path.join(here, "icon_1024.png")
out.save(png)
print("wrote", png)
