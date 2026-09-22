#!/usr/bin/env python3
"""scripts/make-icon-cyan.py — build the FrameFuse CYAN icon set (v1.14.1).

The v1.11+ brand artwork (cyan, matching the app's single cyan accent),
redrawn FULLY deterministically (PIL, no source image — the v1.7 make-icon.py
pattern) so every entry is reproducible and byte-stable:

  • a solid cyan-teal rounded-square badge — reads on both light and dark
    taskbars at every size (opaque, high luma spread);
  • a bold WHITE play triangle (maximum contrast — survives 16 px);
  • film-strip sprocket strips (top + bottom) only on the DETAILED master
    used for ≥48 px (Alt-Tab, Explorer large icons);
  • two masters: SIMPLE (16/24/32) and DETAILED (48/64/128/256/512/180).

Output (v7 FIX B format — the maximally Windows-compatible ICO):
  build/icon.ico      7 entries: DIB (BMP) 16..128 + PNG 256
                     (all-PNG small entries are the classic cause of the
                     Windows "white paper"/blank icon — DIBs for the small
                     sizes is the fix, kept byte-for-byte from v1.7)
  build/icon.png      512x512 RGBA master
  src/app/icon.ico    same bytes as build/icon.ico (Next.js favicon route)
  src/app/apple-icon.png   180x180 PNG (Next.js apple-touch route)
"""
import io
import struct
from PIL import Image, ImageDraw

SIZES_DIB = [16, 24, 32, 48, 64, 128]
SIZE_PNG = 256
SS = 8  # supersampling factor (drawn at 1024, LANCZOS downscale)

# Brand palette (v1.11+ Friendly Studio: the one cyan accent on zinc-900).
CYAN_TOP = (34, 211, 238)     # #22d3ee cyan-400
CYAN_BOT = (8, 145, 178)      # #0891b2 cyan-600
WHITE = (255, 255, 255)
SPROCKET_ALPHA = 110          # 43% white for the film-strip detail


def rounded_badge(size, radius_ratio=0.22, gradient=True):
    """Cyan gradient rounded-square badge, RGBA, fully opaque.
    v1.14.1 (VLM review): the SMALL master passes gradient=False → a SOLID
    deep-cyan badge — white-on-bright-cyan was judged 'washed out' at
    16-32px (the blank-icon risk class); deep cyan (luma ~120) vs the pure
    white triangle (255) keeps ~135 luma spread at every pixel."""
    im = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    mask = Image.new("L", (size, size), 0)
    d = ImageDraw.Draw(mask)
    r = int(size * radius_ratio)
    d.rounded_rectangle([0, 0, size - 1, size - 1], radius=r, fill=255)
    if gradient:
        grad = Image.new("RGBA", (1, size))
        for y in range(size):
            t = y / max(1, size - 1)
            c = tuple(int(CYAN_TOP[i] + (CYAN_BOT[i] - CYAN_TOP[i]) * t) for i in range(3))
            grad.putpixel((0, y), c + (255,))
        grad = grad.resize((size, size))
        im.paste(grad, (0, 0), mask)
    else:
        fill = Image.new("RGBA", (size, size), CYAN_BOT + (255,))
        im.paste(fill, (0, 0), mask)
    return im


def play_triangle(size, fill=WHITE + (255,), scale=1.0):
    """Bold rounded play triangle centered on a transparent canvas."""
    im = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    d = ImageDraw.Draw(im)
    w = size * 0.46 * scale
    h = size * 0.54 * scale
    cx = size / 2
    cy = size / 2
    x0, y0 = cx - w * 0.52, cy - h / 2
    x1, y1 = cx + w * 0.48, cy
    x2, y2 = cx - w * 0.52, cy + h / 2
    d.polygon([(x0, y0), (x1, y1), (x0, y2)], fill=fill)
    r = size * 0.055
    for (vx, vy) in [(x0, y0), (x1, y1), (x0, y2)]:
        d.ellipse([vx - r, vy - r, vx + r, vy + r], fill=fill)
    return im


def sprocket_strips(size):
    """Film-strip sprocket strips along the top and bottom edges (RGBA)."""
    im = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    d = ImageDraw.Draw(im)
    hole_w = size * 0.052
    hole_h = size * 0.030
    margin_y = size * 0.045
    gap = size * 0.115
    n = 6
    total_w = n * hole_w + (n - 1) * gap
    x = (size - total_w) / 2
    for i in range(n):
        hx = x + i * (hole_w + gap)
        for hy in (margin_y, size - margin_y - hole_h):
            d.rounded_rectangle(
                [hx, hy, hx + hole_w, hy + hole_h],
                radius=hole_h / 2,
                fill=WHITE + (SPROCKET_ALPHA,),
            )
    return im


