# Plan 001 -- Configurable Custom Command for Claude (and Gemini) Sessions

## Overview

Allow users to specify a custom command string (e.g. `claude-vertex`, `claude-aws`) for spawning Claude sessions, configured through the Settings panel and persisted in `~/.config/flaio/settings.json`.

**Files modified**: 7 (0 new files)

| File | Layer |
|------|-------|
| `src/config/config.ts` | Zod schema |
| `src/store/settings-store.ts` | Zustand store |
| `src/agents/drivers/claude-driver.ts` | Driver |
| `src/agents/drivers/gemini-driver.ts` | Driver (symmetric, UI deferred) |
| `src/agents/agent-registry.ts` | Config-to-driver bridge |
| `src/app.tsx` | Initialization |
| `src/ui/components/agents-settings-content.tsx` | Settings UI |

---

## Phase 1 -- Zod Schema Extension

**File**: `src/config/config.ts`

**Depends on**: Nothing

**Can be parallelized with**: Phase 2 (driver changes)

### Changes

1. Add two new Zod sub-schemas after line 66 (after `ConnectorsSchema`), before `AgentsSchema`:

```typescript
const ClaudeAgentConfigSchema = z.object({
  customCommand: z.string().optional(),
});

const GeminiAgentConfigSchema = z.object({
  customCommand: z.string().optional(),
});
```

2. Modify `AgentsSchema` (currently lines 68-71) to include the new sub-objects:

```typescript
const AgentsSchema = z.object({
  statusCheckInterval: z.number().default(DEFAULTS.agents.statusCheckInterval),
  detectorInterval: z.number().default(DEFAULTS.agents.detectorInterval),
  claude: ClaudeAgentConfigSchema.default(() => ClaudeAgentConfigSchema.parse({})),
  gemini: GeminiAgentConfigSchema.default(() => GeminiAgentConfigSchema.parse({})),
});
```

3. Add type exports after line 87:

```typescript
export type ClaudeAgentConfig = z.infer<typeof ClaudeAgentConfigSchema>;
export type GeminiAgentConfig = z.infer<typeof GeminiAgentConfigSchema>;
```

### Acceptance Criteria

- Existing `settings.json` files without `claude`/`gemini` keys parse successfully (backward compatible).
- `AppConfig["agents"]["claude"]` is typed as `{ customCommand?: string }`.
- `AppConfig["agents"]["gemini"]` is typed as `{ customCommand?: string }`.
- Setting `agents.claude.customCommand` to a string in the JSON and loading it returns the value.
- Omitting `agents.claude` entirely returns `{ customCommand: undefined }` after parse.

### Verification

```bash
npx tsc --noEmit
```

---

## Phase 2 -- Driver Override (ClaudeDriver and GeminiDriver)

**Files**: `src/agents/drivers/claude-driver.ts`, `src/agents/drivers/gemini-driver.ts`

**Depends on**: Nothing

**Can be parallelized with**: Phase 1 (schema changes)

### Changes to `claude-driver.ts`

1. Add private field, setter, and getter after the `readonly command = "claude"` line (line 7):

```typescript
private _customCommand?: string;

/**
 * Set a custom command to use instead of the default "claude" binary.
 * Pass undefined to revert to the default.
 */
setCustomCommand(cmd: string | undefined): void {
  this._customCommand = cmd?.trim() || undefined;
}

/** Returns the custom command if set, otherwise the default command. */
get effectiveCommand(): string {
  return this._customCommand ?? this.command;
}
```

2. Override `resolveCommand()` (add after `effectiveCommand`):

```typescript
override resolveCommand(): string {
  const cmd = this.effectiveCommand;
  try {
    return execSync(`which ${cmd}`, { encoding: "utf-8" }).trim();
  } catch {
    return cmd;
  }
}
```

3. Replace `checkInstalled()` (currently lines 9-16) to use `effectiveCommand`:

```typescript
async checkInstalled(): Promise<boolean> {
  try {
    execSync(`which ${this.effectiveCommand}`, { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}
```

**No changes needed** in `buildSpawnArgs`, `buildResumeArgs`, `buildContinueArgs` -- they already call `this.resolveCommand()` which now uses `effectiveCommand`.

### Changes to `gemini-driver.ts` (symmetric, for future use)

Apply the identical pattern:

1. Add `_customCommand?: string` field, `setCustomCommand()` setter, `effectiveCommand` getter.
2. Override `resolveCommand()` to use `effectiveCommand`.
3. Update `checkInstalled()` to use `this.effectiveCommand` instead of hardcoded `"gemini"`.

