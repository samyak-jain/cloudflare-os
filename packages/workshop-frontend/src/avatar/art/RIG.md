# Lena — chibi avatar rig

`lena.svg` is a 512×512 bust portrait built for runtime animation. Pure SVG: no
`<image>`, `<script>`, `<text>`, `<style>`, no external references, no filters.
Every id is a hand-authored literal prefixed `lena-`, so ids are stable across
rebuilds and safe to bind to.

Everything animates by setting a `transform` attribute on a named group, or by
toggling `display` on the mouth siblings. Nothing needs CSS, `transform-box`, or
`transform-origin` — every rotation below is written as SVG-1.1
`rotate(angle cx cy)`, which works identically in browsers, librsvg, resvg and
Inkscape.

```
python3 avatar/verify.py            # validate the rig contract
python3 avatar/verify.py --render   # + rasterise all 25 rig states to avatar/.states/
./avatar/shot.sh                    # contact sheet -> avatar/contact-sheet.png
```

---

## 1. Layer tree

Paint order is top-to-bottom. `[clip …]` marks a **static** clip wrapper — clips
always live on an ancestor of the animated group, never on the animated group
itself (see §3).

```
lena-root                       [clip lena-clip-frame]
├─ lena-backdrop                        pale lilac disc + 4 sparkles — delete for transparency
│  └─ lena-backdrop-sparkles
├─ lena-head-back  ◆                    receives the SAME transform as lena-head
│  └─ lena-hair-back
│     ├─ lena-hair-back-mass            the big silver mass, overdrawn past the frame
│     ├─ lena-hair-back-shading         [clip lena-clip-hairback]  locks, flow lines, tips
│     ├─ lena-hair-back-sway-l  ◆
│     └─ lena-hair-back-sway-r  ◆
├─ lena-body
│  ├─ lena-torso                        shoulders + white inner uniform  [clip lena-clip-torso]
│  ├─ lena-cape-l  ◆                    navy coat panel, left
│  │  └─ lena-epaulette-l               shoulder board + 2 gold rank bars
│  ├─ lena-cape-r  ◆
│  │  └─ lena-epaulette-r
│  └─ lena-insignia                     gold aiguillette cords + buttons
│     └─ lena-chest-star  ◆             6-point gold star (inner <g> carries the translate)
├─ lena-neck                            skin column + under-jaw shadow
├─ lena-collar  ◆                       navy stand collar, gold trim
│  └─ lena-collar-clasp  ◆              throat clasp
└─ lena-head  ◆                         HEAD BONE — tilt / nod / lean all go here
   ├─ lena-head-shape
   │  └─ lena-face                      the skin silhouette
   ├─ lena-face-features        [clip lena-clip-face]   ← "face clipped"
   │  ├─ lena-face-shading              fringe cast shadow, cheek + chin shading
   │  ├─ lena-blush  ◆
   │  ├─ lena-nose
   │  └─ lena-mouths
   │     ├─ lena-mouth-closed   ◆ visible by default
   │     ├─ lena-mouth-half     ◆ display="none"
   │     ├─ lena-mouth-open     ◆ display="none"
   │     ├─ lena-mouth-smile    ◆ display="none"
   │     └─ lena-mouth-frown    ◆ display="none"
   ├─ lena-eyes
   │  ├─ lena-eye-l
   │  │  ├─ lena-eye-l-white            sclera, fills the aperture
   │  │  ├─ (g)                 [clip lena-clip-socket-l]   ← SOCKET CLIP
   │  │  │  ├─ lena-eye-l-globe   ◆     iris gradient, striations, pupil, 3 highlights
   │  │  │  │  └─ lena-eye-l-pupil  ◆
   │  │  │  ├─ lena-eye-l-lid-lower ◆
   │  │  │  └─ lena-eye-l-lid-upper ◆   skin + fold shading + lash + crease
   │  │  └─ lena-eye-l-lashtip  ◆       outer flick, lives outside the socket clip
   │  └─ lena-eye-r … (mirror)
   ├─ lena-hair-front
   │  ├─ lena-hair-lock-l  ◆            long face-framing lock, falls over the shoulder
   │  ├─ lena-hair-lock-r  ◆
   │  ├─ lena-hair-wisps                two loose strands down the cheeks
   │  ├─ lena-hair-fringe               static fringe base
   │  │  ├─ lena-hair-fringe-base
   │  │  └─ lena-hair-fringe-shade  [clip lena-clip-fringe]  tone + strand lines
   │  ├─ lena-hair-bang-l  ◆            2 accent strands lying on the fringe, left
   │  ├─ lena-hair-bang-r  ◆
   │  └─ lena-hair-gloss           [clip lena-clip-fringe]  the shine band
   ├─ lena-brows
   │  ├─ lena-brow-l  ◆                 drawn over the fringe (anime convention)
   │  └─ lena-brow-r  ◆
   └─ lena-ahoge  ◆                     the signature loop — top layer, nothing occludes it
      └─ lena-ahoge-strand
```

