---
description: Load a Flaio ticket's context (brief, plan, decisions, progress and open questions) into this session so you can work on or resume it.
argument-hint: <ticket-id>
disable-model-invocation: true
---

Load Flaio ticket `$ARGUMENTS` into this session.

1. Call the `get_ticket_context` tool from the `flaio` MCP server.
   - If it succeeds and `ticketId` is `$ARGUMENTS`, use that context.
   - If the tool is unavailable, errors with "No Flaio ticket is bound", or returns a different ticket, continue with step 2.
2. Look for the ticket workspace in the current repository: `.flaio/ticket/brief.md`, `plan.md`, `decisions.md`, `progress.md`, `questions.md` and `state.json`. Read the files that exist. If `state.json` names a different `ticketId`, treat the workspace as belonging to another ticket and don't use it.
3. If there's no usable workspace, run `flaio tickets get $ARGUMENTS --json` with the Bash tool to fetch the ticket (requires `flaio login`). Then create the workspace so the Flaio tools work in this session:
   - write the ticket title, description, acceptance criteria and any plan to `.flaio/ticket/brief.md`;
   - write `{"ticketId": "<the ticket id>"}` to `.flaio/ticket/state.json`;
   - make sure `.flaio/` is listed in the repository's `.git/info/exclude` (for a linked worktree, use `git rev-parse --git-common-dir` to find it), so the workspace is never committed.
4. Summarize for the user in a few lines: what the ticket asks for, the current plan (if any), the last handoff note in `progress.md` (if any), and open questions. Then ask how they want to proceed. Don't start changing code yet.

While working on the ticket, use the Flaio tools: `submit_plan` for plans, `ask_question` when blocked on a human, `record_decision` for notable choices, `report_progress` per step, and `complete_phase` to finish. Before ending the session, run `/flaio:handoff`.
