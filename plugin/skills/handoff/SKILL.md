---
description: Write the Flaio handoff note for the current ticket to .flaio/ticket/progress.md so the next session (agent or human) can resume where this one stopped.
disable-model-invocation: true
---

Write the handoff note for the current Flaio ticket.

1. Find the ticket workspace: `.flaio/ticket/` in the ticket worktree (`$FLAIO_TICKET_WORKTREE` if set, otherwise the current repository root). If it doesn't exist, tell the user to run `/flaio:ticket <id>` first and stop.
2. Gather the facts: run `git status --short` and `git log --oneline -10`, and review what you did in this session.
3. Append a new section to the end of `.flaio/ticket/progress.md`. Create the file with a `# Progress` heading if it's missing, and never rewrite earlier entries. Use this shape:

   ```markdown
   ## Handoff — <ISO timestamp>

   **Done this session:** <what changed and why, with key files>
   **State of the branch:** <what works, what's unfinished, failing tests, uncommitted changes>
   **Tried and abandoned:** <approaches that didn't work, and why>
   **Next steps:** <ordered, concrete steps for whoever resumes>
   **Open questions:** <anything that needs a human, or "none">
   ```

4. If the phase's work is finished, also call the `complete_phase` tool from the `flaio` MCP server with a matching summary and the tests you ran. If you're blocked on a human, call `ask_question` first, then `complete_phase` with result `needs_info`.
5. Tell the user in one line that the handoff was written.