`◆` = animatable. **`lena-head-back` must receive the same transform as
`lena-head`.** They are one bone split in two so the back hair can sit behind the
body while the face sits in front of it; drive both from the same value.

---

## 2. Animatable groups

Angles are degrees, translations are viewBox units (1 unit = 1 px at 512).
"Safe range" is the range verified not to clip, spill, or tear.

### Head

| id | transform | origin | safe range | notes |
|---|---|---|---|---|
| `lena-head` | `rotate(a cx cy)` | **256 380** | a ∈ [−12, 12] | neck pivot; beyond ±12 the jaw slides off the collar |
| `lena-head-back` | same as above | **256 380** | same | mirror `lena-head` exactly, every frame |
| `lena-head` | `translate(0 dy)` | — | dy ∈ [−6, 10] | nod; compose as `translate(0 dy) rotate(a 256 380)` |
| `lena-head` | `translate(dx 0)` | — | dx ∈ [−8, 8] | lean; the hair is overdrawn past the frame so no gap appears |

### Eyes (both sides identical; `l` / `r`)

| id | transform | origin | safe range | notes |
|---|---|---|---|---|
| `lena-eye-{s}-lid-upper` | `translate(0 dy)` | — | dy ∈ [0, **56**] | 0 = open, 56 = **fully closed**. 18–24 reads as half-lid, 10 as a soft "sleepy" |
| `lena-eye-{s}-lid-lower` | `translate(0 dy)` | — | dy ∈ [−18, 4] | negative = squint / smile-eyes |
| `lena-eye-{s}-globe` | `translate(dx dy)` | — | dx ∈ [−8, 8], dy ∈ [−6, 6] | look-at; the iris stays inside the socket |
| `lena-eye-{s}-pupil` | `scale` about the pupil centre | 196 250 / 316 250 | 0.8 – 1.35 | dilate for surprise / "done"; compose `translate(cx cy) scale(k) translate(-cx -cy)` |
| `lena-eye-{s}-lashtip` | `rotate(a …)` | 166 246 / 346 246 | a ∈ [−8, 8] | optional; the flick is deliberately outside the socket clip, so leave it near neutral during a blink |

**How the blink is contained.** The eye opening is a single path used twice:
once as the visible sclera (`lena-eye-{s}-white`) and once as the clip
`lena-clip-socket-{s}`. Inside that clip sit the globe and both lids. The upper
lid is a big skin-coloured rect whose bottom edge sits exactly at the aperture's
top-most point (y = 222), with the lash wedge drawn along the aperture's top
edge and a soft eyelid fold above it. At rest the rect is entirely above the
aperture and contributes nothing; translating it down carries the lash across
the opening and the skin behind it, and at dy = 56 the lash's lower edge passes
below the aperture floor everywhere, so the eye is fully shut. Because the clip
is on the *static wrapper* rather than on the lid, the clip does not travel with
the lid, and no part of the lid can ever paint on the cheek or brow.

> The clip must stay on an ancestor. A `clip-path` set on the animated element
> itself is resolved in that element's own (transformed) user space and moves
> with it — `verify.py` fails the build if that regresses.

### Brows

| id | transform | origin | safe range | notes |
|---|---|---|---|---|
| `lena-brow-l` | `rotate(a 150 197)` | outer tip | a ∈ [−14, 14] | **+** drops the inner end → angry / focused; **−** lifts it → worried |
| `lena-brow-r` | `rotate(a 362 197)` | outer tip | a ∈ [−14, 14] | mirror the sign of the left brow |
| `lena-brow-{s}` | `translate(0 dy)` | — | dy ∈ [−9, 5] | raise for surprise, lower for a scowl |

### Mouth — five siblings, exactly one visible

