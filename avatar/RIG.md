# Lena — avatar rig sheet (v3)

`lena.svg` — original character design for the animated agent avatar in
`docs/cloudflare-os-integration.md` → *Animated avatar*. Personal-use avatar for
the agent **Lena**, styled against an operator-supplied reference
(`reference-bust.png`, a bust crop of a flat vector trace of a Vladilena Milizé
illustration). All geometry here is hand-authored path data — the reference was
sampled for palette and studied for proportion, never traced.

- **Canvas:** `viewBox="0 0 512 512"`, square, safe at **120–320 px**.
- **Pure SVG:** no `<script>`, `<image>`, `<text>`, or font references. 155
  unique hand-written ids; a state machine binds by name.
- **Preview:** `preview.html` (serve over HTTP — it `fetch`es the SVG).
  `./shot.sh out.png` renders the full contact sheet headlessly.
  `./compare.sh out.png` renders the avatar at 512 beside `reference-bust.png`
  for art-direction work.

## v3 restyle summary

Same rig, new skin. Nothing structural moved except `#ribbon` (see §5).

- **Flat cel planes replaced gradients** everywhere except the cap, gold,
  backdrop and blush. The reference is a hard-edged cel trace; soft gradients
  were what made v2 read as grey mush.
- **Palette resampled** from the reference (§6). The hair shadows went distinctly
  blue-violet, the uniform went indigo, and the skin shadow went dusty rose
  rather than tan.
- **Face:** longer, harder taper to a pointed chin (393), narrow lidded eyes with
  a full dark rim, thin angled brows, small low mouth, near-zero blush.
- **Cap:** soft flared crown + wide near-black visor, replacing the trapezoid.
- **Hair:** three-tone ribbon planes (base / shadow plane / bright sliver) on
  every lock, keeping the v2 asymmetry.

---

## 1. Layer tree

Draw order is top-to-bottom (later = in front).

```
#backdrop                       circular vignette — hide for transparent avatars
#avatar-root
├─ #hair-back                   mass + 2 shadow planes + 2 mid bands + 2 slivers
├─ #body                        jacket, yokes, shirt + folds, lapels, gold
│                               boards, aiguillette, buttons
├─ #hair-drape                  shoulder hair, L/R each: base + plane + sliver
├─ #neck                        neck, cast shadow, stand collar, white trim
│  └─ #ribbon                   ← RED ACCENT, independent group (see §5)
└─ #head                        ← HEAD TILT GROUP
   ├─ #face          clip-path: #clip-face
   │  ├─ #face-base             shape, visor shadow, side/chin planes, blush, nose
   │  ├─ #eyes
   │  │  ├─ #eye-l   clip-path: #clip-socket-l
   │  │  │  ├─ #eye-l-globe   clip-path: #clip-aperture-l
   │  │  │  │  ├─ #eye-l-sclera  #eye-l-socket-shade
   │  │  │  │  ├─ #eye-l-iris  #eye-l-iris-plane  #eye-l-iris-glow
   │  │  │  │  ├─ #eye-l-pupil  #eye-l-iris-rim
   │  │  │  │  └─ #eye-l-spec  #eye-l-spec2
   │  │  │  ├─ #eye-l-lid-lower  (fill + #eye-l-lid-lower-line = lower eye rim)
   │  │  │  └─ #eye-l-lid-upper  (fill + #eye-l-lash + lash-tip + crease)
   │  │  └─ #eye-r   … mirrored, same substructure
   │  └─ #mouth
   │     ├─ #mouth-closed        visible by default
   │     └─ #mouth-half-open / #mouth-open / #mouth-smile / #mouth-frown
   │                             display="none"
   ├─ #hair-front
   │  ├─ #hair-strand-l          DOMINANT side — container for 3 ribbon planes
   │  │  ├─ #hair-strand-l-a     outermost / longest, crosses onto the chest
   │  │  ├─ #hair-strand-l-b     middle plane
   │  │  └─ #hair-strand-l-c     innermost / shortest, frames the cheek
   │  ├─ #hair-strand-r          subordinate side — single narrower lock
   │  └─ #hair-bangs             fringe under the visor (+ #hair-bangs-part)
   ├─ #brows                     clip-path: #clip-face
   └─ #cap                       crown + planes + insignia + band + visor
```

### Structural notes

- **`#brows` draws over `#hair-front`.** Under a peaked cap the visible forehead
  is ~30 px tall, so brows below the fringe would be invisible. Drawing them on
  top is the standard anime convention; they are clipped to `#clip-face` so they
  can never spill past the head outline. Unchanged from v2.
