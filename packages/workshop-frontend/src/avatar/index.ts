/**
 * Animated Lena avatar.
 *
 * The avatar is a pure *view* of the chat event stream -- never agent-controlled. Layers:
 *
 *   `state.ts`      the abstract `AvatarState` union, the renderer-agnostic seam
 *   `mapping.ts`    `AiChatStreamEvent` + turn boundaries -> `AvatarState`, with hysteresis
 *   `controller.ts` the sink the existing chat subscriber feeds; publishes snapshots
 *   `rig.ts`        `art/RIG.md` as code: origins, safe ranges, transform composition
 *   `poses.ts`      RIG.md §3 per-state motion, as pure functions of time
 *   `renderer.ts`   the rAF loop: smoothing, blinks, visemes, reduced motion
 *   `LenaAvatar`    inlines the SVG and drives the rig
 *   `ChatAvatar`    binds a controller to `LenaAvatar`
 *
 * Art is vendored under `art/` from `lena-avatar-chibi@a57bcf9`. `python3 art/verify.py` validates
 * the rig contract the code here depends on.
 */

export { AvatarController } from "./controller";
export { AvatarStateMachine, DEFAULT_TIMINGS, workKindForTool } from "./mapping";
export type { AvatarMessageInput, AvatarTimings } from "./mapping";
export { avatarStatusLabel, describeAvatarState, sameAvatarState } from "./state";
export type { AvatarState, AvatarStateKind, AvatarStateSnapshot, AvatarWorkKind } from "./state";
export { default as ChatAvatar, ChatAvatarStatus } from "./ChatAvatar";
export { default as LenaAvatar } from "./LenaAvatar";
