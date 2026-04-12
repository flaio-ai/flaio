# Flaio -- Functional Requirements and Feature Descriptions

## FR-001: Configurable Custom Command for Agent Sessions

**Status**: Planned  
**Plan**: [plan-001-custom-claude-command.md](./plan-001-custom-claude-command.md)

### Description

Allow users to specify a custom command string for spawning Claude (and in the future, Gemini) sessions instead of the hardcoded binary name. The custom command is configured through the application's Settings panel (Agents section) and persisted in `~/.config/flaio/settings.json`.

### Requirements

1. **Config schema extension**: Add an optional `customCommand` field (type `string`) to the `agents` section of `AppConfig` scoped per driver. The structure is `agents.claude.customCommand` (and symmetrically `agents.gemini.customCommand` for future use).

2. **No default/fallback value**: If `customCommand` is not provided, the system uses the original hardcoded command (`"claude"`). This is the base behavior when no override exists. If the user explicitly sets a custom command and that command is missing from the system, the spawn must fail with a clear error rather than silently falling back to `"claude"`.

3. **Driver integration**: `ClaudeDriver` must accept an optional custom command via a setter. When a custom command is provided, `resolveCommand()` resolves the custom command path instead of `"claude"`. The `checkInstalled()` method must also validate the custom command.

4. **Settings UI**: The Agents section of the Settings panel must display a "Custom Command" text field when a driver sub-tab is selected. The field shows the current custom command value (or empty if not set). The user edits it by pressing `c` to enter edit mode, types the command, and presses Enter to save or Escape to cancel.

5. **Persistence**: The custom command value is persisted in `~/.config/flaio/settings.json` under the agents configuration and survives application restarts.

6. **Validation**: When the user sets a custom command, the application verifies the command exists on the system PATH (via `which`). If the command is not found, a warning is shown but saving is still allowed (the user may install the command later).

7. **New session dialog**: The new session dialog uses the configured custom command when spawning sessions. No additional UI changes are needed in the dialog itself.

8. **Session resume and continue**: Resume (`--resume`) and continue (`--continue`) operations also use the custom command.

### Acceptance Criteria

1. A user can open Settings > Agents > Claude Code and see a "Custom Command" section.
2. Setting the custom command to `claude-vertex` and saving causes all new Claude sessions to spawn using `claude-vertex`.
3. Clearing the custom command field reverts to the default `claude` binary.
4. The custom command is persisted in `settings.json` and loaded correctly on restart.
5. Resume and continue operations use the custom command.
6. If the custom command binary does not exist on PATH, the settings panel shows a warning but still saves.
7. The `checkInstalled()` method reports correctly for the custom command.
8. The configuration schema validates correctly with and without the `customCommand` field (backward compatible).

### Scope

**In scope**: Config schema for Claude and Gemini, `ClaudeDriver` override, `GeminiDriver` symmetric override (UI deferred for Gemini), Settings UI for Claude, persistence via existing config infrastructure, validation feedback.

**Out of scope**: Gemini custom command UI wiring, environment variable overrides, custom arguments/flags beyond the command name, modifications to the new-session dialog UI, auto-detection of provider aliases.
