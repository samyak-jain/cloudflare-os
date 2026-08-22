/**
 * The art table: one portrait per `AvatarState`, plus the state → portrait mapping.
 *
 * This module is the *only* thing that knows the avatar is drawn as images at all. It is loaded
 * through a dynamic `import()` from `LenaAvatar.tsx`, which is what keeps the eleven asset URLs --
 * and, more importantly, the ~310 KB of WebP they point at -- out of the initial bundle.
 *
 * The art is vendored under `art/` as 384 px WebP (5.3x the 72 px presence bubble, so it stays sharp
 * past a 3x phone display and has headroom for a larger surface later). The 1024 px PNG masters are
 * deliberately *not* in the repo; see `../README.md` for the regeneration path.
 */

import type { AvatarState, AvatarStateKind, AvatarWorkKind } from "./state";

import doneUrl from "./art/done.webp";
import errorUrl from "./art/error.webp";
import idleUrl from "./art/idle.webp";
import listeningUrl from "./art/listening.webp";
import pausedUrl from "./art/paused.webp";
import talkingUrl from "./art/talking.webp";
import thinkingUrl from "./art/thinking.webp";
import workingBrowseUrl from "./art/working-browse.webp";
import workingExecuteUrl from "./art/working-execute.webp";
import workingReadUrl from "./art/working-read.webp";
import workingWriteUrl from "./art/working-write.webp";

/**
 * One key per drawn frame. Derived from `AvatarState` rather than written out, so adding a state
 * or a work kind is a type error here until the art exists for it.
 */
export type AvatarPortraitKey =
  | Exclude<AvatarStateKind, "working">
  | `working-${AvatarWorkKind}`;

/** Every portrait, in the order the QA harness and the contact sheet show them. */
export const AVATAR_PORTRAIT_KEYS = [
  "idle",
  "listening",
  "thinking",
  "talking",
  "working-read",
  "working-write",
  "working-browse",
  "working-execute",
  "error",
  "done",
  "paused",
] as const satisfies readonly AvatarPortraitKey[];

export const AVATAR_PORTRAITS: Record<AvatarPortraitKey, string> = {
  idle: idleUrl,
  listening: listeningUrl,
  thinking: thinkingUrl,
  talking: talkingUrl,
  "working-read": workingReadUrl,
  "working-write": workingWriteUrl,
  "working-browse": workingBrowseUrl,
  "working-execute": workingExecuteUrl,
  error: errorUrl,
  done: doneUrl,
  paused: pausedUrl,
};

/** Which frame an abstract state is drawn as. The whole renderer-side of the `state.ts` seam. */
export function portraitKeyFor(state: AvatarState): AvatarPortraitKey {
  return state.kind === "working" ? `working-${state.work}` : state.kind;
}

/**
 * Per-portrait CSS `filter`, applied on top of the baked art.
 *
 * Only `paused` has one. Its frame is already drawn asleep and cooled down, but "the socket
 * dropped" is a claim about the *app*, not about Lena, and a uniform desaturation is the
 * convention users already read that way. Both art tracks' notes recommended it as the semantic
 * for `paused`, so it lives here rather than in the art: if the art is ever re-baked warmer, the
 * signal does not have to be re-baked with it.
 *
 * Kept mild deliberately -- the art's own cool cast plus a hard greyscale reads as "image failed
 * to load" rather than "reconnecting" (chibi NOTES.md flags exactly this risk).
 */
export const AVATAR_PORTRAIT_FILTERS: Partial<Record<AvatarPortraitKey, string>> = {
  paused: "saturate(0.7) brightness(0.98)",
};

let preloadStarted = false;

/**
 * Fetch and decode every frame once per page.
 *
 * The crossfade cross-dissolves the outgoing frame into the incoming one, so a frame that is still
 * loading when its state arrives would dissolve into a blank -- far more visible than the load
 * itself would have been. At ~28 KB a frame the whole set is one small image's worth, so there is
 * nothing to be gained by loading them lazily and a visible pop to be lost.
 *
 * Module-scoped guard, not per-component: several avatars may mount (the harness shows three) and
 * they share one browser cache.
 */
export function preloadAvatarPortraits(): void {
  if (preloadStarted || typeof Image !== "function") return;
  preloadStarted = true;
  for (const key of AVATAR_PORTRAIT_KEYS) {
    const image = new Image();
    image.decoding = "async";
    image.src = AVATAR_PORTRAITS[key];
  }
}
