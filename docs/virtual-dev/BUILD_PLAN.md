# Flaio Virtual Developer — Parallel Build Plan

Source design: "Flaio → Virtual AI Developer: Product Review & Plan" (Claude doc, 2026-10-13).
Scope of this plan: Phases A (continuity), B (assignable), C (Jev layer) + web UI. Phase D (multi-agent lead/workers) is planned after Stage 2 lands — it depends on everything here.

Repos
- CLI: `flaio-ai/flaio` (public, MIT) — `flaio-cli`
- Platform: `flaio-ai/flaio-app` (private monorepo: packages/shared, relay-server, functions, web-app)

## Shape

| Stage | Agents | Runs | Gate to next stage |
|---|---|---|---|
| 0. Contracts | 1 | serial, ~0.5 day | CONTRACTS.md + shared types merged to `virtual-dev` in both repos |
| 1. Build | 7 in parallel (2 CLI, 5 platform) | parallel, ~1–2 weeks | each PR green, merged into `virtual-dev` |
| 2. Integrate | 1 | serial | Jira-assigned ticket goes plan → implement → PR with one resumed agent session |
| 3. Multi-agent (Phase D) | separate plan | later | — |

## Rules for every agent
- Branch from `virtual-dev` (created by Stage 0). Branch name `vd/<workstream-id>`. Open a PR into `virtual-dev`, never `main`.
- Only edit files in your OWNED paths. Need a change elsewhere? Code against the contract with a stub/adapter in your own paths and list the needed change under "Integration notes" in the PR description.
- Never deploy, never change CI/deploy workflows, never touch secrets or `.env` files, never commit keys.
- Types come from the contract: platform → `packages/shared` (`agent-loop.ts`, `protocol.ts`); CLI → `src/contracts/` + `src/relay/relay-protocol.ts` / `relay-message-schemas.ts`. Don't redefine them, and don't edit contract files — put needed contract changes under "Integration notes".
- Tests: add unit tests for new logic; `npm run build` must pass. No live external API calls in tests (mock Jira/Linear/ClickUp/GitHub/Jev/Anthropic).
- PR description: what was built, how to test, integration notes, open questions.

---

## Stage 0 — Contracts (done)

Merged to `virtual-dev` in both repos. `docs/virtual-dev/CONTRACTS.md` is the authoritative reference: types in `packages/shared/src/agent-loop.ts` (platform) and `src/contracts/` (CLI), protocol messages, MCP tool schemas, job kinds and owned paths. Where this plan and CONTRACTS.md disagree on a name, CONTRACTS.md wins.

---

## Stage 1 — Parallel workstreams

### WS-A1 · CLI session continuity  (repo: flaio)
Owned: `src/agents/drivers/**`, `src/agents/agent-session.ts`, `src/relay/ticket-tracker.ts`, `src/relay/relay-client.ts` (ticket/job handlers only), `src/relay/worktree-manager.ts`.
Build:
1. Claude driver: `buildTicketSpawnArgs({sessionId, permissionMode, prompt, model, mcpConfigPath?})` using `--session-id <uuid>` on first run, `--resume <uuid>` after, `--permission-mode plan|acceptEdits`, optional `--fork-session`. VERIFY flags against the installed Claude Code CLI (`claude --help`) and adapt. Codex/Gemini: equivalent best effort, clearly marked.
2. Replace handleStartPlanning / handleStartInteractivePlanning / handleStartImplementation with one `runJob(job, ticketContext)` that reuses the ticket's agent session id (resume) across phases. Keep the old relay_start_* messages working by mapping them onto runJob.
3. Capture Claude's real `session_id` + `transcript_path` from the sideband metadata and send `cli_agent_session`.
4. Persist TicketTracker to `~/.config/flaio/tickets.json` (atomic writes) and reconcile on start-up.
5. handleRequestChanges: if the PTY is gone, resume the session with the feedback instead of returning.
6. Phase end comes from `TicketPhaseBus.phase_complete` (WS-A2). Keep idle-detection only as a fallback that marks the ticket `stuck`, never `done`.
7. Model list from config, not hard-coded.

