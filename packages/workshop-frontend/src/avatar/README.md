# Lena avatar runtime

An avatar of Lena floating over the chat transcript, driven in real time by the turn stream.

**The avatar is a pure view of the chat event stream.** It is never agent-controlled: there is no
channel by which a model can select its own expression, and adding one would be a protocol change,
not a code change here. See `docs/cloudflare-os-integration.md` § "Animated avatar" in the design
repo, and `docs/lena-avatar-v2-plan.md` for why v1's SVG rig was replaced.

## Layers

| file | role |
| --- | --- |
| `state.ts` | The `AvatarState` union and its captions. The renderer-agnostic seam. |
| `mapping.ts` | `AiChatStreamEvent` + turn boundaries → `AvatarState`, with hysteresis. No DOM, no clock. |
| `controller.ts` | The sink the existing chat subscriber feeds; publishes snapshots to React. |
| `portraits.ts` | The art table: `AvatarState` → one of eleven baked frames, plus the `paused` filter. |
| `LenaAvatar.tsx` | Cross-dissolves between frames. Nothing else moves — see below. |
| `ChatAvatar.tsx` | Binds a controller to `LenaAvatar`, plus the status caption. |
| `ChatPresence.tsx` | What the chat mounts: the floating bubble, its status pill, and the tuck. |
| `art/` | Eleven 384 px WebP frames + `build-art.py`, the re-vendoring script. |
| `harness/` | Dev-only QA page. Not in the app bundle. |

![the eleven states](./states-contact-sheet.png)

Everything above `portraits.ts` is v1 code, unchanged: the event→mood machine was built to outlive
its renderer and did.

## The renderer

v1 drove a hand-authored 82-id SVG skeleton. The rig code was fine; the *authoring method* had a
ceiling, and on the contact sheet the eleven states were nearly indistinguishable. v2 replaces the
rig with eleven baked frames and a crossfade.

That works because of a property of the art: every frame is an image-model **edit of one anchor
frame**, so the whole set registers within a few pixels — eyes, hair silhouette and coat all land in
the same place. A plain opacity cross-dissolve therefore reads as Lena moving, because the only
things that visibly change across the dissolve are the parts the art changed. (`thinking` is the
loosest frame in the set and its hair edge ghosts slightly more than the others; see the art notes.)

## Motion, and why there is so little of it

The **only** thing that moves is the crossfade: 180 ms of `opacity` on the incoming frame, stacked
over the outgoing one, on `cubic-bezier(0.8, 0, 0.2, 1)`.

The first v2 cut also carried two ambient CSS animations — a ~4.6 s breathing `scale` and a ~1.1°
head-tilt `rotate` every ~11 s. Both were compositor-only and measured `+0.000 %` of a main thread
against a 0.071 % page floor, and both are gone, because an operator on the live deployment reported
"a lot of blurring and glitching" and they were it.

A baked portrait is a **raster**. Any non-identity transform resamples it, and the art arrives at
384 px to be drawn at 72, so the resample is a 5× downscale with real detail to lose. Measured in
Chromium on the harness, one 96 px avatar, scoring the drawn pixels (Laplacian variance for
high-frequency energy, mean/p99 |Δluma| between consecutive frames for edge motion):

| | high-frequency energy | per-frame edge motion, p99 |
| --- | --- | --- |
| at rest | 7619, *identical on every sample* | 0 |
| breathing | — | 6 luma levels, continuously |
| mid head-tilt | 7067 (**−7 %**), ramping over ~3 s | 38 luma levels |

So the tilt softened the whole frame for three seconds out of every eleven and sharpened it back,
and the breath kept every edge in the picture crawling sub-pixel for as long as it was on screen —
an amplified peak-motion map of one idle avatar lights up the entire line art. (The breath's
amplitude was also mis-stated as "well under a pixel at 96 px": `scale(1.018)` about a `50% 0%`
origin moves the *bottom* of the frame by ~1.7 px.)

Neither could be tuned out. A rotation resamples every pixel at any non-zero angle; a continuous
scale or translate passes through fractional device-pixel offsets at any amplitude. So the portrait
carries no transform at all now, and no `will-change` either. Post-fix, over 48 samples across 13 s
at DPR 1, 1.5, 2 and 3: per-frame drift exactly **0**, and sharpness a single constant value per
DPR. The raster is bit-identical for as long as a state holds.