`lena-mouth-closed` (default) · `lena-mouth-half` · `lena-mouth-open` ·
`lena-mouth-smile` · `lena-mouth-frown`.

Set `display="none"` on four and `display="inline"` (or remove the attribute) on
one. They share a centre at ≈ (256, 316) so cross-fading or hard-cutting between
them never shifts the mouth. All five live inside `lena-face-features`, which is
clipped to the face, so an oversized `open` can never leak past the chin.

Lip-sync mapping: silence → `closed`; `m`/`b`/`p` → `closed`; `e`/`i` → `half`;
`a`/`o` → `open`; and use `smile`/`frown` as emotional holds rather than visemes.

### Hair — 4 front sway groups + 2 back

| id | transform | origin | safe range | notes |
|---|---|---|---|---|
| `lena-hair-lock-l` | `rotate(a 152 114)` | temple | a ∈ [−3.5, 3.5] | the long face-framing lock; slowest, largest mass |
| `lena-hair-lock-r` | `rotate(a 360 114)` | temple | a ∈ [−3.5, 3.5] | |
| `lena-hair-bang-l` | `rotate(a 250 58)` | crown | a ∈ [−3, 3] | fringe accent strands; lead the locks by ~80 ms |
| `lena-hair-bang-r` | `rotate(a 262 58)` | crown | a ∈ [−3, 3] | |
| `lena-hair-back-sway-l` | `rotate(a 102 176)` | crown-left | a ∈ [−3, 3] | outer back locks; lag the front by ~140 ms |
| `lena-hair-back-sway-r` | `rotate(a 410 176)` | crown-right | a ∈ [−3, 3] | |

Drive all six from one phase with staggered delays and slightly different
amplitudes; that reads as hair rather than as a rotating sprite. Beyond ±4° the
fringe base starts to show a seam.

### Ahoge — the emotional antenna

| id | transform | origin | safe range |
|---|---|---|---|
| `lena-ahoge` | `rotate(a 258 72)` | strand root | a ∈ [−22, 22] |
| `lena-ahoge` | `translate(258 72) scale(k) translate(-258 -72)` | strand root | k ∈ [0.88, 1.12] |

Compose scale first, rotate second:
`translate(258 72) scale(k) translate(-258 -72) rotate(a 258 72)`.
Never write a bare `scale(k)` — that scales about the viewBox origin and flings
the loop off the head.

### Wardrobe

| id | transform | origin | safe range | notes |
|---|---|---|---|---|
| `lena-collar` | `translate(0 dy)` | — | dy ∈ [−5, 3] | a 1–2 px lift on a breath reads as the coat settling |
| `lena-cape-l` | `rotate(a 258 390)` | shoulder | a ∈ [−2.5, 2.5] | |
| `lena-cape-r` | `rotate(a 254 390)` | shoulder | a ∈ [−2.5, 2.5] | |
| `lena-chest-star` | `rotate(a 256 470)` / scale about (256, 470) | pin | a any, k ∈ [0.9, 1.25] | the inner `<g>` holds the translate, so the id group is transform-free |
| `lena-collar-clasp` | scale about (256, 386) | clasp | k ∈ [0.9, 1.3] | a gold glint for `done` |
| `lena-blush` | `opacity` | — | 0 – 1 | base opacity is baked into the gradient; multiply the group |

---

## 3. Per-state motion notes

Loop lengths assume 60 fps. The ahoge is the emotional read at every size — when
the face is 12 px wide the loop is still legible against the background, so it
carries most of the state signal in a small avatar.

### idle
Head `rotate` ±1.5° over 5.5 s, plus `translate(0 …)` ±2 px on a 3.7 s breath
(deliberately coprime, so the loop never visibly repeats). Hair sway ±1.2° at the
same period, front leading back. **Ahoge:** a slow ±5° drift, one lazy period per
6 s, phase-offset from the head so it trails rather than tracks. Blink every
4–7 s (see below).

### blink
`lid-upper` 0 → 56 → 0. Close in 70 ms with ease-in, hold 40 ms, open in 110 ms
with ease-out — asymmetric, or it looks mechanical. Every 5th blink or so, double
it (close/open/close/open) with a 120 ms gap. Drop the brows 1–2 px during the
close and let them recover a frame late. **Ahoge:** a 3° flick on the open.