- **`#hair-drape` sits outside `#head`** — shoulder hair should not swing with a
  head tilt.
- **The hair is deliberately asymmetric.** The fringe parts off-centre at
  **x ≈ 296** (`#hair-bangs-part` marks the seam). `#hair-strand-l` is three
  overlapping planes with staggered tips (y ≈ 512 / 486 / 426) sweeping inward
  across the chest; `#hair-strand-r` is one narrower lock ending at y ≈ 462.
  Do not symmetrise this — the imbalance is what stops the hair reading as
  curtains.
- **Every lock is three tones**: `-1` (base), `-plane` (shadow, hugging one
  edge), `-sliver` (bright highlight strip). Keep the shadow plane a *strip*, not
  half the lock; covering half is what greyed out earlier versions.
- **Two clips per eye.** `#clip-socket-*` is the socket the lid slides inside —
  its edges only ever cut skin-coloured pixels. `#clip-aperture-*` is the eye
  opening and clips only the globe. This is what lets the upper lid translate
  down over the eye without spilling onto the cheek.
- **The rest pose is deliberately lidded.** `#eye-*-lid-upper` sits 3 units lower
  than a fully-open eye needs. That is the composed expression; do not "fix" it
  by raising the lash.

---

## 2. Animatable groups and transform origins

Rotations are SVG `rotate(deg cx cy)`. From CSS instead:
`transform-box: view-box; transform-origin: <cx>px <cy>px`.

| Group | Motion | Transform | Origin (cx, cy) | Range |
|---|---|---|---|---|
| `#head` | head tilt / nod | `rotate` | **256, 430** (neck base) | ±8° |
| `#head` | head bob | `translate` | — | ±3 px Y |
| `#eye-l-lid-upper` | blink | `translate(0, dy)` | — | **0 → 24** (24 = closed) |
| `#eye-r-lid-upper` | blink | `translate(0, dy)` | — | **0 → 24** |
| `#eye-l-lid-lower` | squint | `translate(0, dy)` | — | 0 → −8 |
| `#eye-r-lid-lower` | squint | `translate(0, dy)` | — | 0 → −8 |
| `#eye-l-globe` | look around | `translate(dx, dy)` | — | ±6 X, ±4 Y |
| `#eye-r-globe` | look around | `translate(dx, dy)` | — | ±6 X, ±4 Y |
| `#eye-l-pupil` | dilate | `scale` about (209, 281) | 209, 281 | 0.8 – 1.25 |
| `#eye-r-pupil` | dilate | `scale` about (303, 281) | 303, 281 | 0.8 – 1.25 |
| `#brow-l` | raise / anger | `translate` + `rotate` | **229, 240** (inner end) | ±7 px Y, ±10° |
| `#brow-r` | raise / anger | `translate` + `rotate` | **283, 240** (inner end) | ±7 px Y, ∓10° |
| `#mouth-*` | viseme swap | `display` | — | exactly one visible |
| `#mouth` | jaw drop | `scale(1, sy)` about (256, 366) | 256, 366 | 0.85 – 1.15 |
| `#hair-strand-l` | gross sway (all 3 planes) | `rotate` | **196, 212** | ±5° |
| `#hair-strand-l-a` | plane lag | `rotate` | **180, 214** | ±4° (on top of parent) |
| `#hair-strand-l-b` | plane lag | `rotate` | **190, 212** | ±4° (on top of parent) |
| `#hair-strand-l-c` | plane lag | `rotate` | **200, 212** | ±4° (on top of parent) |
| `#hair-strand-r` | sway | `rotate` | **314, 212** | ±6° |
| `#hair-bangs` | sway | `rotate` | **296, 212** (the part) | ±3° |
| `#hair-drape-l` | sway | `rotate` | **184, 342** (shoulder root) | ±4° |
| `#hair-drape-r` | sway | `rotate` | **326, 342** (shoulder root) | ±4° |
| `#hair-back` | body sway | `rotate` | **256, 150** (crown) | ±2° |
| `#ribbon` | breath / settle | `translate(0, dy)` | — | 0 → +2 px |
| `#backdrop` | — | `display` | — | hide for transparent output |

### Blink geometry

`#eye-*-lid-upper` contains a skin fill whose lower boundary *is* the lash curve.
Translating it down sweeps that boundary across the aperture (264 → 293):