What was checked and was *not* the cause: layer promotion size. At DPR 1/2/3 the composited raster
resolved detail at full device resolution both before and after — magnified crops of the eyes are
indistinguishable across every ablation. The art was never being snapshotted at 1× and scaled up.

The dissolve keeps a cost of its own. Every frame is opaque and covers the crop, so the screen shows
`p × incoming + (1−p) × outgoing` — a true cross-dissolve with no dip to the backdrop, but while `p`
is near 0.5 the two *poses* double-expose: `idle → thinking` shows a translucent phantom arm,
`talking → error` a doubled pair of fists. That is inherent to dissolving between poses and can only
be made shorter and steeper. 180 ms on `cubic-bezier(0.8, 0, 0.2, 1)` spends **24 ms** inside the
worst band (opacity 0.25–0.75), against 63 ms for the original 260 ms `cubic-bezier(0.33, 0, 0.2, 1)`.

There is no blink. The art has open eyes baked in, and faking one would cost a second frame per
state for a cue that does not survive to 72 px anyway.

The art's ahoge runs off the top edge of the masters, so the circle crop clips it in every frame at
every size. That is the art's own framing, not the renderer's — it is visible on the contact sheet
above and was accepted in the bake-off. Worth knowing before anyone "fixes" it by insetting the
art, which would put a ring of mismatched backdrop around her.

Under `prefers-reduced-motion: reduce` the dissolve becomes a cut. The renderer follows the OS
setting live (it listens for changes); `LenaAvatar`'s `reducedMotion` prop is a QA override for the
harness and is not plumbed through `ChatAvatar`.

## Where she lives

Not in the chat header. v2 put a 96 px avatar and its caption there, which grew both header render
sites from `h-12` to `h-[104px]` — a permanent 52 px tax on the top strip of every chat, and the
operator's verdict was that it "makes the top bar too big". Both headers are back to `h-12`
unconditionally.

`ChatPresence` floats her instead, at 72 px, hung off the top edge of the composer and right
aligned, so she is over the transcript (costing no layout) but strictly outside the composer (so she
can never cover it) and outside the scroller (so she does not scroll away). Around that:

- The caption is a **pill above her, and only while something is happening**. It stays mounted while
  idle so its `aria-live` region survives, but fades to nothing: `idle` says "Ready", which is worth
  nothing beside an avatar that is visibly sitting there.
- **She yields while you read back.** `ChatInterface` reserves end-of-transcript padding so the
  newest message clears her at the bottom of the scroll; scrolled up she would be over the middle of
  a message, so she fades to 18 % and returns when you are caught up. The scroll listener is inside
  `ChatPresence`, because putting it in `ChatInterface` would re-render the whole transcript on
  every scroll frame to move one circle.
- **Tap tucks her away** to a 28 px tab in the same corner, remembered in `localStorage` under
  `gadgets:lena-tucked` and read synchronously on first render so a tucked Lena never flashes.
- No hover or press `scale` on the bubble: a transform on a raster resamples it for as long as it is
  applied, which is the whole defect above. The feedback is a border colour instead.

`paused` gets a mild runtime `saturate(0.7)` on top of art that is already drawn asleep. "The socket
dropped" is a claim about the app rather than about Lena, and desaturation is the convention users
already read that way — but only mildly: fully greyed out, the frame reads as "image failed to
load" rather than "reconnecting".

## Art

`art/` holds the shipping encode only: eleven **384 px WebP q88**, ~28 KB each, ~310 KB for the set.
384 px is 5.3× the 72 px bubble, so it is sharp past a 3× phone display (72 × 3 = 216) with
headroom for a larger surface. Loading is one dynamic `import("./portraits")`, which keeps the URLs and the bytes out of
the initial bundle and then pulls the whole set into cache at once — a frame still loading when its
state arrives would dissolve into a blank, which is far more visible than the load it saved.

The 1024 px PNG masters are deliberately **not** in this repo. They live with the prompts and the
generator that made them:

```
~/Documents/projects/avatar-refs/v2-bakeoff/
  chibi/          <- shipped: 11 masters, NOTES.md, work/ (fal driver + prompt scripts)
  realistic/      <- banked, not wired
```

```bash
python3 src/avatar/art/build-art.py              # re-encode the set + rebuild the contact sheet
python3 src/avatar/art/build-art.py --sheet-only # sheet only, from the vendored WebP
```