### talk
Cut between `closed` / `half` / `open` on viseme boundaries; never tween the
shapes, cut them — 8–12 changes per second reads best. Head `rotate` ±3° with a
small `translate(0 …)` on stressed syllables. Brows +3 px on emphasis. **Ahoge:**
bounce ±8° in sympathy with head accents, damped, ~2 Hz.

### thinking
Head `rotate` −6° and hold, `translate(0 3)` (looking slightly down-left). Eyes
`globe translate(-6 -3)`; `lid-upper` at 14 (a slight narrowing). Brows: inner
ends lifted, `rotate(-6)` left / `rotate(6)` right. Mouth `closed`. **Ahoge:**
a slow question-mark curl — `rotate` drifting from +4° to +14° and back over
2.5 s with `scale` 0.96 → 1.0. It should look like it's *pondering*.

### working
Head near neutral, `rotate` ±1° at 1.6 s (a faster, tighter idle). `lid-upper`
at 10 and `lid-lower` at −8 — a focused squint. Brows down 4 px and inner ends
dropped 6°. Mouth `closed`. **Ahoge:** a small, brisk metronome — ±6° at ~0.9 Hz,
constant amplitude. Reads as busy rather than agitated.

### error
A single sharp head `rotate` −7° → +5° → 0 over 260 ms, then hold at −2°. Brows
angry (left +12°, right −12°) and down 5 px. `lid-upper` at 8, pupils
`scale(0.85)` — a hard, narrow stare. Mouth `frown`. Blush `opacity` up to 1.15×
for 400 ms. **Ahoge:** a violent zig — `rotate` −20° → +18° → −6° in 180 ms, then
settle to a droop at +10° with `scale(0.93)`. The droop is what sells it.

### done
Head `translate(0 -3)` with `rotate` +4°, settling over 300 ms. Mouth `smile`,
`lid-lower` at −11 for smile-eyes, brows up 4 px. `chest-star` scale 1.0 → 1.22 →
1.0 over 400 ms and `collar-clasp` glint on the same beat. **Ahoge:** perk —
`scale` 1.0 → 1.10 with `rotate` 0 → −15° in 200 ms, then a settling wobble of
two decaying oscillations. Follow with one contented blink.

### wink / acknowledge
`lena-eye-l-lid-upper` to 56, hold 130 ms, release; `mouth-smile`; head
`rotate` +5°; ahoge `rotate` −10°. Useful as a lightweight "got it".

---

## 4. Palette tokens

Sampled from `lena-chibi-ref.png` and then flattened into a working ramp. All
values are literal in the SVG (no CSS variables), so a retint is a
find-and-replace or a `<feColorMatrix>` at the host level.

**Hair** — the reference's silver reads *cool lilac*, never blue and never warm
grey. Keep the value range narrow; the mass should stay near-white and let the
lineart carry the form.

| token | hex | use |
|---|---|---|
| `hair-lit` | `#fdfbfe` | gloss core, top of the fringe gradient |
| `hair-base` | `#ede8f5` | main fringe / lock body |
| `hair-mid` | `#d8d0e7` | lower back-hair mass |
| `hair-deep` | `#b6abcb` | deepest shadow, bottom of the frame |
| `hair-line` | `#9a90b4` | silhouette stroke — lilac-grey, **never black** |
| `hair-strand` | `#b2a6c9` | internal strand separations |

**Skin** — warm ivory over a cool hair mass is what makes the face pop.

| token | hex | use |
|---|---|---|
| `skin-lit` | `#fff5ef` | forehead |
| `skin` | `#feeade` | mid face |
| `lid` | `#fde7da` | closed-eyelid fill (matched to the shaded face band) |
| `skin-shade` | `#f7d6c9` | jaw, neck |
| `skin-deep` | `#eabfb4` | fringe cast shadow |
| `blush` | `#f78289` | cheek gradient core (drawn at ≤ 0.42 α) |

**Eyes** — the crimson ramp is the whole character. Dark plum at the top under
the lash, saturated crimson in the middle, hot pink-red catching light at the
bottom rim.

