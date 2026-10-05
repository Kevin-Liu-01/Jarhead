"""cards.py · the image half of scripts/make-cards.sh (python3 with Pillow).

  still <in.png> <out.png> <w> <h> [corner] [2x]  a 4x capture of a half-size layout, halved exactly (BOX), so a 1.5 px
                                               cell is a crisp 3 px; `corner` rounds the picture's corners (px of w x h,
                                               antialiased); `2x` keeps the whole capture (2w x 2h, 6 px cells) for a
                                               picture shown at w on a Retina screen
  gif <dir> <n> <ms> <poster> <out.gif> [corner]  the GIF's captures g000..g<n-1>.png on one shared palette, no dither,
                                               `ms` a frame, starting at frame `poster` (the loop is unchanged),
                                               its corners rounded to `corner` px (a hard edge: a GIF has no partial alpha)
  sheet <dir> <n> <out.png>                    every fifth GIF capture, numbered, for choosing the poster by eye
  small <png> ...                              each picture at 600 and 300 px wide (LANCZOS), as a feed shows it
"""
import os
import sys

from PIL import Image, ImageChops, ImageDraw


def rounded(im: Image.Image, corner: int) -> Image.Image:
    """The picture with its corners rounded to `corner` px, the mask drawn at 4x and brought down (antialiased)."""
    s = 4
    mask = Image.new("L", (im.width * s, im.height * s), 0)
    ImageDraw.Draw(mask).rounded_rectangle((0, 0, im.width * s - 1, im.height * s - 1), radius=corner * s, fill=255)
    out = im.convert("RGBA")
    out.putalpha(mask.resize(im.size, Image.Resampling.LANCZOS))
    return out


def still(src: str, out: str, w: int, h: int, corner: int = 0, x2: bool = False) -> None:
    im = Image.open(src).convert("RGB")
    if im.size != (w * 2, h * 2):
        sys.exit(f"{src}: captured {im.size}, wanted {(w * 2, h * 2)} (the 4x scale did not take)")
    s = 2 if x2 else 1
    if not x2:
        im = im.resize((w, h), Image.Resampling.BOX)
    if corner > 0:
        im = rounded(im, corner * s)
    im.save(out, optimize=True)
    print(out, im.width, "x", im.height, f"{os.path.getsize(out) // 1024} KB")


def gif(d: str, n: int, ms: int, poster: int, out: str, corner: int = 0) -> None:
    frames = [Image.open(os.path.join(d, f"g{i:03d}.png")).convert("RGB") for i in range(n)]
    frames = frames[poster:] + frames[:poster]
    # one palette for every frame (no flicker), from a spread of frames across the loop; no dither over the page's own.
    # The page's ramps and the type's antialias fit in 127 colours; the 128th is clear, for the rounded corners.
    pick = frames[:: max(1, n // 12)]
    w, h = frames[0].size
    strip = Image.new("RGB", (w, h * len(pick)))
    for k, f in enumerate(pick):
        strip.paste(f, (0, h * k))
    pal = strip.quantize(colors=127, method=Image.Quantize.MEDIANCUT, dither=Image.Dither.NONE)
    # The frames are mapped to exactly these 127 (padded with the last), so no pixel, the type's black ink included, can
    # land on the clear index; the clear joins the palette only after.
    ramp = (pal.getpalette() or [])[: 127 * 3]
    ramp += ramp[-3:] * (127 - len(ramp) // 3)
    # The ground (the commonest colour) gets an entry of its own, exactly: Pillow maps colours to a palette through a
    # coarse cache, which can send the paper to a pale tint beside it, so the plate would not end on the banners' paper.
    ground = max(strip.getcolors(strip.width * strip.height) or [(0, (0, 0, 0))])[1]
    entries = [tuple(ramp[i : i + 3]) for i in range(0, 127 * 3, 3)]
    gi = min(range(127), key=lambda i: sum((a - b) ** 2 for a, b in zip(entries[i], ground)))
    ramp[gi * 3 : gi * 3 + 3] = list(ground)
    pal.putpalette(ramp)
    solid = Image.new("RGB", (w, h), ground)
    # the corners: a GIF has no partial alpha, so the arc is a hard edge, one pixel at a time
    off = Image.new("L", (w, h), 255)
    if corner > 0:
        ImageDraw.Draw(off).rounded_rectangle((0, 0, w - 1, h - 1), radius=corner, fill=0)
    else:
        off.paste(0, (0, 0, w, h))
    q = []
    for f in frames:
        g = f.quantize(palette=pal, dither=Image.Dither.NONE)
        g.putpalette(ramp + [0, 0, 0])
        r, gr, b = ImageChops.difference(f, solid).split()
        g.paste(gi, mask=ImageChops.lighter(ImageChops.lighter(r, gr), b).point(lambda v: 255 if v == 0 else 0))
        g.paste(127, mask=off)
        q.append(g)
    q[0].save(out, save_all=True, append_images=q[1:], duration=ms, loop=0, disposal=1, transparency=127, optimize=False)
    print(out, w, "x", h, n, "frames", round(n * ms / 1000, 2), "s", round(os.path.getsize(out) / 1e6, 2), "MB")


def sheet(d: str, n: int, out: str) -> None:
    idx = list(range(0, n, 5))
    first = Image.open(os.path.join(d, "g000.png")).convert("RGB")
    tw, th = first.width // 2, first.height // 2
    cols = 5
    rows = (len(idx) + cols - 1) // cols
    s = Image.new("RGB", (cols * (tw + 6), rows * (th + 18)), (128, 128, 128))
    pen = ImageDraw.Draw(s)
    for k, i in enumerate(idx):
        im = Image.open(os.path.join(d, f"g{i:03d}.png")).convert("RGB").resize((tw, th), Image.Resampling.BOX)
        x, y = (k % cols) * (tw + 6), (k // cols) * (th + 18)
        pen.text((x + 2, y + 2), str(i), fill=(255, 255, 255))
        s.paste(im, (x, y + 16))
    s.save(out)
    print(out, len(idx), "frames")


def small(paths: list[str]) -> None:
    for p in paths:
        im = Image.open(p).convert("RGBA")
        for w in (600, 300):
            im.resize((w, round(im.height * w / im.width)), Image.Resampling.LANCZOS).save(f"{p[:-4]}-{w}.png")


if __name__ == "__main__":
    c, a = (sys.argv[1], sys.argv[2:]) if len(sys.argv) > 1 else ("", [])
    if c == "still":
        still(a[0], a[1], int(a[2]), int(a[3]), int(a[4]) if len(a) > 4 else 0, len(a) > 5 and a[5] == "2x")
    elif c == "gif":
        gif(a[0], int(a[1]), int(a[2]), int(a[3]), a[4], int(a[5]) if len(a) > 5 else 0)
    elif c == "sheet":
        sheet(a[0], int(a[1]), a[2])
    elif c == "small":
        small(a)
    else:
        print(__doc__)
        sys.exit(2)
