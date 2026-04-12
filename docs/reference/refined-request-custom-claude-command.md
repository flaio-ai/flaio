# Custom Command for Claude Session Initiation

## 1. Title

Configurable Claude CLI Command via Settings Panel

## 2. Summary

Allow users to specify a custom command string for spawning Claude sessions instead of the hardcoded `"claude"` binary. This command is configured through the application's Settings panel (Agents section) and persisted in the flaio configuration file (`~/.config/flaio/settings.json`).

Currently, `ClaudeDriver` has `readonly command = "claude"` hardcoded at the class level. The `resolveCommand()` method in `BaseDriver` runs `which claude` to locate the binary, and all spawn methods (`buildSpawnArgs`, `buildResumeArgs`, `buildContinueArgs`) use `this.resolveCommand()`. This change allows the user to override the command with custom aliases such as `claude-vertex`, `claude-aws`, or any wrapper script that routes Claude API calls through an external provider.

## 3. Background

The Claude Code CLI supports external API providers (e.g., Amazon Bedrock, Google Vertex AI) via wrapper commands or aliased binaries. Users who set up these providers typically create shell aliases or symlinks like `claude-vertex` or `claude-aws` that configure the appropriate environment variables and proxy settings before invoking Claude.

Flaio currently hardcodes `"claude"` as the spawn command in `ClaudeDriver` (line 7 of `src/agents/drivers/claude-driver.ts`). There is no mechanism in the configuration schema (`AppConfig`), defaults, or settings UI to override this. Users who need external providers must either rename their custom binary to `claude` (losing the ability to switch between providers) or modify source code directly.

The same pattern applies to `GeminiDriver` with its hardcoded `"gemini"` command, but this request focuses specifically on Claude. The design should be extensible to Gemini in the future.

## 4. Requirements

1. **Config schema extension**: Add an optional `customCommand` field (type `string`) to the `agents` section of `AppConfig` scoped per driver. The structure should be `agents.claude.customCommand` (and symmetrically `agents.gemini.customCommand` for future use).

2. **No default/fallback value**: Per project conventions, if `customCommand` is not provided, the system must use the original hardcoded command (`"claude"`). This is not a fallback -- it is the base behavior when no override exists. The `customCommand` field is optional; when present, it replaces the default command entirely.

3. **Driver integration**: `ClaudeDriver` must accept an optional custom command at construction time or via a setter. When a custom command is provided, `resolveCommand()` must resolve the custom command path instead of `"claude"`. The `checkInstalled()` method must also validate the custom command.

4. **Settings UI**: The Agents section of the Settings panel must display a text input field labeled "Custom Command" when the Claude Code sub-tab is selected. The field must show the current custom command value (or empty if not set). The user must be able to edit and save it via the existing field editing mechanism.

5. **Persistence**: The custom command value must be persisted in `~/.config/flaio/settings.json` under the agents configuration and survive application restarts.

6. **Validation**: When the user sets a custom command via the Settings panel, the application should verify the command exists on the system PATH (via `which` or equivalent). If the command is not found, show a warning but still allow saving (the user may install the command later).

7. **New session dialog**: The new session dialog should use the configured custom command when spawning Claude sessions. No additional UI changes are needed in the dialog itself -- it should transparently use whatever command the driver resolves.

8. **Session resume and continue**: Resume (`--resume`) and continue (`--continue`) operations must also use the custom command, since `buildResumeArgs` and `buildContinueArgs` both call `resolveCommand()`.

## 5. Acceptance Criteria

1. A user can open Settings > Agents > Claude Code and see a "Custom Command" text field.
2. Setting the custom command to `claude-vertex` and saving causes all new Claude sessions to spawn using `claude-vertex` instead of `claude`.
3. Clearing the custom command field reverts to the default `claude` binary.
4. The custom command is persisted in `~/.config/flaio/settings.json` and is loaded correctly on application restart.
5. Resume and continue operations use the custom command.
6. If the custom command binary does not exist on PATH, the settings panel shows a warning message but still saves the value.
7. The `checkInstalled()` method reports correctly for the custom command (returns `false` if the custom command is not found).
8. The configuration schema validates correctly with and without the `customCommand` field (backward compatible).

## 6. Scope

### In Scope

- Adding `customCommand` to the config schema for Claude (and the symmetric field for Gemini, even if the Gemini UI is not wired up yet)
- Modifying `ClaudeDriver` to accept and use a custom command
- Modifying `BaseDriver.resolveCommand()` or adding an override mechanism
- Adding a "Custom Command" field to the Agents > Claude Code sub-tab in the Settings panel
- Persisting and loading the setting via the existing config infrastructure
- Validation feedback in the Settings panel

### Out of Scope

- Gemini custom command UI (the schema field can be added but the UI wiring is deferred)
- Environment variable overrides for the command (only config file)
- Custom arguments or flags beyond the command name (e.g., no custom `--provider` flags)
- Modifications to the new-session dialog UI
- Auto-detection of available provider aliases

## 7. Constraints

1. **Project convention -- no fallback defaults**: The `customCommand` field must be optional in the Zod schema. When absent, the driver uses its hardcoded command. This is the base behavior, not a fallback. If the user explicitly sets a custom command and that command is missing from the system, the spawn must fail with a clear error rather than silently falling back to `"claude"`.

2. **TypeScript only**: All changes must be in TypeScript, consistent with the existing codebase.

3. **Zod schema validation**: The config schema change must use Zod and be backward compatible (existing config files without the new field must parse successfully).

4. **Ink/React TUI**: UI changes must use the existing Ink component patterns (TextInput, useInput, FieldDef pattern in settings-panel or the AgentsSettingsContent component pattern).

5. **Driver architecture**: The `BaseDriver` abstract class defines the `command` property as `abstract readonly`. Any override mechanism must respect this contract. Options include: making `command` a getter that checks a mutable backing field, or passing the override via the constructor.

6. **Minimal diff in agent-session.ts**: The `AgentSession` class should not need changes -- it already delegates to `driver.buildSpawnArgs()` which calls `resolveCommand()`. The change should be contained within the driver and config layers.

7. **Config file location**: `~/.config/flaio/settings.json` -- no new files or directories.