| token | hex | use |
|---|---|---|
| `lash` | `#2b1a26` | upper lash + flick (dark plum, not black) |
| `iris-top` | `#2a0d18` | iris crown |
| `iris-mid` | `#96253c` | iris body |
| `iris-lit` | `#ee6c80` | lower iris |
| `iris-rim` | `#ffa8b4` | bottom rim glow |
| `pupil` | `#1c060c` | |
| `sclera` | `#f8ece9` | warm, never pure white |
| `lower-lash` | `#a4676f` | lower lid line |
| `brow` | `#a89ab2` | drawn at 0.72 α so the fringe reads through |

**Mouth** — `#8a4050` line, `#5a1f2e` interior, `#d2596a` tongue.

**Uniform**

| token | hex | use |
|---|---|---|
| `navy-lit` | `#454c7e` | top-facing cape |
| `navy` | `#2e3260` | body |
| `navy-deep` | `#1b1d40` | shadow |
| `navy-line` | `#171935` | stroke |
| `cape-rim` | `#5d6bb2` | rim light on the shoulder edge |
| `gold-lit` | `#f8e6b6` | highlight |
| `gold` | `#dcb268` | rank bars, star, buttons |
| `gold-trim` | `#cfa459` | collar edge, aiguillette |
| `gold-deep` | `#9a6b28` | gold shadow + stroke |
| `uniform-white` | `#fbf8fd` | inner jacket |
| `uniform-shade` | `#d2c9e2` | its shadow |

**Backdrop** — radial `#fcfbff` → `#d5cceb`. It exists purely to give the
near-white hair an edge at small sizes. Delete `lena-backdrop` for a transparent
avatar; if you do, put the avatar on something ≥ 8 % darker than `#ffffff` or the
hair silhouette dissolves.

---

## 5. Small-size guidance

Verified at 320 / 160 / 120 / 96 / 64 px, square and circle-cropped, on both
light and dark. The design is tuned so nothing needs to be swapped out — the same
file is correct at every size.

**What carries the read as it shrinks.** In order: (1) the pale hair silhouette
with the ahoge loop above it, (2) the two crimson eyes, (3) the navy collar band,
(4) the gold star. Everything else is texture. That ordering is why the collar is
a solid unbroken navy mass and the star is oversized relative to real insignia —
at 64 px they are single blobs of colour and they have to survive as blobs.

| size | what to expect |
|---|---|
| **320** | everything is legible, including the strand lines and the aiguillette |
| **160** | fringe strand separations start merging; the face reads fully |
| **120** | strand lines gone; eyes, brows, mouth and collar all still distinct |
| **96** | the mouth is ~4 px and reads as a mark, not a shape — expression now comes from the eyes and brows. Still comfortable. |
| **64** | eyes and hair silhouette read clearly; the ahoge is a thin halo (present but faint); the mouth is a dot; the gold star is a single warm pixel cluster. This is the floor. |

Notes:

- **Circle crop** loses the outer hair at ~15 % of the width on each side. The
  composition is centred with that in mind — nothing load-bearing lives outside
  a centred circle of r = 256.
- **Below 64 px**, hide `lena-backdrop-sparkles` and `lena-insignia`; they turn
  into noise. The rest still reads.
- **On dark backgrounds** the silver hair gains contrast and the design gets
  *stronger*, not weaker. The one casualty is the ahoge outline stroke
  (`hair-line` at 1.7 px), which starts to disappear under ~96 px; bump
  `lena-ahoge-strand`'s `stroke-width` to 2.6 if you ship a dark-only variant.
- **Animation amplitude should not scale with the render size.** The ranges above
  are in viewBox units and are already conservative; at 64 px a ±8° head tilt
  is a 2 px move and reads fine.
- The SVG is ~32 KB uncompressed, ~8 KB gzipped, and has no filters or masks —
  it composites cheaply enough to animate at 60 fps in a DOM node.

---

## 6. Deviations from the reference

Deliberate, and listed so they read as choices rather than misses:

- **Eyes are ~22 % larger** relative to face width than the reference, while
  keeping the reference's inter-eye spacing and outer margins. Below 96 px the
  reference's proportions lose the iris.
- **The mouth is ~2.5× the reference's** (which is about 7 px on a 179 px face).
  At the reference ratio the mouth would be 1 px at 64 px and the five mouth
  shapes would be indistinguishable.
- **Front-facing and symmetric.** The reference has a slight three-quarter turn;
  symmetry makes tilt and look-at behave predictably in both directions.
- **The collar is a military stand collar** rather than the reference's full
  coat-over-shoulders drape — the bust crop cuts above the point where the drape
  becomes readable.
