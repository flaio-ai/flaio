# Investigation: Custom Claude Command Implementation

## 1. Approach Recommendation — Driver Command Override

### Options Evaluated

**Option A: Override `resolveCommand()` in ClaudeDriver with a mutable backing field**

Add a private `_customCommand?: string` field and a `setCustomCommand()` method to `ClaudeDriver`. Override `resolveCommand()` to resolve `_customCommand` when set, otherwise delegate to `super.resolveCommand()`. The `checkInstalled()` method would also use the custom command.

- Pros: Keeps `BaseDriver` unchanged; change is scoped to `ClaudeDriver`; `command` remains `readonly "claude"` as declared.
- Cons: Each driver subclass that wants the feature must duplicate the override logic; `checkInstalled()` must also be updated manually in each driver.

**Option B: Make `command` a getter in BaseDriver backed by a mutable field**

Change `abstract readonly command: string` to a getter pattern with a protected mutable backing field. All subclasses set the backing field in their constructor.

- Pros: Centralized logic in `BaseDriver`; all drivers automatically gain the capability.
- Cons: Breaks the existing contract (`abstract readonly command` becomes something different); every subclass constructor must change; `resolveCommand()` already uses `this.command`, so there is implicit coupling; higher risk of unintended side effects.

**Option C: Have `resolveCommand()` read from settings store directly**

Override `resolveCommand()` in `ClaudeDriver` to import and read `settingsStore.getState().config.agents.claude?.customCommand` at call time.

- Pros: Zero ceremony -- no setter, no propagation logic, always reads the latest value; works immediately after config is saved.
- Cons: Creates a tight coupling between the driver layer and the Zustand store; makes drivers harder to test in isolation; breaks separation of concerns; the driver module would import from `../../store/settings-store.js`.

### Recommendation: Option A (Override in ClaudeDriver)

Option A is the best choice. Justification:

1. **Minimal surface area**: Only `ClaudeDriver` changes. `BaseDriver` keeps its clean abstract contract. The `readonly command = "claude"` field remains untouched and continues to serve as the default/base command identifier.

2. **No architectural coupling**: The driver does not know about the settings store. It receives the custom command via a setter, maintaining the existing separation between driver, config, and store layers.

3. **Testability**: A test can instantiate `ClaudeDriver`, call `setCustomCommand("claude-vertex")`, and verify that `resolveCommand()` and `checkInstalled()` use the custom command -- no store mocking needed.

4. **Extensibility**: When Gemini needs the same feature, the same pattern (private field + setter + override) is applied to `GeminiDriver`. If a third driver appears, the pattern is obvious. If more than two drivers need it, the common logic can be extracted into `BaseDriver` at that point (YAGNI until then).

5. **Backward compatible**: The `command` property still returns `"claude"`. Code that reads `driver.command` for display or identification purposes is unaffected. Only `resolveCommand()` and `checkInstalled()` change behavior.

### Concrete Implementation Sketch

```typescript
// claude-driver.ts
export class ClaudeDriver extends BaseDriver {
  readonly name = "claude";
  readonly displayName = "Claude Code";
  readonly command = "claude";

  private _customCommand?: string;

  setCustomCommand(cmd: string | undefined): void {
    this._customCommand = cmd?.trim() || undefined;
  }

  get effectiveCommand(): string {
    return this._customCommand ?? this.command;
  }

  resolveCommand(): string {
    const cmd = this.effectiveCommand;
    try {
      return execSync(`which ${cmd}`, { encoding: "utf-8" }).trim();
    } catch {
      return cmd;
    }
  }

  async checkInstalled(): Promise<boolean> {
    try {
      execSync(`which ${this.effectiveCommand}`, { stdio: "ignore" });
      return true;
    } catch {
      return false;
    }
  }
  // buildSpawnArgs, buildResumeArgs, buildContinueArgs unchanged -- they call this.resolveCommand()
}
```

---

## 2. Config-to-Driver Bridge

### Options Evaluated

**Option X: Direct setter on driver called from settings store**

