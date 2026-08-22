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
- Tool calls use a durable `(turn_id, call_id)` claim state machine. Claims land before execution,
  same-instance races wait on the claim, and results atomically replace the executing state before
  they are posted.
- Hermes chats skip local context compaction; non-Hermes chats retain the stock Pi loop unchanged.

## Phase 2 — wake and workspace deltas (complete)

- Added `POST /api/hermes/wake`, authenticated with the separate `WORKSHOP_WAKE_TOKEN`. It validates
  the announced event URL against the configured Hermes origin and durably registers an existing
  autonomous turn before acknowledging it.
- Wake turns attach to Hermes's existing event ledger rather than POSTing a second turn. Attachments
  survive DO/stream interruption until the terminal persistence barrier.
- Session ID changes reset the chat projection epoch while retaining tool-call rows for every
  older turn that has not reached a durable terminal state.
- Replay-derived user edits, reverts, and stale reads are sent as bounded canonical-JSON deltas with
  stable IDs. Established-session deltas are accepted before the dependent user turn; only a first
  session uses post-`turn.started` delivery. A stale established-session 409 now invalidates the
  local epoch and immediately creates a replacement turn, then delivers deltas post-start.

## Phase 4 — adversarial-review rework (complete)

All ten accepted findings in `hermes-integration-1/REVIEW.md` have concrete fixes:

1. The wire catalog uses `parameters`. `scripts/hermes-wire-contract.test.ts` constructs the real
   driver body and passes it through workshop-platform's actual `WorkshopTurnRequest.from_dict()`.
2. Tool execution is claimed durably before running. Concurrent duplicate deliveries serialize;
   resolved results replay directly. Write/edit rows, provisional gadget creation, blueprint rows,
   and binding edges carry a stable operation ID derived from `(turn_id, call_id)` and recognize
   crash-window replay. `requestConnection` only mutates turn-local capture state before the claim
   resolves, and `giveUp` is naturally repeatable after callback teardown. An unresolved
   `executeCode` claim becomes a typed interrupted error and is never silently re-executed.
3. `turn.end.status` now controls completed/error/aborted/interrupted semantics; `stop_reason` is
   retained only as the reason. Error/interrupted outcomes enter the existing `AgentTurnError`
   triage path.
4. The single wake slot is replaced by a durable per-chat FIFO. Distinct accepted turns cannot
   overwrite each other; dequeue is serialized, terminal registrations remain idempotent, and chat
   deletion cleans the queue.
5. A running wake remains durable through SSE body errors and 5xx/429 reattach failures. Reconnects
   use `after_seq`, exponential backoff and bounded `Retry-After`; alarms recover an idle queued or
   running wake after DO restart. Terminal acknowledgement occurs only after the shared projection
   barrier (and, for error turns, after the overseer persists the triage message).
6. Established-session workspace deltas are awaited before `POST /turns`; the ordering is asserted
   by the fake server.
7. `callbacks_complete` is checked immediately after tool completion as well as at message start.
8. HTTP failures retain status and bounded retry metadata only; arbitrary upstream bodies are never
   read into errors. Status 429 is classified and retried with `Retry-After`.
9. `HERMES_BASE_URL` requires HTTPS. Cleartext is available only with
   `HERMES_ALLOW_INSECURE_LOOPBACK=true` and a loopback hostname.
10. Hermes workspace-delta collection is allocated and populated only for Hermes handles; stock
    chats retain zero Hermes replay work.

New failure-path coverage includes durable claim-before-execute, racing deliveries, restart replay,
executeCode interruption, side-effect operation IDs, two queued wakes, terminal wake idempotency,
accepted-wake SSE failure/reconnect, 5xx/429 and failed-control retries, real terminal status/reason
combinations, delta-before-turn visibility, callback completion after tools, mid-stream epoch
rejection, the fifteen-minute control cap, and the actual cross-repository parser.

Rework validation:

- Actual workshop-platform parser contract: pass, 13 tools accepted.
- Focused Hermes workerd projects: 5 files / 53 tests pass; the driver/state/queue subset is
  3 files / 24 tests.