- `translate(0, 0)` — rest (already slightly lidded)
- `translate(0, 11)` — half-lidded / sleepy
- `translate(0, 24)` — closed; the lash lands as a clean arc on the lower rim

The fill extends up to `y = 150`, above `#clip-socket-*`'s top edge, so at full
travel no sclera can peek out. Verified by rendering, not assumed.

---

## 3. Intended motion

**Idle.** `#head` rotate ±2° over ~6 s, out of phase with a ±2 px Y bob. Hair
strand groups follow the head with a 120–180 ms lag and ~1.4× amplitude.

**Hair planes.** Drive `#hair-strand-l` for the gross motion, then give
`-a` / `-b` / `-c` a small extra rotation each with ~60 ms of stagger (outermost
leads, innermost trails). Running the three in lockstep looks identical to a
single shape. Keep parent + child combined under about **8°**; past that the
plane roots emerge from under `#cap-visor`.

**Blink.** Close over ~70 ms, hold 40 ms, open over ~110 ms. Both lids fire
together. Random interval 3–7 s; double-blink about 1 in 6.

**Talk cycle.** Cross-fade `#mouth-*` by `display` on a 90–130 ms beat:
`closed → half-open → open → half-open → closed`, weighted toward `half-open`.
Drive from streamed-token cadence, not audio. `#mouth-smile` / `#mouth-frown`
are held expressions, not part of the cycle.

**Thinking.** `#head` −6°, `#eye-*-globe` translate (−5, −3), brows raised 4 px,
`#mouth-closed`, slower blink rate.

**Working / tool call.** Half-lid at `translate(0, 10)`, brows angled inward
(`#brow-l` +8°, `#brow-r` −8°), mouth closed.

**Error.** `#mouth-frown`, brows angled, one sharp `#head` tilt to +6° that
settles back.

**Done / success.** `#mouth-smile`, squint (`lid-lower` −6, `lid-upper` +8),
brows raised, hair strands overshoot then settle.

**Reduced motion.** With `prefers-reduced-motion`, keep only the blink and drop
every rotation.

---

## 4. Key geometry (512 canvas)

| Feature | Y |
|---|---|
| cap crown top | 68 |
| cap band | 158 – 192 |
| cap visor | 168 – 225 |
| brows | 232 – 248 |
| eye aperture | 264 – 293 |
| iris centre | 281 |
| nose | 342 |
| mouth | 366 |
| chin | 393 |
| neck ribbon | 396 – 419 |
| collar top / V notch | 386 / 416 |

Face box: x 168–344 (176 wide), y 148–393 (245 tall).
Cap crown 138–374 (236 wide); visor 112–400 (288 wide) — the cap is the widest
element in the composition and should stay that way.

---

## 5. The red accent — decision and rationale

The reference carries **no red anywhere**, and its cap band is dark. Earlier
versions of this avatar put a crimson band on the cap; that is now gone — it
read as a train-conductor's cap and directly contradicted the reference.

Red is kept as a **slim crimson choker at the throat** (`#ribbon`, moved out of
`#cap` and into `#neck`). Reasons:

1. **Small-size identity.** Below ~120 px the avatar's read collapses to three
   shapes: dark cap, pale hair column, indigo body. A saturated red pixel cluster
   under the chin is the only chromatic cue that survives, and it sits exactly
   where the eye lands.
2. **Canon.** The red neck ribbon is Vladilena's actual signature item; this is
   the one place a red accent is defensible against a reference that has none.
3. **It does not fight the uniform.** A band on the neck reads as an accessory;
   a bow at the collar V read as a bowtie and made the whole chest look like
   formalwear — that was tried and rejected during this pass.

Because it now sits on the neck rather than the cap, `#ribbon` no longer inherits
the head tilt and its motion budget is small (a 2 px settle). If a future
revision wants a fluttering ribbon back, move the group inside `#head` and give
it tails; the id contract is unchanged either way.

---

## 6. Palette tokens

All values sampled from the reference trace unless noted.

