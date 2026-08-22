/**
 * The chat-bound avatar: an `AvatarController` in, a rendered Lena out.
 *
 * Subscribes with `useSyncExternalStore`, so a state change re-renders this component and nothing
 * else -- the chat transcript is already the most render-sensitive surface in the app and the
 * avatar must not add to its churn.
 */

import { useSyncExternalStore } from "react";
import type { AvatarController } from "./controller";
import LenaAvatar from "./LenaAvatar";
import { avatarStatusLabel } from "./state";

export type ChatAvatarProps = {
  controller: AvatarController;
  size?: number;
  className?: string;
};

export default function ChatAvatar({ controller, size, className }: ChatAvatarProps) {
  const snapshot = useSyncExternalStore(
    controller.subscribe,
    controller.getSnapshot,
    controller.getSnapshot,
  );

  return <LenaAvatar snapshot={snapshot} size={size} className={className} />;
}

/**
 * The one-line caption for what Lena is doing.
 *
 * A separate subscriber on purpose: `ChatInterface` is the app's most render-sensitive component,
 * and reading the avatar state there would re-render the whole transcript several times a second
 * during a turn. Each of these two components re-renders alone.
 *
 * `quietWhenIdle` is how the caption becomes the presence bubble's status pill: `idle` says
 * "Ready", which is worth nothing beside an avatar that is visibly sitting there, and a pill that
 * is always up is a pill nobody reads. It fades out rather than unmounting, because the live region
 * has to stay in the tree for a screen reader to announce the next change through it.
 */
export function ChatAvatarStatus({ controller, className = "", quietWhenIdle = false }: {
  controller: AvatarController;
  className?: string;
  quietWhenIdle?: boolean;
}) {
  const snapshot = useSyncExternalStore(
    controller.subscribe,
    controller.getSnapshot,
    controller.getSnapshot,
  );
  const quiet = quietWhenIdle && snapshot.state.kind === "idle";

  return (
    <span
      className={className}
      aria-live="polite"
      data-avatar-status={snapshot.state.kind}
      data-avatar-status-quiet={quiet ? "true" : undefined}
      style={quietWhenIdle
        ? {
          opacity: quiet ? 0 : 1,
          transform: quiet ? "translateY(3px)" : "none",
          transition: "opacity 160ms ease-out, transform 160ms ease-out",
        }
        : undefined}
    >
      {avatarStatusLabel(snapshot.state)}
    </span>
  );
}
