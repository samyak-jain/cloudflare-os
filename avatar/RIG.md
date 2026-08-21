# Lena — avatar rig sheet

`lena.svg` — original character design, heavily inspired by Vladilena Milizé
(*86: Eighty-Six*). Personal-use avatar for the agent **Lena**. Not a trace or
copy of official art: all geometry is hand-authored path data.

- **Canvas:** `viewBox="0 0 512 512"`, square, safe at **120–320 px**.
- **Pure SVG:** no `<script>`, no `<image>`, no `<text>`, no font references,
  no external resources. Every id is stable and hand-written (no generated
  suffixes), so a rig or state machine can bind to them by name.
- **Preview harness:** `preview.html` (open over HTTP — it `fetch`es the SVG).
  `./shot.sh out.png` serves the directory and screenshots it headlessly.

---

## 1. Layer tree

Draw order is top-to-bottom (later = in front).

```
#backdrop                       circular vignette — hide for transparent avatars
#avatar-root
├─ #hair-back                   hair mass behind everything
├─ #body                        jacket, shirt, lapels, braid, epaulettes
├─ #hair-drape                  hair falling in front of the shoulders
├─ #neck                        neck, cast shadow, stand collar, clasp
└─ #head                        ← HEAD TILT GROUP
   ├─ #face          clip-path: #clip-face
   │  ├─ #face-base             face shape + shading + blush + nose
   │  ├─ #eyes
   │  │  ├─ #eye-l   clip-path: #clip-socket-l
   │  │  │  ├─ #eye-l-globe   clip-path: #clip-aperture-l
   │  │  │  │  ├─ #eye-l-sclera  #eye-l-socket-shade
   │  │  │  │  ├─ #eye-l-iris  #eye-l-iris-glow  #eye-l-pupil  #eye-l-iris-rim
   │  │  │  │  └─ #eye-l-spec  #eye-l-spec2
   │  │  │  ├─ #eye-l-lid-lower  (fill + lash-line)
   │  │  │  └─ #eye-l-lid-upper  (skin fill + #eye-l-lash + #eye-l-lash-tip)
   │  │  └─ #eye-r   … mirrored, same substructure
   │  └─ #mouth
   │     ├─ #mouth-closed        visible by default
   │     ├─ #mouth-half-open     display="none"
   │     ├─ #mouth-open          display="none"
   │     ├─ #mouth-smile         display="none"
   │     └─ #mouth-frown         display="none"
   ├─ #hair-front
   │  ├─ #hair-strand-l          DOMINANT side — container for 3 ribbon planes
   │  │  ├─ #hair-strand-l-a     outermost / longest, crosses onto the chest
   │  │  ├─ #hair-strand-l-b     middle plane
   │  │  └─ #hair-strand-l-c     innermost / shortest, frames the cheek
   │  ├─ #hair-strand-r          subordinate side — single narrower lock
   │  └─ #hair-bangs             fringe band under the visor (+ #hair-bangs-part)
   ├─ #brows                     clip-path: #clip-face
   │  ├─ #brow-l   └─ #brow-r
   └─ #cap
      ├─ #cap-crown  #cap-crown-hi  #cap-crown-shade  #cap-seam
      ├─ #cap-insignia-ring  #cap-insignia
      ├─ #cap-band
      ├─ #ribbon                 ← INDEPENDENT RIBBON GROUP
      │  ├─ #ribbon-tail-l  #ribbon-tail-r
      │  ├─ #ribbon-band  #ribbon-band-shade
      │  └─ #ribbon-bow-l  #ribbon-bow-r  #ribbon-knot
      └─ #cap-visor  #cap-visor-hi
```

### Structural notes

- **`#brows` is drawn *over* `#hair-front`.** With a peaked cap the forehead is
  only ~40 px tall, so brows under the fringe would be invisible. Drawing them
  on top is the standard anime convention and keeps them fully expressive at
  every pose. They are clipped to `#clip-face` so they can never spill past the
  head outline.
- **`#hair-drape` sits outside `#head`** on purpose: hair resting on the
  shoulders should not swing with a head tilt.
- **`#ribbon` lives inside `#cap`** so it rides along with head tilt, but it is
  its own group with its own free transform slot for flutter.
- **The design is deliberately asymmetric.** The fringe parts off-centre at
  **x ≈ 292** (`#hair-bangs-part` marks the seam), sweeping long to the viewer's
  left and short to the right. `#hair-strand-l` is three overlapping
  ribbon planes with staggered tips (y ≈ 506 / 476 / 424) whose combined mass
  sweeps inward across the chest; `#hair-strand-r` is one narrower lock ending
  at y ≈ 450. `#hair-drape-l` is pushed further outboard than `#hair-drape-r` so
  plane A layers *over* it rather than fighting it. Do not "fix" this into
  symmetry — the imbalance is what stops the hair reading as curtains.
- **Two clips per eye.** `#clip-socket-*` is the socket the lid slides inside
  (invisible edges — it only ever cuts skin-coloured pixels). `#clip-aperture-*`
  is the actual eye opening and clips only the globe. This is what lets the
  upper lid translate down over the eye without spilling onto the cheek.

