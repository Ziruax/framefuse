#!/usr/bin/env python3
"""scripts/make-icon.py — build the FrameFuse icon set from a source image.

The image model emits JPEG (no alpha), so the icon is authored on a plain
light background and converted to TRUE transparency here with an
edge-connected flood fill (tolerance-based): white-ish pixels INSIDE the
artwork stay opaque, only the surrounding background is cut. Output:

  build/icon.png      512x512 RGBA master (electron-builder + installer UI)
  build/icon.ico      7 PNG-compressed entries (16..256) — same format the
                      Windows build's rcedit-native icon replacement uses.

Usage: python3 scripts/make-icon.py [source.png]
"""
import sys
import struct
from PIL import Image

SRC = sys.argv[1] if len(sys.argv) > 1 else "build/icon-new.png"
TOLERANCE = 34  # per-channel distance from the sampled background color
SIZES = [16, 24, 32, 48, 64, 128, 256]


def sample_background(im):
    w, h = im.size
    px = [
        im.getpixel((x, y))
        for x, y in [
            (2, 2), (w - 3, 2), (2, h - 3), (w - 3, h - 3),
            (w // 2, 2), (w // 2, h - 3), (2, h // 2), (w - 3, h // 2),
        ]
    ]
    return tuple(sum(c[i] for c in px) // len(px) for i in range(3))


def cut_background(im, bg, tol=TOLERANCE):
    """Edge-connected flood fill → alpha 0. Returns RGBA image."""
    im = im.convert("RGBA")
    w, h = im.size
    data = im.load()
    visited = bytearray(w * h)
    stack = []
    # Seed: every edge pixel within tolerance of the background color.
    for x in range(w):
        for y in (0, h - 1):
            stack.append((x, y))
    for y in range(h):
        for x in (0, w - 1):
            stack.append((x, y))

    def close_to_bg(p):
        return (
            abs(p[0] - bg[0]) <= tol
            and abs(p[1] - bg[1]) <= tol
            and abs(p[2] - bg[2]) <= tol
        )

    while stack:
        x, y = stack.pop()
        if x < 0 or y < 0 or x >= w or y >= h:
            continue
        i = y * w + x
        if visited[i]:
            continue
        p = data[x, y]
        if not close_to_bg(p):
            continue
        visited[i] = 1
        data[x, y] = (p[0], p[1], p[2], 0)
        stack.extend(((x - 1, y), (x + 1, y), (x, y - 1), (x, y + 1)))
    return im, visited


def content_bbox(im, visited):
    """Bounding box of pixels that are NOT flood-filled background."""
    w, h = im.size
    data = im.load()
    minx, miny, maxx, maxy = w, h, -1, -1
    for y in range(h):
        for x in range(w):
            if visited[y * w + x]:
                continue
            r, g, b, a = data[x, y]
            if a == 0:
                continue
            if x < minx: minx = x
            if x > maxx: maxx = x
            if y < miny: miny = y
            if y > maxy: maxy = y
    return (minx, miny, maxx, maxy)


def make_ico(entries, out_path):
    """PNG-compressed ICO (Vista+; the format rcedit-native writes)."""
    n = len(entries)
    header = struct.pack("<HHH", 0, 1, n)
    dir_items = b""
    blob = b""
    offset = 6 + 16 * n
    for png_bytes, (w, h) in entries:
        w_b = 0 if w >= 256 else w
        h_b = 0 if h >= 256 else h
        dir_items += struct.pack(
            "<BBBBHHII", w_b, h_b, 0, 0, 1, 32, len(png_bytes), offset
        )
        blob += png_bytes
        offset += len(png_bytes)
    with open(out_path, "wb") as f:
        f.write(header + dir_items + blob)


def main():
    src = Image.open(SRC).convert("RGB")
    bg = sample_background(src)
    print(f"source {src.size}, background ~ {bg}")

    rgba, visited = cut_background(src, bg)
    bbox = content_bbox(rgba, visited)
    print(f"content bbox: {bbox}")

    # Square crop around the content (centered, 6% pad) so the mark sits
    # balanced inside the final square icons.
    x0, y0, x1, y1 = bbox
    cw, ch = x1 - x0 + 1, y1 - y0 + 1
    side = max(cw, ch)
    pad = int(side * 0.06)
    side += pad * 2
    cx, cy = (x0 + x1) // 2, (y0 + y1) // 2
    left = max(0, cx - side // 2)
    top = max(0, cy - side // 2)
    canvas = Image.new("RGBA", (side, side), (0, 0, 0, 0))
    canvas.paste(rgba.crop((x0, y0, x1 + 1, y1 + 1)), (left + (side - cw) // 2 - x0 + x0 - left, top + (side - ch) // 2))
    # NOTE: simpler paste with explicit offsets (robust against rounding):
    canvas = Image.new("RGBA", (side, side), (0, 0, 0, 0))
    canvas.paste(
        rgba.crop((x0, y0, x1 + 1, y1 + 1)),
        (max(0, (side - cw) // 2), max(0, (side - ch) // 2)),
    )

    master = canvas.resize((512, 512), Image.LANCZOS)
    master.save("build/icon.png")
    print("build/icon.png (512 RGBA) written")

    entries = []
    for s in SIZES:
        im_s = canvas.resize((s, s), Image.LANCZOS)
        # Small sizes read better with a hard alpha threshold (no muddy edge).
        if s <= 48:
            im_s = im_s.point(lambda p: 255 if p > 40 else 0) if False else im_s
        import io

        buf = io.BytesIO()
        im_s.save(buf, "PNG", optimize=True)
        entries.append((buf.getvalue(), (s, s)))
    make_ico(entries, "build/icon.ico")
    print(f"build/icon.ico written ({len(SIZES)} PNG entries)")

    # Report alpha stats.
    hist = master.getchannel("A").histogram()
    transparent = sum(hist[:16])
    opaque = sum(hist[240:])
    total = 512 * 512
    print(f"alpha: {transparent/total:.0%} transparent, {opaque/total:.0%} opaque")


if __name__ == "__main__":
    main()