### Acceptance Criteria

- `new ClaudeDriver()` with no custom command: `resolveCommand()` resolves `"claude"` (same as before).
- After `setCustomCommand("claude-vertex")`: `resolveCommand()` resolves `"claude-vertex"`, `effectiveCommand` returns `"claude-vertex"`, `checkInstalled()` checks for `"claude-vertex"`.
- After `setCustomCommand(undefined)`: reverts to `"claude"`.
- After `setCustomCommand("  ")`: treated as undefined (empty/whitespace trimmed).
- `driver.command` still returns `"claude"` (readonly, unchanged).
- Same for GeminiDriver with `"gemini"`.

### Verification

```bash
npx tsc --noEmit
```

---

## Phase 3 -- Settings Store Method

**File**: `src/store/settings-store.ts`

**Depends on**: Phase 1 (needs the updated `AppConfig` type with `agents.claude` and `agents.gemini`)

**Can be parallelized with**: Phase 2 (driver changes don't depend on store)

### Changes

1. Add `updateAgentDriver` to the `SettingsState` interface (after line 16, before closing brace):

```typescript
updateAgentDriver: (
  driverName: "claude" | "gemini",
  patch: Record<string, unknown>,
) => void;
```

2. Add the implementation in the store creation (after `updateRelay`, before the closing `}))` on line 80):

```typescript
updateAgentDriver: (driverName, patch) => {
  set((prev) => ({
    config: {
      ...prev.config,
      agents: {
        ...prev.config.agents,
        [driverName]: {
          ...prev.config.agents[driverName],
          ...patch,
        },
      },
    },
  }));
  get().save();
},
```

### Acceptance Criteria

- `settingsStore.getState().updateAgentDriver("claude", { customCommand: "claude-vertex" })` updates `config.agents.claude.customCommand` to `"claude-vertex"` and persists to disk.
- `settingsStore.getState().updateAgentDriver("claude", { customCommand: undefined })` clears the custom command.
- Other `agents` fields (`statusCheckInterval`, `detectorInterval`) are preserved.
- The `claude` and `gemini` sub-objects are independently updatable.

### Verification

```bash
npx tsc --noEmit
```

---

## Phase 4 -- Config-to-Driver Bridge

**Files**: `src/agents/agent-registry.ts`, `src/app.tsx`

**Depends on**: Phase 1, Phase 2, Phase 3 (needs schema, driver setter, and store)

### Changes to `agent-registry.ts`

1. Add imports at the top:

```typescript
import { settingsStore } from "../store/settings-store.js";
import type { ClaudeDriver } from "./drivers/claude-driver.js";
import type { GeminiDriver } from "./drivers/gemini-driver.js";
```

2. Add `initDriverConfigs()` function after `getInstalledDrivers()` (after line 27):

```typescript
/**
 * Syncs driver custom commands from the settings store.
 * Call once after settingsStore.load(). Subscribes to future changes
 * so that drivers pick up config changes from the Settings UI.
 */
export function initDriverConfigs(): void {
  const syncCustomCommands = (): void => {
    const { agents } = settingsStore.getState().config;

    const claude = getDriver("claude") as ClaudeDriver | undefined;
    if (claude) {
      claude.setCustomCommand(agents.claude?.customCommand);
    }

    const gemini = getDriver("gemini") as GeminiDriver | undefined;
    if (gemini) {
      gemini.setCustomCommand(agents.gemini?.customCommand);
    }
  };

  // Sync on initial call
  syncCustomCommands();

  // Re-sync whenever settings change
  settingsStore.subscribe(syncCustomCommands);
}
```

### Changes to `app.tsx`

1. Add import at the top (after existing agent-related imports, around line 13):

```typescript
import { initDriverConfigs } from "./agents/agent-registry.js";
```

2. Add `initDriverConfigs()` call inside the existing `useEffect` that calls `settingsStore.getState().load()` (lines 36-38). Change:

```typescript
useEffect(() => {
  settingsStore.getState().load();
}, []);
```

to:

```typescript
useEffect(() => {
  settingsStore.getState().load();
  initDriverConfigs();
}, []);
```

### Changes to `src/cli.tsx`

The file has three additional sites where `settingsStore.getState().load()` is called (lines 172-173, 199-200, 274-275). These are for CLI subcommands (non-TUI paths). Add `initDriverConfigs()` after each `load()` call, and add the import at the top of the file.

### Acceptance Criteria

- After `settingsStore.getState().load()` completes, the `ClaudeDriver` instance in the registry has its `_customCommand` set to whatever is in the config.
- When the user changes the custom command via the Settings UI (which calls `updateAgentDriver`), the Zustand subscription fires and the driver's `_customCommand` is updated automatically.
- New sessions spawned after a config change use the new custom command.
- Existing running sessions are unaffected.

### Verification

```bash
npx tsc --noEmit
```

---

## Phase 5 -- Settings UI

**File**: `src/ui/components/agents-settings-content.tsx`

**Depends on**: Phase 1, Phase 3 (needs the updated config type and `updateAgentDriver`)

### Changes

1. Add imports at the top:

```typescript
import { TextInput } from "@inkjs/ui";
import { settingsStore } from "../../store/settings-store.js";
import { execSync } from "node:child_process";
```

2. Add state variables inside `AgentsSettingsContent` (after line 88, after existing `useState` calls):

```typescript
const [editingCustomCommand, setEditingCustomCommand] = useState(false);
const [customCommandDraft, setCustomCommandDraft] = useState("");
const [customCommandWarning, setCustomCommandWarning] = useState<string | null>(null);
```

3. Add a helper to read the current custom command value for the active sub-tab. Add after the state declarations:

```typescript
const getCustomCommand = useCallback((): string | undefined => {
  const { agents } = settingsStore.getState().config;
  const driverName = AGENT_DEFS[subTab]!.driverName;
  return agents[driverName]?.customCommand;
}, [subTab]);
```

4. Modify the `useInput` handler (currently lines 253-275). The `editingCustomCommand` early-return must be the **first** check to prevent key capture conflicts:

```typescript
useInput((input, key) => {
  if (!isActive) return;

  // When editing custom command, only handle Escape to cancel.
  // All other keystrokes go to the TextInput component.
  if (editingCustomCommand) {
    if (key.escape) {
      setEditingCustomCommand(false);
      setCustomCommandWarning(null);
    }
    return;
  }

  if (key.leftArrow) {
    setSubTab((t) => (t > 0 ? t - 1 : AGENT_DEFS.length - 1));
    return;
  }
  if (key.rightArrow) {
    setSubTab((t) => (t < AGENT_DEFS.length - 1 ? t + 1 : 0));
    return;
  }
  if (input === "m") {
    toggleMethod(subTab);
    return;
  }
  if (input === "h") {
    handleSetupHooks();
    return;
  }
  if (input === "c") {
    const current = getCustomCommand() ?? "";
    setCustomCommandDraft(current);
    setCustomCommandWarning(null);
    setEditingCustomCommand(true);
    return;
  }
  if (key.return) {
    handleAction(subTab);
  }
});
```

5. Add a submit handler for the TextInput (after `handleSetupHooks`, around line 175):

```typescript
const handleCustomCommandSubmit = useCallback((value: string) => {
  const trimmed = value.trim();
  const driverName = AGENT_DEFS[subTab]!.driverName as "claude" | "gemini";

  if (trimmed === "") {
    // Clear custom command
    settingsStore.getState().updateAgentDriver(driverName, { customCommand: undefined });
    setCustomCommandWarning(null);
  } else {
    // Validate command exists on PATH
    try {
      execSync(`which ${trimmed}`, { stdio: "ignore" });
      setCustomCommandWarning(null);
    } catch {
      setCustomCommandWarning(`Command "${trimmed}" not found on PATH`);
    }
    settingsStore.getState().updateAgentDriver(driverName, { customCommand: trimmed });
  }

  setEditingCustomCommand(false);
}, [subTab]);
```

6. Add the custom command UI section in the JSX. Insert a new block **after** the Sideband Hooks section (after line 377, before the closing `</Box>` of the agent info card):

```tsx
{/* Custom command */}
<Box marginTop={1} flexDirection="column">
  <Text dimColor>--- Custom Command ---</Text>
  {editingCustomCommand ? (
    <Box>
      <Text>Command:    </Text>
      <TextInput
        defaultValue={customCommandDraft}
        onSubmit={handleCustomCommandSubmit}
        placeholder={AGENT_DEFS[subTab]!.command}
      />
      <Text dimColor>  (Enter to save, Esc to cancel)</Text>
    </Box>
  ) : (
    <Text>
      Command:    <Text color={getCustomCommand() ? "cyan" : "gray"} bold={!!getCustomCommand()}>
        {getCustomCommand() ?? AGENT_DEFS[subTab]!.command}
      </Text>
      {!getCustomCommand() && <Text dimColor> (default)</Text>}
      <Text dimColor>  (c to edit)</Text>
    </Text>
  )}
  {customCommandWarning && (
    <Text color="yellow">  {customCommandWarning}</Text>
  )}
</Box>
```

### Acceptance Criteria

- When the Claude Code sub-tab is selected, a "Custom Command" section is visible below Sideband Hooks.
- If no custom command is configured, it shows `claude (default) (c to edit)`.
- If a custom command is set (e.g. `claude-vertex`), it shows `claude-vertex (c to edit)` in cyan.
- Pressing `c` opens a TextInput pre-filled with the current custom command (or empty).
- Typing a command and pressing Enter saves it and exits edit mode.
- Pressing Escape cancels editing without saving.
- If the entered command is not found on PATH, a yellow warning appears: `Command "xxx" not found on PATH`.
- The warning does NOT prevent saving.
- Clearing the field (submitting empty) removes the custom command and reverts to default.
- While editing, other key bindings (m, h, Enter, arrows) are suppressed.
- The same UI works on the Gemini CLI sub-tab (reads/writes `agents.gemini.customCommand`).

### Verification

```bash
npx tsc --noEmit
npm test
```

Manual verification:
1. Start flaio, open Settings (Ctrl+,), navigate to Agents tab.
2. Verify "Custom Command" section appears with `claude (default)`.
3. Press `c`, type `claude-vertex`, press Enter.
4. Verify warning appears if `claude-vertex` is not installed.
5. Verify `~/.config/flaio/settings.json` contains `"agents": { ... "claude": { "customCommand": "claude-vertex" } }`.
6. Restart flaio, verify the custom command is loaded.
7. Create a new Claude session, verify it spawns with `claude-vertex`.
8. Go back to Settings, press `c`, clear the field, press Enter. Verify it reverts to `claude (default)`.

---

## Phase 6 -- Integration Testing and Cleanup

**Depends on**: All previous phases

### Steps

1. **Full build**:
   ```bash
   npx tsc --noEmit
   npm run build
   ```

2. **Unit tests**:
   ```bash
   npm test
   ```

3. **Manual E2E test** (see Phase 5 manual verification steps).

4. **Backward compatibility test**: Remove `agents.claude` and `agents.gemini` from `settings.json`, restart flaio, verify no errors.

5. **Edge cases**:
   - Set custom command to a path with no spaces (e.g. `/usr/local/bin/claude-vertex`) -- verify it works.
   - Set custom command to whitespace-only -- verify it is treated as "clear" (reverts to default).
   - Set custom command, spawn a session, change the command in settings -- verify the running session is unaffected but new sessions use the new command.

---

## Dependency Graph

```
Phase 1 (Schema)  ----+----> Phase 3 (Store) ----+
                       |                           |
Phase 2 (Drivers) ----+----> Phase 4 (Bridge) <---+
                       |                           |
                       +----> Phase 5 (UI) <-------+
                                                   |
                              Phase 6 (Test) <-----+
```

- **Phases 1 and 2** can be done in parallel (no dependency between them).
- **Phase 3** depends on Phase 1 (needs the updated `AppConfig` type).
- **Phase 4** depends on Phases 1, 2, and 3 (needs all three layers).
- **Phase 5** depends on Phases 1 and 3 (needs config type and store method). It does NOT depend on Phase 2 or 4 for compilation, but for runtime correctness it needs Phase 4.
- **Phase 6** depends on all.

## Parallelization Summary

| Batch | Phases | Files |
|-------|--------|-------|
| Batch 1 | Phase 1 + Phase 2 | `config.ts`, `claude-driver.ts`, `gemini-driver.ts` |
| Batch 2 | Phase 3 | `settings-store.ts` |
| Batch 3 | Phase 4 + Phase 5 | `agent-registry.ts`, `app.tsx`, `cli.tsx`, `agents-settings-content.tsx` |
| Batch 4 | Phase 6 | (testing only) |

## Risk Mitigations

1. **TextInput focus conflict**: The `editingCustomCommand` early-return in `useInput` MUST be the first check after `if (!isActive) return;`. This prevents `m`, `h`, Enter, and arrow keys from triggering while typing.

2. **Backward compatibility**: The `.default(() => Schema.parse({}))` pattern on `claude` and `gemini` sub-objects ensures existing config files parse without error.

3. **No silent fallback**: If the user sets `customCommand: "claude-vertex"` and that binary does not exist, the session spawn will fail with a PTY error. The Settings UI shows a warning proactively. The driver does NOT fall back to `"claude"` -- this is by design per the project's no-fallback convention.

4. **Race condition**: Changing the custom command in Settings while a session is spawning is safe. `resolveCommand()` is synchronous and reads `_customCommand` atomically. The worst case is the session uses either the old or new value, both valid.