| Token | Value | Used by |
|---|---|---|
| `line/ink` | `#2C2755` | hair + silhouette outlines |
| `line/ink-deep` | `#1D1940` | uniform outlines |
| `line/ink-cap` | `#161230` / `#100D22` | cap crown / visor outlines |
| `hair/sliver` | `#EFF3FB` – `#FAFBFE` | bright highlight strips |
| `hair/base-lit` | `#E8EDF8` | fringe, innermost front plane |
| `hair/base` | `#D5DCEE` | mid front planes |
| `hair/base-outer` | `#BFC9E4` / `#C6CFE8` | outer plane, back mass, drape |
| `hair/plane-mid` | `#B4C0DC` | back mid bands |
| `hair/plane` | `#A6B2D5` / `#99A5CB` | front shadow planes |
| `hair/plane-deep` | `#7E88B4` | back + drape shadow planes |
| `hair/seam` | `#8189B5` / `#4A4478` | strand separations |
| `skin/lit` | `#FAF2E6` | face, neck |
| `skin/visor-shadow` | `#E6CBC5` | cast shadow under the visor |
| `skin/plane` | `#D9B6B2` / `#D3A8A5` | side + chin shadow planes |
| `skin/deep` | `#CFA09E` | neck shadow |
| `skin/blush` | `#D6928F` @ 0.16 | `g-blush` |
| `eye/sclera` | `#EBE9EA` | sclera |
| `eye/socket-shade` | `#C9C7D6` | upper sclera shadow |
| `eye/iris` | `#B4BEDA` | iris body |
| `eye/iris-plane` | `#93A0C6` | iris upper plane |
| `eye/iris-glow` | `#DDE4F4` | lower iris light |
| `eye/iris-rim` | `#4B4A72` | iris outline |
| `eye/pupil` | `#3B3458` | pupil |
| `eye/lash` | `#2E2850` | lash + lash tip |
| `eye/rim-lower` | `#6B6288` | lower eye rim line |
| `brow` | `#6B6884` | `#brow-l` `#brow-r` |
| `cap/crown-lit` | `#5F4FA0` / `#584899` | crown highlight + top plane |
| `cap/crown` | `#4B3C7C` → `#2A2044` | `g-cap` |
| `cap/crown-deep` | `#241C40` | crown shade, band |
| `cap/visor` | `#453D68` → `#16132A` | `g-visor` |
| `cap/visor-lit` | `#5E5880` | visor upper surface |
| `uniform/indigo` | `#3A3369` | jacket |
| `uniform/indigo-lit` | `#59578C` | shoulder yokes |
| `uniform/indigo-deep` | `#2B2652` | lapels |
| `uniform/collar` | `#453D77` | stand collar |
| `shirt/lit` | `#EFEEF6` | shirt front |
| `shirt/fold` | `#C3C5D8` | fold plane |
| `shirt/shade` | `#9C9DB8` | shadowed fold |
| `gold/light` | `#EFD8A2` / `#E7CE94` | `g-gold` stop 0, cord stud |
| `gold/mid` | `#D2B174` | insignia, cord |
| `gold/deep` | `#9E7A3A` / `#8A6A2C` | `g-gold` stop 1, board outline |
| `red/band` | `#9C2138` | `#ribbon-band` |
| `red/band-lit` | `#BC3049` | `#ribbon-knot` (upper facet) |
| `red/deep` | `#6E1626` / `#4E0C18` | tails, ribbon outline |
| `backdrop/core` | `#5A67A4` | `g-backdrop` stop 0 |
| `backdrop/edge` | `#15172C` | `g-backdrop` stop 1 |

**Mood tinting.** For per-tool colour states, animate `#backdrop`'s inner stop
only. The character's palette stays fixed so identity reads consistently.

---

## 7. Small-size behaviour

Checked at 320 / 160 / 120 / 96 / 64 px on light, mid and dark backgrounds.

- The read at 120 px is the **silhouette trio**: dark cap, pale hair column,
  indigo body — plus the red choker as the one chromatic cue. Protect those four
  in any edit.
- Outline weights are 3–4 units at 512 (~0.9 px at 120 px). Thinner dissolves on
  light backgrounds; thicker muddies the face.
- Below ~96 px the mouth shapes stop differentiating and the face becomes a
  pictogram. Drive mood by brow and lid position at those sizes. **This is an
  accepted limitation, not a bug.**
- `#backdrop` is what keeps pale hair legible on a light page. For a transparent
  avatar, hide it and add an outer ring in the host UI.

---

## 8. Known deviations from the reference

Deliberate, and not to be "fixed" without a new art direction:

- **Frontal, not 3/4.** The reference is a three-quarter view. A rig needs a
  symmetric frontal base so tilt and blink read correctly in both directions.
- **Brows over hair** (§1).
- **A red accent exists at all** (§5).
- **Outlines are heavier than the reference's lineart**, which is thin and
  varied. At 120 px the reference's line weight would disappear.
- **The outer silhouette is still dominated by `#hair-back`**, so the front-plane
  asymmetry does not reach the silhouette. Accepted.