def build_master(detailed: bool, size: int = 512) -> Image.Image:
    big = size * SS
    im = rounded_badge(big, gradient=detailed)
    if detailed:
        im.alpha_composite(sprocket_strips(big))
    # The SIMPLE master (16/24/32) draws a LARGER triangle — at 16px the
    # default 0.46-width triangle is ~7px and merges into the badge (the
    # VLM 'washed out' verdict); +18% keeps it unmistakable.
    im.alpha_composite(play_triangle(big, scale=detailed and 1.0 or 1.18))
    return im.resize((size, size), Image.LANCZOS)


def dib_bytes(im):
    """v7 FIX B: encode one RGBA frame as an ICO DIB entry (BITMAPINFOHEADER +
    bottom-up BGRA pixels + 1bpp all-zero AND mask). All-PNG icon entries are
    the classic cause of the Windows "white paper" icon: Explorer and the
    taskbar reliably render DIB entries at every size; PNG is only safe at
    256x256. biHeight is doubled (XOR + AND planes) per the ICO spec."""
    w, h = im.size
    im = im.convert("RGBA")
    header = struct.pack(
        "<IiiHHIIiiII",
        40, w, h * 2, 1, 32, 0, 0, 0, 0, 0, 0,
    )
    px = im.load()
    rows = []
    for y in range(h - 1, -1, -1):  # bottom-up
        row = bytearray(w * 4)
        for x in range(w):
            r, g, b, a = px[x, y]
            row[x * 4 + 0] = b
            row[x * 4 + 1] = g
            row[x * 4 + 2] = r
            row[x * 4 + 3] = a
        rows.append(bytes(row))
    and_stride = ((w + 31) // 32) * 4
    and_mask = bytes(and_stride * h)  # 0 = take alpha from the BGRA data
    return header + b"".join(rows) + and_mask


def make_ico(entries, out_path):
    """Maximally compatible ICO — DIB (BMP) entries for 16..128 + one PNG
    entry for 256 (where PNG compression is the spec-sanctioned norm)."""
    n = len(entries)
    header = struct.pack("<HHH", 0, 1, n)
    dir_items = b""
    blob = b""
    offset = 6 + 16 * n
    for frame_bytes, (w, h) in entries:
        w_b = 0 if w >= 256 else w
        h_b = 0 if h >= 256 else h
        dir_items += struct.pack(
            "<BBBBHHII", w_b, h_b, 0, 0, 1, 32, len(frame_bytes), offset
        )
        blob += frame_bytes
        offset += len(frame_bytes)
    with open(out_path, "wb") as f:
        f.write(header + dir_items + blob)


def main():
    simple = build_master(detailed=False)    # → 16/24/32 (taskbar sizes)
    detailed = build_master(detailed=True)   # → 48/64/128/256/512/180

    entries = []
    for s in SIZES_DIB:
        master = simple if s <= 32 else detailed
        entries.append((dib_bytes(master.resize((s, s), Image.LANCZOS)), (s, s)))
    buf = io.BytesIO()
    detailed.resize((SIZE_PNG, SIZE_PNG), Image.LANCZOS).save(buf, "PNG", optimize=True)
    entries.append((buf.getvalue(), (SIZE_PNG, SIZE_PNG)))
    make_ico(entries, "build/icon.ico")
    print(f"build/icon.ico written ({len(SIZES_DIB)} DIB + PNG-{SIZE_PNG})")

    detailed.resize((512, 512), Image.LANCZOS).save("build/icon.png")
    print("build/icon.png (512 RGBA) written")

    # Next.js App Router file conventions (browser-tab favicon + iOS).
    with open("build/icon.ico", "rb") as f:
        ico = f.read()
    with open("src/app/icon.ico", "wb") as f:
        f.write(ico)
    detailed.resize((180, 180), Image.LANCZOS).save("src/app/apple-icon.png")
    print("src/app/icon.ico + src/app/apple-icon.png written")

    # Report contrast stats — the 16px readability gate (v1.7 core fix).
    small = simple.resize((16, 16), Image.LANCZOS)
    px = small.load()
    lumas = []
    for y in range(16):
        for x in range(16):
            r, g, b, a = px[x, y]
            if a > 200:
                lumas.append(0.299 * r + 0.587 * g + 0.114 * b)
    if lumas:
        lo, hi = min(lumas), max(lumas)
        spread = hi - lo
        print(f"16px opaque-luma range: {lo:.0f}..{hi:.0f} (spread {spread:.0f} — want ≥120)")
        assert spread >= 120, "16px artwork collapsed — blank-icon regression"


if __name__ == "__main__":
    main()