After `settingsStore.load()` and on each config change, code calls `getDriver("claude")?.setCustomCommand(config.agents.claude?.customCommand)`. This can be done in the settings store's `load()` method, in a Zustand `subscribe()` callback, or at the initialization site in `app.tsx`.

- Pros: Explicit, easy to trace, no hidden dependencies.
- Cons: Requires adding propagation code at initialization points; must remember to call it both on initial load and on subsequent changes.

**Option Y: Driver reads from store lazily in resolveCommand()**

This is Option C from Section 1, evaluated here as a bridge pattern. The driver imports the store and reads the current value each time `resolveCommand()` is called.

- Pros: No propagation logic needed; always consistent.
- Cons: Tight coupling; testability issues; circular dependency risk (driver -> store -> config, and store may eventually reference drivers).

**Option Z: Registry mediator pattern**

Add an `updateDriverConfig()` function to `agent-registry.ts` that accepts a driver name and config patch. The settings store calls this function instead of reaching into the driver directly.

- Pros: Clean mediation layer; registry already owns the driver map.
- Cons: Adds an extra level of indirection for a simple setter call; registry becomes responsible for config propagation, which is not its current concern.

### Recommendation: Option X with a Zustand subscribe() bridge

Option X is the cleanest, with one enhancement: use a `settingsStore.subscribe()` listener to keep the driver in sync automatically. This avoids scattering manual calls across multiple initialization sites.

### Concrete Implementation

In `agent-registry.ts`, add a single initialization function:

```typescript
import { settingsStore } from "../store/settings-store.js";

export function initDriverConfigs(): void {
  const syncCustomCommands = () => {
    const config = settingsStore.getState().config;
    const claude = getDriver("claude") as ClaudeDriver | undefined;
    claude?.setCustomCommand((config.agents as any).claude?.customCommand);
    // Future: same for gemini
  };

  // Sync on initial call
  syncCustomCommands();

  // Sync on every settings change
  settingsStore.subscribe(syncCustomCommands);
}
```

Then call `initDriverConfigs()` once in `app.tsx` after `settingsStore.getState().load()` (line 37). This is a single call site, and the subscribe ensures any subsequent changes (from the Settings UI) propagate automatically.

The subscribe approach also handles the case where the user changes the custom command while sessions are already running -- new sessions will pick up the new command, while existing sessions continue with whatever command they were spawned with (which is correct behavior).

---

## 3. UI Integration Pattern

### Current State of AgentsSettingsContent

The component currently has:
- Sub-tabs for Claude Code / Gemini CLI (left/right arrows to switch)
- An info card with: install method (`m` to toggle), version info, install/update button (Enter)
- Sideband hooks status (`h` to setup)
- No text input fields -- all interactions are single-key actions

### Options Evaluated

**Option P: Press 'c' to enter edit mode (recommended in scan)**

When the user presses `c`, a `TextInput` component appears for the custom command field. The user types the command and presses Enter to save, or Escape to cancel. This follows the pattern of dedicated single-key actions (`m` for method, `h` for hooks).

- Pros: Consistent with the existing interaction model; no navigation complexity; quick to implement.
- Cons: Adds another single-key binding to remember; no visual indication that the field is editable until the user reads the hint text.

**Option Q: Always-visible TextInput with focus management**

Show the `TextInput` always rendered but only focusable when navigated to. This would require adding a focus/navigation system to the component.

- Pros: More discoverable; the field is always visible.
- Cons: Fundamentally changes the component's interaction model; conflicts with the existing `useInput` approach (TextInput captures all keystrokes when focused); significantly more complex to implement; the settings-panel's FieldDef pattern handles this for other sections, but AgentsSettingsContent explicitly does NOT use FieldDef.

**Option R: Navigate to the field with arrow keys, Enter to edit**

Add vertical navigation (up/down arrows) within the agent card, with the custom command as a selectable row. Enter starts editing.

- Pros: More standard TUI pattern; extensible to more fields.
- Cons: Over-engineered for a single field; conflicts with the current flat interaction model; up/down arrows may already be bound in the parent component.

### Recommendation: Option P (press 'c' to enter edit mode)

