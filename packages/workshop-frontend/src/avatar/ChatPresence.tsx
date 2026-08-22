/**
 * Lena as a floating presence bubble, anchored to the bottom-right of the chat transcript.
 *
 * ## Why she is not in the header any more
 *
 * v2 put a 96 px avatar and its caption inside the chat header, which grew the header from `h-12`
 * to `h-[104px]`. That is a permanent 52 px tax on the tallest-value strip of the page, paid on
 * every chat whether or not anything is happening, and the operator's verdict was that it "makes
 * the top bar too big". The headers are back to `h-12` unconditionally and Lena floats instead:
 * she costs no layout at all, so the space she takes is space nothing else wanted.
 *
 * ## Shape
 *
 * - **Hung off the top edge of the composer**, right-aligned: she floats over the bottom-right of
 *   the transcript, but her box is strictly outside the composer's, so she can never cover it. She
 *   is not inside the scroller either, so she does not scroll away with the messages.
 * - **72 px.** The art is a downscale of a 384 px frame, so it stays sharp well past this; 72 is
 *   chosen from the other end, as the smallest at which the four `working` frames still separate on
 *   their props. (They separate on props, not expression -- see the art notes.)
 * - **The caption is a pill**, and only while something is happening. Idle is quiet.
 * - **She yields while you read back.** The transcript is pinned to the bottom in the common case,
 *   and `ChatInterface` reserves end-of-transcript padding so the newest message clears her there.
 *   Scrolled up she would be over the middle of a message instead, so she fades out of the way and
 *   comes back when you are caught up. The listener lives here rather than in `ChatInterface`,
 *   which would re-render the whole transcript on every scroll frame to move one circle.
 * - **Tap tucks her away** to a 28 px tab in the same corner, remembered across reloads. The
 *   escape hatch matters more here than it did in the header: a floating element is over content by
 *   definition, and on a phone the transcript is only ~360 px wide.
 *
 * Nothing about the controller wiring changes -- `AvatarController` is layout-independent and this
 * subscribes to it exactly the way the header did.
 */

import { useCallback, useEffect, useState, type RefObject } from "react";
import { CaretLeft } from "@phosphor-icons/react";
import ChatAvatar, { ChatAvatarStatus } from "./ChatAvatar";
import type { AvatarController } from "./controller";

/** Diameter of the bubble, in CSS pixels. */
const BUBBLE_PX = 72;

const TUCKED_STORAGE_KEY = "gadgets:lena-tucked";

/**
 * How far from the bottom of the transcript counts as reading back rather than following along.
 *
 * Comfortably more than the 8 px `ChatInterface` uses to decide whether to keep auto-scrolling: a
 * circle that flickers as the last line settles would be worse than one that never moved.
 */
const READING_BACK_PX = 120;

/** Opacity while reading back. Low enough to read a line of the transcript straight through her. */
const YIELDED_OPACITY = 0.18;

// Read synchronously for the initial state, so a tucked Lena never flashes on screen before the
// effect that would have hidden her runs.
function readTucked(): boolean {
  try {
    return localStorage.getItem(TUCKED_STORAGE_KEY) === "1";
  } catch {
    return false;
  }
}

function writeTucked(tucked: boolean): void {
  try {
    localStorage.setItem(TUCKED_STORAGE_KEY, tucked ? "1" : "0");
  } catch {
    // A blocked or full localStorage costs the preference across reloads and nothing else.
  }
}

export type ChatPresenceProps = {
  controller: AvatarController;
  /**
   * Lift clear of the captured-log chip, which floats at the same bottom-right corner of the
   * message area on a narrow viewport. `ChatInterface` already pads the transcript for it the same
   * way; this is the floating half of that.
   */
  raised?: boolean;
  /** The transcript scroller, so she can get out of the way while it is scrolled back. */
  scrollerRef?: RefObject<HTMLElement | null>;
};

export default function ChatPresence({ controller, raised = false, scrollerRef }: ChatPresenceProps) {
  const [tucked, setTucked] = useState(readTucked);
  const [readingBack, setReadingBack] = useState(false);

  useEffect(() => {
    const scroller = scrollerRef?.current;
    if (!scroller) return;
    const update = () => {
      const away =
        scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight > READING_BACK_PX;
      // Only a boundary crossing re-renders; a scroll that stays on one side of it costs a compare.
      setReadingBack((previous) => (previous === away ? previous : away));
    };
    update();
    scroller.addEventListener("scroll", update, { passive: true });
    return () => scroller.removeEventListener("scroll", update);
  }, [scrollerRef]);

  const toggle = useCallback(() => {
    setTucked((previous) => {
      writeTucked(!previous);
      return !previous;
    });
  }, []);

  return (
    // `pointer-events-none` on the frame and `-auto` on the controls: the bubble is over the
    // transcript, and text under a 72 px circle still has to be selectable around it.
    <div
      className={`pointer-events-none absolute bottom-full right-0 z-20 flex flex-col items-end gap-2 p-3 sm:p-4 ${
        raised ? "pb-14 sm:pb-16" : ""
      }`}
      data-chat-presence={tucked ? "tucked" : "open"}
      data-chat-presence-yielded={readingBack ? "true" : undefined}
      style={{
        opacity: readingBack ? YIELDED_OPACITY : 1,
        transition: "opacity 180ms ease-out",
      }}
    >
      {tucked
        ? (
          <button
            type="button"
            onClick={toggle}
            className="themed-floating-shadow pointer-events-auto flex h-7 w-7 cursor-pointer items-center justify-center rounded-full border border-kumo-line bg-kumo-control text-kumo-inactive transition-colors hover:text-kumo-default"
            title="Show Lena"
            aria-label="Show Lena"
            data-chat-presence-reopen
          >
            <CaretLeft size={12} weight="bold" />
          </button>
        )
        : (
          <>
            {/*
              Right-aligned and above her, so the pill grows leftward into the gutter and can never
              push past the edge of a phone viewport however long a caption gets.
            */}
            <ChatAvatarStatus
              controller={controller}
              quietWhenIdle
              className="themed-floating-shadow max-w-[60vw] truncate rounded-full border border-kumo-line bg-kumo-control px-2.5 py-1 text-[11px] leading-4 font-medium tracking-[-0.2px] text-kumo-subtle"
            />
            {/*
              Elevation and a hairline rim, and deliberately no hover/press `scale`: a transform on
              a raster resamples it for as long as it is applied, which is the whole defect this
              change exists to remove. The feedback is a shadow and a border colour instead.

              `bg-kumo-control` under the border rather than nothing, so the antialiased hairline
              between a round border and a round image lands on a surface colour instead of on
              whatever the transcript happens to be showing through.
            */}
            <button
              type="button"
              onClick={toggle}
              className="themed-floating-shadow-lg pointer-events-auto cursor-pointer rounded-full border border-kumo-line bg-kumo-control transition-colors duration-150 ease-out hover:border-kumo-brand/45"
              title="Tuck Lena away"
              aria-label="Tuck Lena away"
            >
              <ChatAvatar controller={controller} size={BUBBLE_PX} />
            </button>
          </>
        )}
    </div>
  );
}
