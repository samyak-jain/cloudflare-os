# Lena avatar runtime

An animated avatar of Lena in the chat header, driven in real time by the turn stream.

**The avatar is a pure view of the chat event stream.** It is never agent-controlled: there is no
channel by which a model can select its own expression, and adding one would be a protocol change,
not a code change here. See `docs/cloudflare-os-integration.md` § "Animated avatar" in the design
repo — this is authoring path A (pure-code layered SVG rig), built so the renderer can be replaced
by a Rive runtime without touching the integration.

## Layers

| file | role |
| --- | --- |
| `state.ts` | The `AvatarState` union and its captions. The renderer-agnostic seam. |
| `mapping.ts` | `AiChatStreamEvent` + turn boundaries → `AvatarState`, with hysteresis. No DOM, no clock. |
| `controller.ts` | The sink the existing chat subscriber feeds; publishes snapshots to React. |
| `rig.ts` | `art/RIG.md` as code: transform origins, safe ranges, composition order, id namespacing. |
| `poses.ts` | RIG.md §3 per-state motion, as pure functions of time. |
| `renderer.ts` | The rAF loop: transition smoothing, blinks, visemes, reduced motion, frame-rate tiers. |
| `LenaAvatar.tsx` | Inlines the SVG and drives the rig. |
| `ChatAvatar.tsx` | Binds a controller to `LenaAvatar`, plus the status caption. |
| `harness/` | Dev-only QA page. Not in the app bundle. |

![the eleven states](./states-contact-sheet.png)

`art/` is vendored from `lena-avatar-chibi@a57bcf9`: `lena.svg` (82 hand-authored `lena-*` ids),
`RIG.md` (the rig's API — read it before touching `rig.ts` or `poses.ts`), and `verify.py`.

```bash
python3 src/avatar/art/verify.py        # validate the rig contract the code depends on
```

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

## Why the mapping is not "the last event type"

Two properties the raw stream does not have (see the header comment in `mapping.ts`):

1. **Stickiness across silence.** `toolCallFinished` means the tool finished streaming its *input*;
   it then executes, emitting nothing for most tools. A decay-based reading would show `idle` in the
   middle of the longest part of a tool call. The turn boundary, not a timeout, ends `working`.
2. **Resistance to interleaving.** Models interleave short reasoning bursts into narration. A newly
   entered state cannot be displaced by a lower-priority one until its dwell elapses; higher-priority
   signals (a tool starting mid-sentence) preempt immediately.

## Cost

The idle cost is **entirely rasterization** — with the element `display:none` the loop's JS and
attribute writes measure at zero. So the frame rate is the only real lever, and `renderer.ts` runs
at the slowest rate the current state's motion tolerates: 8 fps idle, 24 fps during a turn, 60 fps
for cuts, impulses and the ~0.4 s settle after a state change. The loop stops entirely while the
document is hidden, and never starts under `prefers-reduced-motion`.

Measured on a loaded dev box against the Vite dev build, one 96 px avatar, medians of 7 interleaved
A/B intervals (`Performance.getMetrics` `TaskDuration` ÷ wall):

| | main-thread task time |
| --- | --- |
| page floor, avatar detached | 1.18 % |
| + renderer JS and DOM writes, not painted | +0.05 % |
| + paint | +0.64 % |
| **net cost of one idle avatar** | **0.69 %** |
| under `prefers-reduced-motion` | ~0 % (no loop) |

## QA

`vite dev` serves a harness at **`/avatar-harness.html`** that reaches every state *through the real
mapping layer* — it feeds synthetic `AiChatStreamEvent`s into a real `AvatarController` rather than
force-setting a state, so a screenshot never shows a pose the event stream could not produce. It
exposes `window.__avatar` (`go(label)`, `script()`, `state()`, `labels()`) for browser automation.

Vite's default build input is `index.html` alone, so `avatar-harness.html` and everything it imports
are absent from `dist/`.

Unit tests: `mapping.test.ts` (event sequences → transitions, hysteresis and hold timings, driven by
a hand-stepped clock) and `rig.test.ts` (transform composition against RIG.md's origins, safe-range
clamping, id namespacing, blink curve, reduced-motion static holds).

## Deliberate deviations from RIG.md

- **`CROP_VIEWBOX`.** The art is composed for a square frame: `lena-ahoge`'s topmost ink is at y = 1,
  255.3 units from the centre — a hair inside the inscribed circle at rest, and outside it the
  moment the loop scales or the head lifts. The art is therefore inset in a slightly larger,
  top-heavy box so the ahoge survives the circle crop. Since RIG.md §3 makes the ahoge the state
  signal that survives to the smallest sizes, losing its tip is the one crop loss worth spending
  6 % of face size on.
- **Resting blush at 0.87.** RIG.md §3 asks for blush "up to 1.15× for 400 ms" on `error`, but SVG
  group opacity clamps at 1. Resting slightly under 1 buys the beat back at the documented ratio.
- **Per-kind `working` poses.** RIG.md specifies one `working` pose; the four variants
  (read / write / browse / execute) are built from the same channels and safe ranges, chosen so they
  are distinguishable at 96 px from the eyes alone.
- **Blinks every 2–6 s** rather than RIG.md's 4–7 s, per the runtime spec.
