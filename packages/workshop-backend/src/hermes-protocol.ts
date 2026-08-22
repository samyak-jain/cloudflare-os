import type { AgentTool } from "@earendil-works/pi-agent-core";

/** Current Workshop/Hermes wire protocol version. */
export const HERMES_PROTOCOL_VERSION = 1;

/** Minimal inputs needed to serialize a strict Hermes Workshop turn request. */
export interface HermesTurnRequestOptions {
  clientTurnId: string;
  workspaceId: string;
  chatId: string;
  inputText: string;
  tools: AgentTool[];
}

/** Build the exact strict-protocol request body accepted by Hermes WorkshopTurnRequest. */
export function makeHermesTurnRequest(options: HermesTurnRequestOptions) {
  return {
    protocol_version: HERMES_PROTOCOL_VERSION,
    client_turn_id: options.clientTurnId,
    workspace_id: options.workspaceId,
    chat_id: options.chatId,
    input: { type: "user", text: options.inputText },
    tools: options.tools.map((tool) => ({
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters,
    })),
    metadata: {},
  };
}