Option P is the right choice for the current codebase. It is consistent with how other actions work in this component (`m`, `h`, Enter), and it minimizes the implementation surface.

### Implementation Details

1. **State additions**:
   ```typescript
   const [editingCustomCommand, setEditingCustomCommand] = useState(false);
   const [customCommandDraft, setCustomCommandDraft] = useState("");
   const [customCommandWarning, setCustomCommandWarning] = useState<string | null>(null);
   ```

2. **Reading the current value**: Import `settingsStore` and read `config.agents.claude?.customCommand` (after the schema is updated). The component should subscribe to the store to reflect changes.

3. **Keyboard binding**: In the `useInput` handler, add:
   ```typescript
   if (input === "c" && !editingCustomCommand) {
     const current = settingsStore.getState().config.agents.claude?.customCommand ?? "";
     setCustomCommandDraft(current);
     setEditingCustomCommand(true);
     return;
   }
   ```

4. **When editing is active**: Return early from the `useInput` handler so that key presses go to the `TextInput` instead of triggering other actions (m, h, Enter, arrows). Render a `TextInput` from `@inkjs/ui` with `onSubmit` to validate and save, and listen for Escape to cancel.

5. **On submit**:
   - If the value is empty/blank, save `undefined` (clear the custom command)
   - If non-empty, run `which <command>` to validate
   - If not found, set a warning string but still save
   - Call `settingsStore.getState().updateAgentDriver("claude", { customCommand: value || undefined })`
   - The Zustand subscribe bridge propagates to the driver automatically
   - Exit edit mode

6. **UI rendering**: Add a new section below "Sideband Hooks" (or between version info and hooks):
   ```
   ─── Custom Command ───
   Command:    claude-vertex  (c to edit)
   ```
   Or if not set:
   ```
   Command:    claude (default)  (c to customize)
   ```
   When editing, replace the value line with a TextInput.

7. **Warning display**: If the custom command was not found on PATH, show:
   ```
   ⚠ Command "claude-vertex" not found on PATH
   ```
   in yellow text below the field.

---

## 4. Risk Assessment

### 4.1 Race Condition: Config Change During Session Spawn

**Risk**: User changes the custom command in Settings while a session is being spawned.

**Assessment**: Low risk. The `resolveCommand()` call happens synchronously at spawn time in `buildSpawnArgs()`. The PTY process is spawned immediately after with the resolved command. Once spawned, the child process's binary cannot change. The Zustand subscribe callback updates the driver's `_customCommand` field, but this is a simple string assignment -- no lock contention. Worst case: a session spawned in the exact moment of change uses either the old or new command, both of which are valid.

**Mitigation**: None needed.

### 4.2 Backward Compatibility: Existing Config Files

**Risk**: Users with existing `settings.json` files that do not have `agents.claude` or `agents.gemini` keys experience parse failures.

**Assessment**: No risk if implemented correctly. The Zod schema uses `.optional()` for `customCommand` and `.default()` for the `claude`/`gemini` sub-objects. Zod's `.default()` automatically provides the default value when the key is missing. The existing `agents: { statusCheckInterval, detectorInterval }` config parses fine because Zod ignores unknown keys by default (and the new keys have defaults).

**Mitigation**: Ensure the schema uses `.default(() => Schema.parse({}))` for the new sub-objects, matching the existing pattern (see `ConnectorsSchema` on line 63 of `config.ts`).

### 4.3 Custom Command Not Found at Spawn Time

**Risk**: User configures `claude-vertex`, but the binary is not installed (yet). Session spawn fails with an unhelpful error.

**Assessment**: Medium risk. The spec explicitly says to allow saving even if the command is not found (the user may install it later). But when the session actually spawns, `resolveCommand()` will return the raw command string (the `which` fallback), and `node-pty` will fail to spawn it.

**Mitigation**: 
- The Settings UI already shows a warning if the command is not found (per spec requirement 6).
- `checkInstalled()` uses `effectiveCommand`, so the agent card in the main UI can show "not installed" status.
- The `AgentSession.start()` method should already handle spawn failures gracefully (the PTY will emit an exit event). Verify this is the case.

