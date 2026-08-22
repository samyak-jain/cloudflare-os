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
 * The one-line caption beside the avatar.
 *
 * A separate subscriber on purpose: `ChatInterface` is the app's most render-sensitive component,
 * and reading the avatar state there would re-render the whole transcript several times a second
 * during a turn. Each of these two components re-renders alone.
 */
export function ChatAvatarStatus({ controller, className = "" }: {
  controller: AvatarController;
  className?: string;
}) {
  const snapshot = useSyncExternalStore(
    controller.subscribe,
    controller.getSnapshot,
    controller.getSnapshot,
  );

  return (
    <span className={className} aria-live="polite">
      {avatarStatusLabel(snapshot.state)}
    </span>
  );
}