Read `chibi/NOTES.md` before regenerating: it records the two-hop prompt pipeline that kept identity
and crop locked, the per-state caveats, and the honest weaknesses (`idle`/`listening`/`thinking` are
the closest trio at small sizes; the four `working` states separate on *props*, not expression;
gaze direction is not available as a lever).

**The realistic track is banked.** `v2-bakeoff/realistic/` is a complete second set — same eleven
states, same identity-locked pipeline, painted rather than anime. It was not chosen because its
detail does not survive the downscale, and it is not wired to anything here. If the avatar
ever gets a larger surface (an expanded side panel, a full-height presence), point `build-art.py`
at `--src .../realistic` and re-run: nothing else in this module knows which track it is drawing.

## Wiring

`ChatInterface` already owns exactly one `AiChatSubscriber` for the whole workspace. The avatar does
**not** open a second subscription — a second `subscribeToChat()` would double the DO's push fan-out
and replay history the UI has already consumed. Instead the existing subscriber's handlers forward
what they already received:

- `stream()` → `AvatarController.handleStream()`
- `message()` → `AvatarController.handleMessage()`
- `metadata()` → `AvatarController.setAgentActive()` (from `activeAgent`)
- `useConnectionLost()` → `setConnectionLost()`
- the composer's `onSend` / `onChange` → `noteUserMessageSent()` / `noteUserComposing()`

The avatar module has no RPC surface at all; `grep -r overseer src/avatar` returns nothing.

The whole thing is behind the `FEATURE_CHAT_AVATAR` deployment flag
(`ServerConfig.chatAvatarEnabled`), which is off unless a deployment sets it.

## Why the mapping is not "the last event type"

Two properties the raw stream does not have (see the header comment in `mapping.ts`):

1. **Stickiness across silence.** `toolCallFinished` means the tool finished streaming its *input*;
   it then executes, emitting nothing for most tools. A decay-based reading would show `idle` in the
   middle of the longest part of a tool call. The turn boundary, not a timeout, ends `working`.
2. **Resistance to interleaving.** Models interleave short reasoning bursts into narration. A newly
   entered state cannot be displaced by a lower-priority one until its dwell elapses; higher-priority
   signals (a tool starting mid-sentence) preempt immediately.

That hysteresis is also what keeps the crossfade from thrashing: states change on the order of
seconds, not frames, so the 180 ms dissolve almost always completes before the next one starts.
`LenaAvatar` caps the stack at four layers for the case where it does not.

## QA

`vite dev` serves a harness at **`/avatar-harness.html`** that reaches every state *through the real
mapping layer* — it feeds synthetic `AiChatStreamEvent`s into a real `AvatarController` rather than
force-setting a state, so a screenshot never shows a pose the event stream could not produce. It
exposes `window.__avatar` for browser automation:

| call | |
| --- | --- |
| `go(label)` | jump to one state; `labels()` lists them |
| `script()` | replay a realistic tool-using turn at real spacing |
| `cycle()` | walk every state, 1.1 s apart — the crossfade review |
| `state()` | the current `AvatarState` |

The page also shows the live snapshot rendered with motion forced off, beside the normal one, and a
force-set art sheet of all eleven frames at bubble size. Vite's default build input is `index.html`
alone, so `avatar-harness.html` and everything it imports are absent from `dist/`.

Unit tests: `mapping.test.ts` (event sequences → transitions, hysteresis and hold timings, driven by
a hand-stepped clock), `portraits.test.ts` (every state maps to a frame, and to its own frame),
`LenaAvatar.test.tsx` (state → drawn frame, the stack-then-collapse crossfade and its cap and
timing, that *nothing* transforms a frame, the `paused` filter, and the reduced-motion path
including a switch mid-dissolve), and `ChatPresence.test.tsx` (the quiet-when-idle pill, the tuck
and its persistence, and the scroll-back fade).

The measurements quoted above are reproducible against the harness with Playwright: screenshot the
72 px stage instance repeatedly, decode each shot on an `OffscreenCanvas`, and score Laplacian
variance (sharpness) and mean/p99 |Δluma| between consecutive shots (edge motion). Per-frame drift
must be **0** at every device pixel ratio — a non-zero value means something is transforming the
raster again.
