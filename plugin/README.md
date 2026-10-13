# Flaio plugin for Claude Code

Lets Claude Code work on Flaio tickets through tools instead of Flaio scraping the terminal.

## What's in it

| Component | What it does |
|---|---|
| MCP server `flaio` (`.mcp.json`) | Runs `flaio mcp --ticket ${FLAIO_TICKET_ID}`. Tools: `get_ticket_context`, `submit_plan`, `ask_question`, `record_decision`, `report_progress`, `complete_phase`. |
| `/flaio:ticket <id>` | Loads a ticket's brief, plan, decisions, progress and open questions into the session. |
| `/flaio:handoff` | Appends a handoff note to `.flaio/ticket/progress.md`. |
| Stop hook | In a Flaio ticket session (`FLAIO_TICKET_ID` set), blocks the first stop of a phase if `progress.md` wasn't updated, and asks Claude to write the handoff note. It never blocks twice in a row and does nothing outside ticket sessions. |

## Requirements

- The Flaio CLI on `PATH`, which provides `flaio` and `flaio-stop-hook`: `npm i -g flaio-cli`.
- For `/flaio:ticket` to fetch tickets that have no local workspace yet, run `flaio login`.

## Install

```bash
# Try it from a checkout
claude --plugin-dir ./plugin

# Check the manifest
claude plugin validate ./plugin
```

## How it connects

- **Sessions Flaio starts** set `FLAIO_TICKET_ID`, `FLAIO_JOB_ID`, `FLAIO_TICKET_WORKTREE`, `FLAIO_MCP_TOKEN` and `FLAIO_HOOK_SOCKET` in the agent's environment. The MCP server forwards each tool call to the running Flaio CLI over its local socket, authenticated by the per-session token. The CLI writes the ticket workspace and reports the event to Flaio.
- **Manual sessions** have no token or CLI connection, so the tools only read and write the ticket workspace in `.flaio/ticket/`. The ticket comes from `--ticket`, then `FLAIO_TICKET_ID`, then `.flaio/ticket/state.json`.

## Ticket workspace

All files live in `.flaio/ticket/` in the ticket worktree, and `.flaio/` is added to `.git/info/exclude`, so none of them are committed:

| File | Contents |
|---|---|
| `brief.md` | Context Flaio assembled for the current job |
| `plan.md` | The latest submitted plan |
| `decisions.md` | Decision log, append-only |
| `progress.md` | Progress entries and handoff notes, append-only |
| `questions.md` | Questions and their answers |
| `state.json` | Internal ticket, job and phase bookkeeping |
