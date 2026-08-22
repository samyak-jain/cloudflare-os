/**
 * Animated Lena avatar.
 *
 * The avatar is a pure *view* of the chat event stream -- never agent-controlled. Layers:
 *
 *   `state.ts`      the abstract `AvatarState` union, the renderer-agnostic seam
 *   `mapping.ts`    `AiChatStreamEvent` + turn boundaries -> `AvatarState`, with hysteresis
 *   `controller.ts` the sink the existing chat subscriber feeds; publishes snapshots
 *   `portraits.ts`  the art table: `AvatarState` -> one of eleven baked frames
 *   `LenaAvatar`    cross-dissolves between frames, plus compositor-only breathing and bob
 *   `ChatAvatar`    binds a controller to `LenaAvatar`
 *
 * Art is vendored under `art/` as 384 px WebP, baked from the chibi track of the v2 bake-off.
 * `python3 art/build-art.py` re-vendors it from the masters and rebuilds the contact sheet.
 */

export { AvatarController } from "./controller";
export { AvatarStateMachine, DEFAULT_TIMINGS, workKindForTool } from "./mapping";
export type { AvatarMessageInput, AvatarTimings } from "./mapping";
export { avatarStatusLabel, describeAvatarState, sameAvatarState } from "./state";
export type { AvatarState, AvatarStateKind, AvatarStateSnapshot, AvatarWorkKind } from "./state";
export { default as ChatAvatar, ChatAvatarStatus } from "./ChatAvatar";
export { default as LenaAvatar } from "./LenaAvatar";