---

## 2. Animatable groups and transform origins

All rotations are given as SVG `rotate(deg cx cy)`. If you drive these from CSS
instead, set `transform-box: view-box; transform-origin: <cx>px <cy>px`.

| Group | Motion | Transform | Origin (cx, cy) | Range |
|---|---|---|---|---|
| `#head` | head tilt / nod | `rotate` | **256, 420** (neck base) | ±8° tilt |
| `#head` | head bob | `translate` | — | ±3 px Y |
| `#eye-l-lid-upper` | blink | `translate(0, dy)` | — | **0 → 34** (34 = fully closed) |
| `#eye-r-lid-upper` | blink | `translate(0, dy)` | — | **0 → 34** |
| `#eye-l-lid-lower` | squint | `translate(0, dy)` | — | 0 → −8 |
| `#eye-r-lid-lower` | squint | `translate(0, dy)` | — | 0 → −8 |
| `#eye-l-globe` | look around | `translate(dx, dy)` | — | ±7 X, ±5 Y |
| `#eye-r-globe` | look around | `translate(dx, dy)` | — | ±7 X, ±5 Y |
| `#eye-l-pupil` | dilate | `scale` about (210, 273) | 210, 273 | 0.8 – 1.25 |
| `#eye-r-pupil` | dilate | `scale` about (302, 273) | 302, 273 | 0.8 – 1.25 |
| `#brow-l` | raise / anger | `translate` + `rotate` | **240, 236** (inner end) | ±8 px Y, ±10° |
| `#brow-r` | raise / anger | `translate` + `rotate` | **272, 236** (inner end) | ±8 px Y, ∓10° |
| `#mouth-*` | viseme swap | `display` | — | exactly one visible |
| `#mouth` | jaw drop | `scale(1, sy)` about (256, 330) | 256, 330 | 0.85 – 1.15 |
| `#hair-strand-l` | gross sway (all 3 planes) | `rotate` | **196, 208** (root under visor) | ±5° |
| `#hair-strand-l-a` | plane lag | `rotate` | **178, 210** | ±4° (on top of parent) |
| `#hair-strand-l-b` | plane lag | `rotate` | **190, 208** | ±4° (on top of parent) |
| `#hair-strand-l-c` | plane lag | `rotate` | **198, 206** | ±4° (on top of parent) |
| `#hair-strand-r` | sway | `rotate` | **314, 206** (root under visor) | ±6° |
| `#hair-bangs` | sway | `rotate` | **292, 208** (the part) | ±3° |
| `#hair-drape-l` | sway | `rotate` | **180, 328** (shoulder root) | ±4° |
| `#hair-drape-r` | sway | `rotate` | **318, 326** (shoulder root) | ±4° |
| `#hair-back` | body sway | `rotate` | **256, 120** (crown) | ±2° |
| `#ribbon` | flutter | `rotate` | **332, 183** (knot) | −10° … +6° |
| `#backdrop` | — | `display` | — | hide for transparent output |

### Blink geometry

`#eye-l-lid-upper` contains a skin-coloured fill whose lower boundary *is* the
lash curve. Translating it down sweeps that boundary across the aperture:

- `translate(0, 0)` — open; the lash sits on the upper aperture rim.
- `translate(0, 15)` — half-lidded / sleepy.
- `translate(0, 34)` — closed; the lash lands on the lower rim.

`#eye-*-lid-lower` sits 4 units higher than a fully-open eye would need. That
deliberate crowding of the aperture is what gives the slightly lidded, adult
read; `translate(0, -8)` on top of it produces the squint.

The fill extends up to `y = 152`, well above `#clip-socket-*`'s top edge, so at
maximum travel the top of the socket is still covered — no sclera peeks out.

---

## 3. Intended motion

**Idle.** `#head` rotate ±2° over ~6 s, out of phase with a ±2 px Y bob. Hair
strand groups follow the head with a 120–180 ms lag and ~1.4× amplitude, and
`#ribbon` lags the head by ~200 ms — the offsets are what sell it as hair and
fabric rather than a rigid decal.

**Hair planes.** Drive `#hair-strand-l` for the gross motion, then give
`-a` / `-b` / `-c` a small extra rotation each with ~60 ms of stagger between
them (outermost leads, innermost trails). That per-plane phase offset is the
whole point of splitting the lock — running the three in lockstep looks
identical to the old single shape. Keep parent + child combined under about
**8°**; past that the plane roots start to emerge from under `#cap-visor`.

**Blink.** Close over ~70 ms, hold 40 ms, open over ~110 ms (opening is slower
than closing). Both lids always fire together. Random interval 3–7 s; add a
double-blink about 1 in 6.

**Talk cycle.** Cross-fade `#mouth-*` by `display` on a 90–130 ms beat:
`closed → half-open → open → half-open → closed`, weighted toward `half-open`.
Drive it from streamed-token cadence, not audio. `#mouth-smile` and
`#mouth-frown` are held expressions, not part of the cycle. Pair talking with a
small `#head` nod (±3°) every few beats.

