// @vitest-environment jsdom
/* eslint-disable react/react-in-jsx-scope */

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import ChatPresence from "./ChatPresence";
import { AvatarController } from "./controller";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const CHAT_ID = 1;
const TUCKED_KEY = "gadgets:lena-tucked";

const click = async (element: HTMLElement) => {
  await act(async () => {
    element.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
};

describe("ChatPresence", () => {
  let root: Root;
  let container: HTMLDivElement;
  let controller: AvatarController;

  /** `LenaAvatar` loads its art through a dynamic import; give the promise a turn before asserting. */
  const mount = async () => {
    await act(async () => root.render(<ChatPresence controller={controller} />));
    await act(async () => {});
  };

  const frame = () => container.querySelector<HTMLElement>("[data-chat-presence]")!;
  const pill = () => container.querySelector<HTMLElement>("[data-avatar-status]");
  const bubble = () => container.querySelector<HTMLElement>('[aria-label="Tuck Lena away"]');
  const reopen = () => container.querySelector<HTMLElement>("[data-chat-presence-reopen]");

  beforeEach(() => {
    window.matchMedia ??= (() => ({
      matches: false, addEventListener() {}, removeEventListener() {},
    })) as unknown as typeof window.matchMedia;
    localStorage.clear();
    controller = new AvatarController();
    controller.setChat(CHAT_ID);
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    controller.destroy();
  });

  it("keeps idle quiet: the pill is mounted for the live region but invisible", async () => {
    await mount();
    expect(pill()!.dataset.avatarStatus).toBe("idle");
    expect(pill()!.dataset.avatarStatusQuiet).toBe("true");
    expect(pill()!.style.opacity).toBe("0");
    // Still in the tree, or a screen reader would have nothing to announce the next change through.
    expect(pill()!.getAttribute("aria-live")).toBe("polite");
  });

  it("shows the pill as soon as anything is happening", async () => {
    await mount();
    await act(async () => {
      controller.setAgentActive(CHAT_ID, true);
      controller.handleStream(CHAT_ID, { type: "reasoningDelta", delta: "..." });
    });
    expect(pill()!.dataset.avatarStatus).toBe("thinking");
    expect(pill()!.dataset.avatarStatusQuiet).toBeUndefined();
    expect(pill()!.style.opacity).toBe("1");
    expect(pill()!.textContent).toBe("Thinking…");
  });

  it("tucks away to the reopen affordance and back", async () => {
    await mount();
    expect(frame().dataset.chatPresence).toBe("open");

    await click(bubble()!);
    expect(frame().dataset.chatPresence).toBe("tucked");
    expect(bubble()).toBeNull();
    expect(pill()).toBeNull();
    expect(reopen()!.getAttribute("aria-label")).toBe("Show Lena");

    await click(reopen()!);
    expect(frame().dataset.chatPresence).toBe("open");
    expect(bubble()).not.toBeNull();
  });

  it("remembers the choice across a remount", async () => {
    await mount();
    await click(bubble()!);
    expect(localStorage.getItem(TUCKED_KEY)).toBe("1");

    act(() => root.unmount());
    root = createRoot(container);
    await mount();
    // Read synchronously on the first render: a tucked Lena must never flash on screen first.
    expect(frame().dataset.chatPresence).toBe("tucked");
  });

  it("fades out of the way while the transcript is scrolled back, and returns at the bottom", async () => {
    const scroller = document.createElement("div");
    Object.defineProperties(scroller, {
      scrollHeight: { value: 2000, configurable: true },
      clientHeight: { value: 500, configurable: true },
    });
    scroller.scrollTop = 1500; // pinned to the bottom
    const scrollerRef = { current: scroller };

    await act(async () => {
      root.render(<ChatPresence controller={controller} scrollerRef={scrollerRef} />);
    });
    await act(async () => {});
    expect(frame().dataset.chatPresenceYielded).toBeUndefined();
    expect(frame().style.opacity).toBe("1");

    await act(async () => {
      scroller.scrollTop = 900;
      scroller.dispatchEvent(new Event("scroll"));
    });
    expect(frame().dataset.chatPresenceYielded).toBe("true");
    expect(Number(frame().style.opacity)).toBeLessThan(0.3);

    await act(async () => {
      scroller.scrollTop = 1500;
      scroller.dispatchEvent(new Event("scroll"));
    });
    expect(frame().dataset.chatPresenceYielded).toBeUndefined();
  });

  it("lifts clear of the captured-log chip when one is up", async () => {
    await act(async () => root.render(<ChatPresence controller={controller} raised />));
    await act(async () => {});
    expect(frame().className).toContain("pb-14");
    // Never over the composer: her box hangs off its top edge rather than sitting inside it.
    expect(frame().className).toContain("bottom-full");
  });
});