### WS-A2 · Flaio MCP server, ticket workspace, Claude Code plugin  (repo: flaio)
Owned: `src/mcp/**`, `src/workspace/**`, `plugin/**`, `src/hooks/stop-hook.ts`, `src/hooks/install.ts`, `src/hooks/hook-server.ts`.
Build:
1. Stdio MCP server (`flaio mcp --ticket <id>`) implementing the tools in `src/contracts/mcp-tools.ts`; forwards calls to the running CLI over the existing local hook server; CLI side emits on `TicketPhaseBus`.
2. `src/workspace/`: create/maintain `.flaio/ticket/{brief,plan,decisions,progress,questions}.md` in the ticket worktree; `writeBrief(markdown)`; ensure `.flaio/ticket/` is excluded from commits (`.git/info/exclude`).
3. Export `getMcpSpawnConfig(ticketId)` returning the `--mcp-config` path/JSON so WS-A1 can pass it on spawn.
4. Stop hook: if a ticket session stops without `progress.md` updated this phase, block once with instructions to write the handoff note (use Claude Code's Stop-hook block semantics; verify).
5. `plugin/`: Claude Code plugin (`.claude-plugin/plugin.json`) bundling the MCP server, hooks and slash commands `/flaio:ticket <id>` (load context into the current session) and `/flaio:handoff`. Check the current Claude Code plugin format docs before writing the manifest.

### WS-S1 · Ticket event log + context assembler  (repo: flaio-app)
Owned: `packages/relay-server/src/ticket-persistence.ts`, `packages/relay-server/src/ticket-api.ts`, `packages/relay-server/src/context/**` (new), `packages/relay-server/src/cli-handler.ts`, `firestore.rules`, `firestore.indexes.json`.
Build:
1. Event writer `appendTicketEvent(uid, ticketId, event)` (+ reuse audit-log patterns) and handle `cli_ticket_event`, `cli_agent_session`, `cli_phase_complete` in cli-handler (persist, then broadcast to browsers as today).
2. Context assembler `buildTicketBrief(ticket, events)` → markdown: title, description, acceptance criteria, external comments, answered questions, decisions, current plan, last handoff note, PR review comments, CI failures. Pure function + unit tests with fixtures.
3. Firestore rules + indexes for `events`, `jobs`, `runners` (owner-only read; server writes).
4. Ticket API: `GET /api/tickets/:id/events`, `GET /api/tickets/:id/brief`.

### WS-S2 · Orchestrator, job queue, runner registry  (repo: flaio-app)
Owned: `packages/relay-server/src/orchestrator/**` (new), `packages/relay-server/src/browser-handler.ts`, `packages/relay-server/src/connection-manager.ts`, `packages/relay-server/src/session-store.ts`, `packages/relay-server/src/heartbeat.ts`.
Build:
1. Firestore-backed queue: `enqueueJob`, lease-based `claimJob` (transaction, `leaseExpiresAt`), retry with attempts cap, `completeJob`.
2. Runner registry: handle `cli_runner_register`/`cli_runner_heartbeat`; mark offline after missed heartbeats.
3. Dispatcher: when a runner for the ticket's owner/org is online, send `relay_run_job` with `ticketContext.briefMarkdown` (call WS-S1's `buildTicketBrief` through an injected function; stub until merged). Replaces `cliConns[0]`; queued jobs dispatch when a runner comes online.
4. Ticket state machine module (`orchestrator/state-machine.ts`): given a ticket + new event → next job(s) or state change. Include hooks for the decision layer (`DecisionProvider` interface from shared; default = always escalate to human so behaviour matches today).
5. browser-handler: `start_planning`/`approve`/`request_changes` enqueue jobs instead of sending directly.

### WS-S3 · Inbound integrations  (repo: flaio-app)
Owned: `packages/functions/src/integrations/**`, `packages/functions/src/github/**`, `packages/functions/src/triggers/ticket-sync.ts`.
Build:
1. Per org integration config: `agentAssignee` (Jira accountId / Linear userId / ClickUp userId) and `agentLabel` (default `flaio`). An issue assigned to the agent identity or labelled → ticket with `assignedToAgent: true` + enqueue a `plan` job (write to `jobs` per contract).
2. Comments: for existing tickets, store `external_comment` events (today they are dropped in `issue-sync.ts`). If the ticket is `needs_info`, enqueue `answer_resume`.
3. GitHub: PR review comment on a Flaio branch → `pr_review_comment` event + `review_fixes` job; failed check run → `ci_failed` event (+ truncated log) + `ci_fix` job (cap 3 per ticket).
4. Outbound: post `question_asked` events as comments in the source tool (extend `comment-sync.ts`).
5. Ticket ownership: agent-assigned tickets keep the mapped human as owner (`ownerUid`) for now — note org-level queue as a follow-up in the PR.

### WS-S4 · Decision layer (Jev)  (repo: flaio-app)
Owned: `packages/decisions/**` (new workspace package).
Build:
1. `DecisionProvider` implementation of the shared interface; `JevProvider` (HTTP client; base URL + key from env `JEV_API_URL`, `JEV_API_KEY`; request/response shape behind an adapter because the API is early access — document assumptions); `LlmProvider` fallback using Anthropic structured output with a small model (env `ANTHROPIC_API_KEY`).
2. `decide(id, input, {threshold})` → tries Jev, escalates to LLM below threshold or on error, then to `human` result. Every call returns a `DecisionResult` and an event payload for `jev_decision`.
3. Definitions for the 8 decisions with prompt/feature builders and allowed answers.
4. Fully mocked unit tests. No live calls.

### WS-W1 · Web app  (repo: flaio-app)
Owned: `packages/web-app/src/kanban/**`, `packages/web-app/src/models/kanban/**`, new `packages/web-app/src/runners/**`, route registration lines in `packages/web-app/src/router.ts`.
Build:
1. Ticket detail: event timeline (from `events`), agent session badge (driver, resumed count), current brief view.
2. Needs info / Blocked state badges and filters; questions panel with an Answer box (writes `question_answered` event + the API enqueues `answer_resume`).
3. Decision log entries rendered in the timeline (answer, probability, provider).
4. Runners page: list, online status, concurrency.
5. "Assign to Flaio" toggle on a ticket.
Use existing redux/epics patterns (@blue-functor/remodel). Mock data where server pieces aren't merged.

---

## Stage 2 — Integration (WS-INT, 1 agent, both repos)
Merge order: WS0 → S4, S1 → S2 → S3 → A2 → A1 → W1. Wire stubs to real implementations, resolve integration notes from PRs, and write an end-to-end test (Firestore emulator + fake runner): labelled Jira issue → plan job → runner runs → submit_plan → plan_review → approve → implement job resumes SAME agent session id → complete_phase → PR link → review comment → review_fixes resumes same session. Acceptance: zero fresh agent sessions after the first for a ticket.

## Explicitly out of scope now
Lead/worker decomposition, reviewer and integrator agents, path leases, cloud runners, calibration dashboards (Phase D/E).
