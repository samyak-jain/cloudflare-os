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

## Phase 1 — provider and remote driver (complete)

- Added the deployment-owned `hermes` provider. It bypasses user/BYOK and AI Gateway routing and
  resolves only from `HERMES_BASE_URL` plus a 64+-hex `WORKSHOP_API_KEY`.
- Added an SSE remote driver that sends only the newest input, projects Hermes events through the
  existing `AgentEvent` sink, executes Workshop tools locally, reconnects with `after_seq`, and
  sends abort/graceful end-turn controls.
- Tool execution results are persisted by `(turn_id, call_id)` before they are posted, so duplicate
  events and turn retries reuse the prior result.
- Hermes chats skip local context compaction; non-Hermes chats retain the stock Pi loop unchanged.

## Phase 2 — wake and workspace deltas (complete)

- Added `POST /api/hermes/wake`, authenticated with the separate `WORKSHOP_WAKE_TOKEN`. It validates
  the announced event URL against the configured Hermes origin and durably registers an existing
  autonomous turn before acknowledging it.
- Wake turns attach to Hermes's existing event ledger rather than POSTing a second turn. Attachments
  survive DO/stream interruption until the terminal persistence barrier.
- Session ID changes clear per-epoch tool projection state.
- Replay-derived user edits, reverts, and stale reads are sent as bounded canonical-JSON deltas with
  stable IDs after session establishment. A 409 is intentionally retried by the next replay.

## Phase 3 — validation (complete)

- `vp run -F @gadgets/workshop-backend build`: pass.
- `pnpm lint:check`: pass (pre-existing warnings only).
- Fake Hermes workerd suite: 7/7 pass, covering new-input request shape, reconnect/`after_seq`,
  duplicate call idempotency, graceful `after_current_call`, abort, workspace-delta 409, epoch
  reporting, and error turns.
- Full `pnpm build`: pass (all 67 workspace build tasks completed; 38 cache hits).
- Full `pnpm test`: pass (all 24 workspace test tasks completed). The Workshop backend unit project
  passed 493/493 tests; its local workerd integration project passed 2 tests and skipped 4 tests
  whose reset-flag behavior is explicitly untestable locally. The Hermes driver/wake coverage is
  included in those green workspace results.

## Remaining

- Commit in logical phases, push, and open the requested draft PR.