**Thinking.** `#head` rotate −6°, `#eye-*-globe` translate (−5, −4) (looking
up-left), brows raised 4 px, `#mouth-closed`. Slower blink rate.

**Working / tool call.** Half-lid at `translate(0, 12)`, brows angled inward
(`#brow-l` +8°, `#brow-r` −8°), mouth closed. Reads as focused concentration.

**Error.** `#mouth-frown`, brows angled, one sharp `#head` tilt to +6° that
settles back.

**Done / success.** `#mouth-smile`, a squint (`lid-lower` −6, `lid-upper` +8),
brows raised, hair strands overshoot then settle.

**Reduced motion.** With `prefers-reduced-motion`, keep only the blink and drop
every rotation.

---

## 4. Palette tokens

Hex values as authored. Gradient ids in parentheses.

| Token | Value | Used by |
|---|---|---|
| `hair/light` | `#F6F7FD` | `g-hair-front` stop 0 |
| `hair/mid` | `#D8DBF0` | `g-hair-front` stop .5 |
| `hair/shadow` | `#A8ACD5` | `g-hair-front` stop 1 |
| `hair/back-light` | `#C6C9E6` | `g-hair-back` stop 0 |
| `hair/back-mid` | `#9EA1CE` | `g-hair-back` stop .5 |
| `hair/back-deep` | `#6E6FA8` | `g-hair-back` stop 1 |
| `hair/plane-shadow` | `#8A8EC4` | strand shade planes |
| `hair/seam` | `#9FA4CE` / `#7B7CB8` | strand separation strokes |
| `line/ink` | `#272449` | hair + silhouette outlines |
| `line/ink-deep` | `#151230` | uniform outlines |
| `skin/light` | `#FFF4EE` | `g-skin` stop 0 |
| `skin/mid` | `#FBE2D5` | `g-skin` stop .55 |
| `skin/shadow` | `#EFC7B2` | `g-skin` stop 1 |
| `skin/cast` | `#D9A088` | visor + jaw shadows |
| `skin/blush` | `#EE8A80` | `g-blush` |
| `eye/iris-deep` | `#4E5A85` | `g-iris` stop 0 |
| `eye/iris-mid` | `#8695BE` | `g-iris` stop .35 |
| `eye/iris-light` | `#C6D3EA` | `g-iris` stop .78 |
| `eye/iris-pale` | `#EEF3FC` | `g-iris` stop 1 |
| `eye/rim` | `#414C71` | iris rim stroke |
| `eye/pupil` | `#242A45` | pupil |
| `eye/lash` | `#282444` | lash + lash tip |
| `eye/sclera` | `#FBFBFF` | sclera |
| `brow` | `#7E7C9E` | `#brow-l` `#brow-r` |
| `uniform/violet-light` | `#4A4480` | `g-jacket` stop 0 |
| `uniform/violet` | `#312C5C` | `g-jacket` stop .6 |
| `uniform/violet-deep` | `#1C1938` | `g-jacket` stop 1 |
| `uniform/collar` | `#3A3468` | stand collar |
| `uniform/shirt` | `#EFEFF7` | shirt + collar trim |
| `cap/crown-light` | `#565194` | `g-cap` stop 0 |
| `cap/crown` | `#3C376E` | `g-cap` stop .55 |
| `cap/crown-deep` | `#282450` | `g-cap` stop 1, `#cap-band` |
| `cap/visor` | `#1B1936` → `#100F22` | `g-visor` |
| `gold/light` | `#F7DF9E` | `g-gold` stop 0 |
| `gold/mid` | `#DCB65C` | `g-gold` stop .5 |
| `gold/deep` | `#B0842C` | `g-gold` stop 1 |
| `ribbon/light` | `#DC4257` | `g-ribbon` stop 0 |
| `ribbon/deep` | `#8E1730` | `g-ribbon` stop 1, tails |
| `ribbon/line` | `#69101F` | ribbon outlines |
| `backdrop/core` | `#5C6BA8` | `g-backdrop` stop 0 |
| `backdrop/edge` | `#14172C` | `g-backdrop` stop 1 |

**Mood tinting.** For per-tool colour states, animate `#backdrop`'s inner stop
only. The character's own palette should stay fixed so identity reads
consistently.

---

## 5. Small-size behaviour

Checked at 320 / 160 / 120 / 96 / 64 px on light, mid and dark backgrounds
(see the `preview.html` cards).

- The strongest read at 120 px is the **silhouette trio**: dark cap, crimson
  band, pale hair column. Those are the three shapes to protect in any edit.
- Outline weights are 3–4 units at 512, i.e. ~0.9 px at 120 px. Going thinner
  makes the character dissolve on light backgrounds; going thicker muddies the
  face.
- Below ~96 px the mouth shapes stop differentiating. Drive mood by brow and
  lid position at those sizes, not by viseme.
- `#backdrop` is what keeps pale hair legible on a light page. If you need a
  transparent avatar, hide it and add an outer ring in the host UI instead.
