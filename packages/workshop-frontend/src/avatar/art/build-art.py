#!/usr/bin/env python3
"""Re-vendor the avatar art and rebuild the contact sheet.

The 1024 px PNG masters are **not** in this repo -- they are ~1.4 MB each, they are regenerated
rather than hand-edited, and git is the wrong place for either fact. They live in the art
workspace, alongside the prompts and the fal driver that produced them:

    ~/Documents/projects/avatar-refs/v2-bakeoff/chibi/
        <state>.png     the 11 masters
        NOTES.md        model, prompt pattern, per-state caveats, the honest weaknesses
        work/           the fal driver and the prompt scripts

What is vendored here is the shipping encode: 384 px WebP q88, which is 5.3x the 72 px presence bubble
and lands at ~28 KB a frame (~310 KB for the set).

    python3 src/avatar/art/build-art.py                     # re-encode + rebuild the sheet
    python3 src/avatar/art/build-art.py --src <dir>         # from a different master set
    python3 src/avatar/art/build-art.py --sheet-only        # sheet from the vendored WebP

The realistic track sits next door at `v2-bakeoff/realistic/` and is *banked, not wired*: same 11
states, same pipeline, chosen against at chat size because the detail does not survive the
downscale. Point `--src` at it if a larger avatar surface ever exists.

Requires Pillow (`pip install pillow`). Nothing in the build or the test suite runs this; it is a
by-hand step whose output is committed.
"""

from __future__ import annotations

import argparse
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont

HERE = Path(__file__).resolve().parent
DEFAULT_SRC = Path.home() / "Documents/projects/avatar-refs/v2-bakeoff/chibi"

SHIP_PX = 384
SHIP_QUALITY = 88

# Order and captions mirror `AVATAR_PORTRAIT_KEYS` in ../portraits.ts and `avatarStatusLabel()` in
# ../state.ts. Duplicated rather than parsed: this script is not part of the build, and a sheet
# whose labels have drifted is obvious the moment anyone looks at it.
STATES: list[tuple[str, str]] = [
    ("idle", "Ready"),
    ("listening", "Listening"),
    ("thinking", "Thinking…"),
    ("talking", "Answering…"),
    ("working-read", "Reading…"),
    ("working-write", "Editing files…"),
    ("working-browse", "Browsing…"),
    ("working-execute", "Running code…"),
    ("error", "Something went wrong"),
    ("done", "Done"),
    ("paused", "Reconnecting…"),
]

# `paused` carries a runtime desaturation on top of the baked art -- see AVATAR_PORTRAIT_FILTERS in
# ../portraits.ts. The sheet applies the same thing, so it shows what actually ships.
RUNTIME_DESATURATE = {"paused": (0.70, 0.98)}


def encode(src: Path) -> None:
    total = 0
    for state, _ in STATES:
        master = src / f"{state}.png"
        if not master.exists():
            raise SystemExit(f"missing master: {master}")
        image = Image.open(master).convert("RGB")
        if image.width != image.height:
            raise SystemExit(f"{master.name} is {image.size}, expected a square master")
        out = HERE / f"{state}.webp"
        image.resize((SHIP_PX, SHIP_PX), Image.LANCZOS).save(
            out, "WEBP", quality=SHIP_QUALITY, method=6
        )
        size = out.stat().st_size
        total += size
        print(f"  {state:<16} {size / 1024:6.1f} KB")
    print(f"  {'total':<16} {total / 1024:6.1f} KB")


def apply_runtime_filter(image: Image.Image, state: str) -> Image.Image:
    """Mirror the CSS `filter` the renderer puts on this frame, so the sheet is honest."""
    settings = RUNTIME_DESATURATE.get(state)
    if settings is None:
        return image
    saturate, brightness = settings
    grey = image.convert("L").convert("RGB")
    out = Image.blend(grey, image, saturate)
    return Image.eval(out, lambda v: min(255, round(v * brightness)))


def circle_crop(image: Image.Image, px: int) -> Image.Image:
    """The presence bubble's crop: the frame's inscribed circle, on a transparent square."""
    frame = image.resize((px, px), Image.LANCZOS).convert("RGBA")
    mask = Image.new("L", (px * 4, px * 4), 0)
    ImageDraw.Draw(mask).ellipse((0, 0, px * 4 - 1, px * 4 - 1), fill=255)
    frame.putalpha(mask.resize((px, px), Image.LANCZOS))
    return frame