### 4.4 Custom Command with Spaces or Special Characters

**Risk**: User enters a command with spaces (e.g., a path like `/usr/local/bin/my claude`) or shell metacharacters.

**Assessment**: Low-medium risk. The `which` command in `resolveCommand()` will fail if the command has spaces. The `execSync` call in `checkInstalled()` would also fail. More critically, `node-pty.spawn()` takes the command as a string (the first argument), not via a shell, so paths with spaces should work for spawning but will break `which` validation.

**Mitigation**: 
- Document that the custom command must be a single binary name or path without spaces.
- In the validation step, if `which` fails, also try `fs.existsSync()` on the raw value (in case it's an absolute path).
- Alternatively, quote the command in the `which` call: `which "${cmd}"`.

### 4.5 `effectiveCommand` vs `command` Confusion

**Risk**: Code elsewhere reads `driver.command` expecting the actual command being used, but gets `"claude"` (the hardcoded default) even when a custom command is active.

**Assessment**: Low risk after code audit. The `command` property is read in:
- `AGENT_DEFS` in `agents-settings-content.tsx` (uses the constant from `AGENT_DEFS`, not from the driver)
- `resolveCommand()` in `BaseDriver` (overridden in our approach, so safe)
- Nowhere else in the session or spawn logic reads `driver.command` directly

**Mitigation**: The `effectiveCommand` getter provides the correct value for any code that needs the actual binary being used. Document this in a code comment.

### 4.6 TextInput Focus Conflict

**Risk**: When the `TextInput` is active for custom command editing, other keyboard shortcuts (m, h, Enter, arrows) are still captured by the `useInput` hook, causing unintended actions while typing.

**Assessment**: Medium risk. The `useInput` hook runs for all keystrokes. If the user types "m" while editing, it would both append "m" to the input and trigger the install method toggle.

**Mitigation**: The `useInput` handler must return early when `editingCustomCommand` is true. This is a standard pattern in Ink apps. The implementation sketch already accounts for this, but it must be implemented correctly -- the early return must be the first check in the handler.

---

## 5. Technical Research Guidance

```
Research needed: No

All aspects of this feature are well-understood from the codebase scan:

- The Zod schema extension follows the exact pattern of existing sub-schemas (ConnectorsSchema, RelayConfigSchema)
- The Zustand store update method follows the pattern of updateRelay/updateConnector
- The TextInput from @inkjs/ui is already used in settings-panel.tsx (FieldRow pattern)
- The driver architecture is simple and the override pattern is straightforward
- The subscribe() bridge is a standard Zustand pattern
- node-pty spawn behavior with resolved command paths is well-documented

No external library research, API investigation, or deep architectural exploration is required.
The only item worth a quick verification during implementation is confirming that
@inkjs/ui TextInput is already a dependency (check package.json) and understanding
its onSubmit/onChange API, but this is implementation-level detail, not research.
```

---

## 6. Summary of Recommended Implementation Plan

| Layer | Change | Approach |
|-------|--------|----------|
| **Zod schema** (`config.ts`) | Add `claude` and `gemini` sub-objects with `customCommand: z.string().optional()` | Follow `ConnectorsSchema` pattern |
| **Settings store** (`settings-store.ts`) | Add `updateAgentDriver(name, patch)` method | Follow `updateRelay` pattern |
| **ClaudeDriver** (`claude-driver.ts`) | Add `_customCommand` field, `setCustomCommand()`, `effectiveCommand` getter, override `resolveCommand()` and `checkInstalled()` | Option A |
| **GeminiDriver** (`gemini-driver.ts`) | Same field/setter/getter for future use (schema ready, UI deferred) | Mirror Claude pattern |
| **Agent registry** (`agent-registry.ts`) | Add `initDriverConfigs()` with `subscribe()` bridge | Option X with subscribe |
| **App init** (`app.tsx`) | Call `initDriverConfigs()` after settings load | Single call site |
| **Settings UI** (`agents-settings-content.tsx`) | Add custom command display, `c` to edit, TextInput, validation warning | Option P |

**Estimated file changes**: 7 files modified, 0 new files created.
