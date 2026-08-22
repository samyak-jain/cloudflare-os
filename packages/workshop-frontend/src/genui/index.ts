/**
 * Generative UI: ephemeral, in-conversation interfaces rendered from a validated JSON tree.
 *
 * Self-contained by design -- see `README.md`. Nothing outside this directory knows about the
 * catalog, and the only things it exports are what a chat transcript needs to place a card.
 */

export { GenerativeUiCard, ComposingUiCard, UnreadableUiCard } from "./GenerativeUiCard";
export { normalizeGenerativeUiResult } from "./validate";
export { findLiveGenerativeUiCall } from "./liveCard";
export {
  createOverseerGenerativeUiClient,
  createRecordingGenerativeUiClient,
  type GenerativeUiClient,
} from "./client";
