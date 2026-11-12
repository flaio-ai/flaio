# Virtual Developer — Stage 0 Contracts

These are the interfaces every Stage 1 workstream codes against. They are additive: existing tickets, protocol messages and the current kanban flow keep working unchanged. Change them only through a PR that touches both repos.

## Where they live

| Contract | flaio-app (platform) | flaio (CLI) |
|---|---|---|
| Ticket continuity, events, jobs, runners, decisions | `packages/shared/src/agent-loop.ts` | `src/contracts/agent-loop.ts` (mirror — keep identical) |
| New ticket fields | `packages/shared/src/ticket.ts` (`agentSession`, `agentState`, `acceptanceCriteria`, `assignedToAgent`, all optional) | — |
| Protocol messages | `packages/shared/src/protocol.ts` | `src/relay/relay-protocol.ts` + zod in `src/relay/relay-message-schemas.ts` |
| MCP tools + ticket workspace files | — | `src/contracts/mcp-tools.ts` |
| CLI internal seam (MCP server → relay client) | — | `src/contracts/ticket-phase-bus.ts` |

## The loop

1. Something creates a **Job** (`jobs/{jobId}`): the web app, an integration webhook, a PR review, a CI failure, or an answer to a question.
2. The orchestrator picks an online **Runner** (`runners/{runnerId}`) and sends `relay_run_job` with the job, the ticket's `agentSession` (or null on first run) and `briefMarkdown` from the context assembler.
3. The CLI writes the brief to `.flaio/ticket/brief.md`, then **resumes** the ticket's agent session (or starts one) in `job.permissionMode`, with the Flaio MCP server attached. It replies `cli_job_claimed`, and `cli_agent_session` once the agent's real session id is known.
4. The agent works and calls MCP tools: `get_ticket_context`, `submit_plan`, `ask_question`, `record_decision`, `report_progress`. Each becomes a `cli_ticket_event` → appended to `users/{uid}/tickets/{ticketId}/events`.
5. The agent calls `complete_phase` → `cli_phase_complete`. This is the only success path; terminal idle detection may only mark a job `stuck` (`cli_job_failed` with `stuck: true`).
6. The orchestrator's state machine decides the next job or a human gate.

## Messages

CLI → Relay: `cli_runner_register`, `cli_runner_heartbeat`, `cli_job_claimed`, `cli_agent_session`, `cli_ticket_event`, `cli_phase_complete`, `cli_job_failed`.
Relay → CLI: `relay_run_job`, `relay_cancel_job`.
Existing `relay_start_planning` / `relay_start_implementation` / `relay_request_changes` stay supported; WS-A1 maps them onto the job path.

## Job kinds and permission modes

| Job kind | Created by | Permission mode | Resumes session |
|---|---|---|---|
| `plan` | assignment, web "start planning" | `plan` | no (first run) |
| `revise_plan` | plan rejected with feedback | `plan` | yes |
| `implement` | plan approved (human or autonomy gate) | `acceptEdits` | yes |
| `review_fixes` | PR review comments / request changes | `acceptEdits` | yes |
| `ci_fix` | failed check on the ticket branch | `acceptEdits` | yes |
| `answer_resume` | answer to a blocking question | same as the phase that asked | yes |

## Decisions

`DECISIONS` in `agent-loop.ts` lists the eight decision ids and their allowed answers. Providers implement `DecisionProvider`; every call is logged as a `jev_decision` ticket event. Until WS-S4 lands, the orchestrator uses a provider that always escalates to a human, so behaviour matches today.

## Owned paths (Stage 1)

| Workstream | Repo | Owns |
|---|---|---|
| A1 Session continuity | flaio | `src/agents/drivers/**`, `src/agents/agent-session.ts`, `src/relay/ticket-tracker.ts`, `src/relay/worktree-manager.ts`, ticket/job handlers in `src/relay/relay-client.ts` |
| A2 MCP server, workspace, plugin | flaio | `src/mcp/**`, `src/workspace/**`, `plugin/**`, `src/hooks/stop-hook.ts`, `src/hooks/install.ts`, `src/hooks/hook-server.ts` |
| S1 Event log + context assembler | flaio-app | `packages/relay-server/src/ticket-persistence.ts`, `ticket-api.ts`, `cli-handler.ts`, `context/**`, `firestore.rules`, `firestore.indexes.json` |
| S2 Orchestrator + runners | flaio-app | `packages/relay-server/src/orchestrator/**`, `browser-handler.ts`, `connection-manager.ts`, `session-store.ts`, `heartbeat.ts` |
| S3 Inbound integrations | flaio-app | `packages/functions/src/integrations/**`, `packages/functions/src/github/**`, `packages/functions/src/triggers/ticket-sync.ts` |
| S4 Decision layer | flaio-app | `packages/decisions/**` (new workspace package) |
| W1 Web app | flaio-app | `packages/web-app/src/kanban/**`, `packages/web-app/src/models/kanban/**`, `packages/web-app/src/runners/**`, route lines in `router.ts` |

Contract files (`agent-loop.ts`, `protocol.ts`, `relay-protocol.ts`, `relay-message-schemas.ts`, `src/contracts/**`) are owned by nobody in Stage 1. A workstream that needs a contract change describes it under "Integration notes" in its PR; Stage 2 applies it.
