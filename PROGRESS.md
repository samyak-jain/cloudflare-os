# Hermes remote agent driver progress

## Phase 0 — runtime tool schema fixtures (complete)

- Centralized the 13 Workshop agent tool protocol definitions in
  `packages/workshop-backend/src/agent-tool-definitions.ts`; `agent.ts` now consumes the same
  runtime TypeBox objects used by the fixture exporter.
- Added `scripts/export-workshop-tool-schemas.ts`.
- Exported one JSON fixture per tool plus `index.json` to the Hermes worktree at
  `fixtures/workshop-tool-schemas/`.
- Canonical catalog SHA-256:
  `f466b2e194cd16ffc91ba39cadb2947217ce8a9c0548edff45ccfae516f8b1a4`.
- Validation: `vp run -F @gadgets/workshop-backend build` passes.

## Phase 1 — provider and remote driver (in progress)

- Mapping provider registration, chat persistence, callback wake routing, replay deltas, and the
  existing `AgentEvent` persistence barrier before implementation.

## Remaining

- Register deployment-level `hermes` provider and its model selection path.
- Implement the remote SSE driver, durable tool-call idempotency, reconnect/control/epoch/error
  semantics, and skip local compaction for Hermes chats.
- Implement authenticated wake attach and bounded workspace deltas.
- Add fake Hermes server coverage and run the existing suite.
- Commit in logical phases, push, and open the requested draft PR.