def font(size: int, bold: bool = False) -> ImageFont.FreeTypeFont:
    names = (
        ["DejaVuSans-Bold.ttf", "LiberationSans-Bold.ttf"]
        if bold
        else ["DejaVuSans.ttf", "LiberationSans-Regular.ttf"]
    )
    for name in names:
        try:
            return ImageFont.truetype(name, size)
        except OSError:
            continue
    return ImageFont.load_default(size)


def build_sheet() -> None:
    """A labelled grid at a readable size, over the 96 px strip that is the real legibility test."""
    cols, cell, pad = 4, 256, 32
    head, caption_h, row_gap = 74, 48, 30
    strip_px, strip_gap, strip_label = 96, 10, 28

    rows = (len(STATES) + cols - 1) // cols
    # The 96 px strip is the widest thing on the sheet and the point of it, so it sets the width
    # and the grid spreads to match rather than the other way round.
    width = pad * 2 + len(STATES) * strip_px + (len(STATES) - 1) * strip_gap
    gap = (width - pad * 2 - cols * cell) // (cols - 1)
    grid_h = rows * (cell + caption_h) + (rows - 1) * row_gap
    strip_h = 30 + strip_px + strip_label
    sheet = Image.new("RGB", (width, head + grid_h + 34 + strip_h + pad), "#faf9fc")
    draw = ImageDraw.Draw(sheet)

    draw.text((pad, 24), "Lena avatar v2 — the eleven states", font=font(19, True), fill="#241f2e")
    draw.text(
        (pad, 50),
        f"chibi track · {SHIP_PX} px WebP q{SHIP_QUALITY} · circular crop, as rendered",
        font=font(12),
        fill="#6d6580",
    )

    frames = {}
    for index, (state, caption) in enumerate(STATES):
        source = apply_runtime_filter(Image.open(HERE / f"{state}.webp").convert("RGB"), state)
        frames[state] = source
        col, row = index % cols, index // cols
        x = pad + col * (cell + gap)
        y = head + row * (cell + caption_h + row_gap)
        sheet.paste(circle_crop(source, cell), (x, y), circle_crop(source, cell))
        draw.text(
            (x + cell // 2, y + cell + 12), state, font=font(13, True), fill="#241f2e", anchor="ma"
        )
        draw.text(
            (x + cell // 2, y + cell + 30), caption, font=font(12), fill="#7a6f92", anchor="ma"
        )

    strip_y = head + grid_h + 34
    draw.text(
        (pad, strip_y),
        f"{strip_px} px — around the size Lena is actually drawn at",
        font=font(12),
        fill="#6d6580",
    )
    strip_y += 26
    for index, (state, _) in enumerate(STATES):
        x = pad + index * (strip_px + strip_gap)
        thumb = circle_crop(frames[state], strip_px)
        sheet.paste(thumb, (x, strip_y), thumb)
        draw.text(
            (x + strip_px // 2, strip_y + strip_px + 8),
            state.replace("working-", "w-"),
            font=font(11),
            fill="#6d6580",
            anchor="ma",
        )

    out = HERE.parent / "states-contact-sheet.png"
    # 256-colour palette: the sheet is a README illustration, not a master, and quantizing it
    # cuts ~1.1 MB of repo weight to ~0.4 MB with no visible change on this palette.
    sheet.quantize(colors=256, method=Image.MEDIANCUT, dither=Image.FLOYDSTEINBERG).save(
        out, "PNG", optimize=True
    )
    print(f"  {out.name:<16} {out.stat().st_size / 1024:6.1f} KB  {sheet.size[0]}x{sheet.size[1]}")


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--src", type=Path, default=DEFAULT_SRC, help="directory of PNG masters")
    parser.add_argument("--sheet-only", action="store_true", help="skip the re-encode")
    args = parser.parse_args()

    if not args.sheet_only:
        print(f"encoding from {args.src}")
        encode(args.src)
    print("contact sheet")
    build_sheet()


if __name__ == "__main__":
    main()