- Workshop backend: 39 files / 511 unit tests pass; local workerd integration passes 2 and skips
  the same 4 reset-flag cases documented as untestable locally.
- `pnpm build`: pass, all 67 workspace tasks (41 cache hits).
- `pnpm test`: pass, all 24 workspace test tasks, including the cross-repository parser test.
- `pnpm lint:check`: pass with pre-existing warning-level diagnostics only.
- `pnpm types:scripts`: pass.

## Phase 5 — second adversarial-review rework (complete)

All six findings in the `Re-review @ 8241e58` section are fixed:

1. Wake rows now retain `attempts`, `nextAttemptAt`, bounded failure metadata, and terminal
   `dead_letter` state. Retryable detachments use exponential backoff with jitter and stop after
   five failed wake attempts. Permanent 4xx/protocol poison dead-letters on its first confirmed
   failure, emits a structured error log, and remains queryable through
   `OverseerDurableObject.getHermesWakeHealth()`. Dequeue is FIFO among ready records, so a later
   ready wake advances while an earlier wake sleeps.
2. Tool claims carry their Hermes session epoch. Accepting or starting a new epoch never deletes
   another turn's rows; rows are garbage-collected by turn only after that turn records a durable
   terminal state. An old-epoch turn may therefore resume and terminate after a newer epoch was
   accepted without reopening `executeCode` execution.
3. Accepted attachments carry a durable `committedAfterSeq`. The assistant append, terminal marker,
   cursor, and projection key are written in one Durable Object storage transaction. Constructor
   recovery recognizes an already-projected wake and completes it without reattaching, preventing
   duplicate assistant appends across the projection/acknowledgement crash window.
4. An established-session delta 409 atomically clears the local session binding and proceeds to
   `POST /turns`; the new `turn.started` establishes the replacement epoch and deltas follow on the
   post-start path. Other delta failures are status-only logged and do not block the user turn.
5. Turn creation, reattach, tool-result, control, and delta requests all have abort-signal request
   deadlines. SSE reads have a 90-second idle deadline, and every local turn has a hard deadline at
   the configured turn cap plus 60 seconds. Retry, clean-EOF, `Retry-After`, and wake scheduling
   delays all include jitter.
6. `packages/workshop-backend/__integration__/hermes-durability.test.ts` uses the real Overseer DO
   and typed Durable Object storage. It covers claim-before-side-effect ordering, separate racing
   DO deliveries, restart with an unresolved `executeCode` claim, overlapping epochs, restart
   between terminal projection and wake completion, poison dead-letter advancement, and a
   202-accepted wake surviving object restart. The Map tests remain fast logic tests and are not
   cited as durability evidence.

The cross-repository parser test now fails when workshop-platform is absent. A local-only opt-out
requires the explicit `HERMES_CONTRACT_SKIP=1` environment variable.

Second-rework validation:

- Actual `WorkshopTurnRequest.from_dict()` parser: pass, 13 tools accepted.
- Focused Hermes unit tests: 3 files / 30 tests pass.
- Real Overseer workerd durability tests: 6/6 pass.
- Workshop backend: 39 files / 517 unit tests pass; workerd integration passes 8 and skips the same
  4 reset-flag cases documented as locally untestable.
- `pnpm build`: pass, all 67 workspace build tasks.
- `pnpm test`: pass, all 24 workspace test tasks; root scripts pass 147/147.
- `pnpm lint`: pass; warning-level diagnostics are pre-existing.

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

- Hermes implementation is committed in `b20ac29` (schema fixtures), `1b48d00` (initial provider
  and driver), `d40e0f6` (the first adversarial-review fixes), and `841a22f` (the six second
  re-review fixes plus real-DO durability coverage).
- Draft PR: https://github.com/samyak-jain/cloudflare-os/pull/1
- The second re-review fixes and their real-DO evidence are committed and ready to push to the
  existing draft PR; the PR remains intentionally unmerged.
