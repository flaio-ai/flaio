# Codebase Scan: Custom Claude Command Feature

## 1. Driver Architecture

### BaseDriver (`src/agents/drivers/base-driver.ts`)

Abstract class defining the driver contract:

```typescript
export abstract class BaseDriver {
  abstract readonly name: string;        // e.g. "claude"
  abstract readonly displayName: string; // e.g. "Claude Code"
  abstract readonly command: string;     // e.g. "claude" — the binary name

  resolveCommand(): string {
    // Uses `which ${this.command}` to find full path; falls back to this.command
  }

  abstract checkInstalled(): Promise<boolean>;
  abstract listModels(): ModelInfo[];
  abstract buildSpawnArgs(options): SpawnConfig;
  abstract buildResumeArgs(options): SpawnConfig;
  abstract buildContinueArgs(options): SpawnConfig;
  abstract detectStatus(recentOutput, idleMs): AgentStatus;
}
```

Key types:
- `SpawnConfig`: `{ command: string; args: string[]; env?: Record<string, string> }`
- `AgentStatus`: `"idle" | "starting" | "running" | "waiting_input" | "waiting_permission" | "exited"`

**Critical constraint**: `command` is declared `abstract readonly`. To support a custom command override, the implementation strategy must either:
1. Change `command` to a getter backed by a private mutable field, OR
2. Accept the override in the constructor and assign it to the `readonly` property at construction time, OR
3. Override `resolveCommand()` in the subclass to check for a custom command first.

Option 3 is cleanest — override `resolveCommand()` in `ClaudeDriver` to resolve the custom command when set, keeping `command` as the default.

### ClaudeDriver (`src/agents/drivers/claude-driver.ts`)

```typescript
export class ClaudeDriver extends BaseDriver {
  readonly name = "claude";
  readonly displayName = "Claude Code";
  readonly command = "claude";  // <-- hardcoded, line 7

  async checkInstalled(): Promise<boolean> {
    execSync("which claude", { stdio: "ignore" });  // <-- also hardcoded, line 11
  }

  buildSpawnArgs(options): SpawnConfig {
    return { command: this.resolveCommand(), args };  // line 49
  }
  buildResumeArgs(options): SpawnConfig {
    return { command: this.resolveCommand(), args };  // line 61
  }
  buildContinueArgs(_options): SpawnConfig {
    return { command: this.resolveCommand(), args: ["--continue"] };  // line 65
  }
}
```

All three build methods use `this.resolveCommand()`, so overriding `resolveCommand()` propagates to all spawn/resume/continue paths. The `checkInstalled()` method separately hardcodes `"which claude"` and must also be updated.

### GeminiDriver (`src/agents/drivers/gemini-driver.ts`)

Identical pattern: `readonly command = "gemini"`, `checkInstalled()` hardcodes `"which gemini"`. Same changes needed for future Gemini custom command support.

### AgentSession (`src/agents/agent-session.ts`)

Consumes a `BaseDriver` instance via constructor injection (line 62). Calls:
- `this.driver.buildSpawnArgs(...)` in `start()` (line 212)
- `this.driver.buildResumeArgs(...)` in `resume()` (line 245)
- `this.driver.buildContinueArgs(...)` in `continueSession()` (line 270)

**No changes needed** in `AgentSession` — it transparently uses whatever `SpawnConfig` the driver returns.

### Agent Registry (`src/agents/agent-registry.ts`)

Singleton Map of driver instances, registered at module load:

```typescript
const drivers: Map<string, BaseDriver> = new Map();
registerDriver(new ClaudeDriver());
registerDriver(new GeminiDriver());
```

**Change needed**: The `ClaudeDriver` (and later `GeminiDriver`) constructor must accept an optional custom command. The registration call must either:
- Pass the custom command from config at registration time, OR
- Add a setter/method on the driver that the registry or store can call after config loads, OR
- Re-register the driver when config changes.

**Recommended approach**: Add a `setCustomCommand(cmd?: string)` method to `BaseDriver` (or at least `ClaudeDriver`), and have the settings store call it when config loads or changes. The registry itself stays unchanged.

### App Store (`src/store/app-store.ts`)

`createSession()` (line 85) and `adoptAgent()` (line 266) both call `getDriver(driverName)` to get the driver instance from the registry. They pass it to `new AgentSession(driver, ...)`. The driver's custom command must already be set by the time sessions are created.

**No changes needed** in app-store — the driver instance is shared and its custom command state propagates automatically.

---

## 2. Configuration System

### Schema (`src/config/config.ts`)

Zod-based schema. The `AgentsSchema` currently has only timing fields:

```typescript
const AgentsSchema = z.object({
  statusCheckInterval: z.number().default(DEFAULTS.agents.statusCheckInterval),
  detectorInterval: z.number().default(DEFAULTS.agents.detectorInterval),
});
```

**Change needed**: Add per-driver custom command fields:

```typescript
const ClaudeAgentConfigSchema = z.object({
  customCommand: z.string().optional(),
});

const GeminiAgentConfigSchema = z.object({
  customCommand: z.string().optional(),
});

const AgentsSchema = z.object({
  statusCheckInterval: z.number().default(DEFAULTS.agents.statusCheckInterval),
  detectorInterval: z.number().default(DEFAULTS.agents.detectorInterval),
  claude: ClaudeAgentConfigSchema.default(() => ClaudeAgentConfigSchema.parse({})),
  gemini: GeminiAgentConfigSchema.default(() => GeminiAgentConfigSchema.parse({})),
});
```

This keeps backward compatibility — existing config files without the `claude`/`gemini` keys parse successfully because `.default()` provides empty objects, and `customCommand` is `.optional()`.

The `AppConfig` type is inferred from `AppConfigSchema`:
```typescript
export type AppConfig = z.infer<typeof AppConfigSchema>;
```

### Defaults (`src/config/defaults.ts`)

Currently has `agents: { statusCheckInterval, detectorInterval }`. No per-driver defaults needed since `customCommand` is optional (absence means use the hardcoded binary name).

### Persistence

Config file: `~/.config/flaio/settings.json`
- `loadConfig()` reads and parses with Zod (line 95-112)
- `saveConfig()` writes JSON (line 114-121)
- Legacy migration from `~/.config/agent-manager/` is handled

### Settings Store (`src/store/settings-store.ts`)

Zustand vanilla store with:
- `config: AppConfig` — the full config
- `load()` — reloads from disk
- `save()` — writes to disk
- `update(patch)` — shallow merge at top level
- `updateConnector(name, patch)` — deep merge for connector sub-objects
- `updateUi(patch)` — deep merge for UI sub-object
- `updateRelay(patch)` — deep merge for relay sub-object

**Change needed**: Add an `updateAgents(patch)` method similar to `updateRelay`:

```typescript
updateAgents: (patch: Record<string, unknown>) => {
  set((prev) => ({
    config: {
      ...prev.config,
      agents: {
        ...prev.config.agents,
        ...patch,
      },
    },
  }));
  get().save();
},
```

Or more specifically, `updateAgentDriver(driverName, patch)` for nested driver configs:

```typescript
updateAgentDriver: (driverName: "claude" | "gemini", patch: Record<string, unknown>) => {
  set((prev) => ({
    config: {
      ...prev.config,
      agents: {
        ...prev.config.agents,
        [driverName]: {
          ...(prev.config.agents as any)[driverName],
          ...patch,
        },
      },
    },
  }));
  get().save();
},
```

---

## 3. Settings UI Patterns

### Settings Panel (`src/ui/components/settings-panel.tsx`)

Tab-based panel with sections: `connectors | ui | agents | relay | worktree`.

For non-agents sections, settings use the `FieldDef` pattern:
```typescript
interface FieldDef {
  label: string;
  type: "boolean" | "string" | "number";
  getValue: () => unknown;
  setValue: (v: unknown) => void;
  isToken?: boolean;
}
```

Fields are rendered via `FieldRow` components with inline editing (TextInput for strings/numbers, toggle for booleans).

**For the agents section** (line 215, 249, 351-353): When `section === "agents"`, the panel renders `<AgentsSettingsContent isActive={...} />` instead of field rows. Input handling for the agents section is entirely delegated — the `SettingsPanel` returns early on `if (section === "agents") return;` at line 249 for input handling.

### AgentsSettingsContent (`src/ui/components/agents-settings-content.tsx`)

Sub-tab based component with tabs for each agent (Claude Code, Gemini CLI). Uses `AGENT_DEFS` array:

```typescript
const AGENT_DEFS = [
  { driverName: "claude", displayName: "Claude Code", command: "claude", ... },
  { driverName: "gemini", displayName: "Gemini CLI", command: "gemini", ... },
] as const;
```

Current features per agent sub-tab:
- Install method (npm/brew), version info, install/update button
- Sideband hooks status and setup

**Keyboard bindings** (line 253-275):
- Left/Right arrows: switch sub-tab
- `m`: toggle install method
- `h`: setup hooks
- Enter: install/update action

**Change needed**: Add a "Custom Command" text field to the agent info card. This requires:
1. Adding state for the custom command value and editing mode
2. Reading from `settingsStore.getState().config.agents.claude?.customCommand`
3. Adding a keyboard binding (e.g., `c` for custom command edit, or add it as a navigable field)
4. Rendering a TextInput when editing
5. On submit: validate via `which`, update settings store, and propagate to driver

The component currently has no inline text editing — it only has action buttons. Adding a text field requires either:
- Importing `TextInput` from `@inkjs/ui` and managing edit state (like FieldRow in settings-panel), or
- Adding a FieldDef-style row within the agent card.

**Recommended approach**: Add a dedicated section below the "Sideband Hooks" block with a "Custom Command" label and value display. When the user presses `c`, enter edit mode with a TextInput. On submit, validate and save.

---

## 4. Integration Points

### Data Flow for Custom Command

1. **Config load** (`loadConfig()` in config.ts) → Zod parses `agents.claude.customCommand` from `settings.json`
2. **Settings store** (`settingsStore`) holds the parsed `AppConfig`
3. **Driver update**: On load and on config change, the `ClaudeDriver` instance in the registry must be notified of the custom command value
4. **Session spawn**: `AgentSession.start()` → `driver.buildSpawnArgs()` → `driver.resolveCommand()` → returns custom command path
5. **Settings UI**: `AgentsSettingsContent` reads from store, writes to store via `updateAgentDriver("claude", { customCommand })`

### Connection between Settings Store and Driver

Currently there is no mechanism linking settings changes to driver instances. The registry creates driver instances at module load time (line 30-31 of agent-registry.ts) and never updates them.

**New bridge needed**: Either:
- Export the driver instances and call a setter when config loads/changes, or
- Have the agent registry expose a function to update driver config, or
- Have `resolveCommand()` read from the settings store directly (creates coupling but is simplest)

**Recommended**: Add a `customCommand` property (with getter/setter) to `BaseDriver` or `ClaudeDriver`. After `settingsStore.load()` completes, and on each relevant config change, call `getDriver("claude")?.setCustomCommand(config.agents.claude?.customCommand)`.

### Validation

When saving a custom command in the UI:
1. Run `which <command>` (or `execSync`) to check PATH
2. If not found: show warning (yellow text) but still save
3. The driver's `checkInstalled()` should also use the custom command

---

## 5. File List — Required Modifications

### `src/config/config.ts`
- Add `ClaudeAgentConfigSchema` and `GeminiAgentConfigSchema` Zod objects with `customCommand: z.string().optional()`
- Modify `AgentsSchema` to include `claude` and `gemini` sub-objects
- Export new types if needed

### `src/config/defaults.ts`
- No changes strictly required (customCommand is optional, no default needed)

### `src/agents/drivers/base-driver.ts`
- Add optional `_customCommand?: string` private field
- Add `get effectiveCommand(): string` or `setCustomCommand(cmd?: string)` method
- Modify `resolveCommand()` to use `_customCommand ?? this.command`

### `src/agents/drivers/claude-driver.ts`
- Override `checkInstalled()` to use `this._customCommand ?? this.command` instead of hardcoded `"claude"`
- Alternatively, if `resolveCommand()` in base class handles it, `checkInstalled()` can call `this.resolveCommand()` and check its existence

### `src/agents/drivers/gemini-driver.ts`
- Same pattern as claude-driver for future extensibility (schema is added, UI deferred)

### `src/store/settings-store.ts`
- Add `updateAgentDriver(driverName: "claude" | "gemini", patch: Record<string, unknown>)` method
- Add interface entry for the new method in `SettingsState`

### `src/agents/agent-registry.ts`
- Add a function like `updateDriverConfig(driverName: string, config: { customCommand?: string })` that calls the driver's setter
- Or: add an initialization function that reads from config and sets custom commands on registered drivers

### `src/ui/components/agents-settings-content.tsx`
- Import `settingsStore` and `TextInput`
- Add state: `customCommandValue`, `editingCustomCommand`
- Add keyboard binding `c` to enter custom command edit mode
- Add UI rendering: "Custom Command" label + value display + TextInput when editing
- On submit: validate via `which`, call `settingsStore.getState().updateAgentDriver("claude", { customCommand: value || undefined })`, update the driver instance
- Show warning if command not found on PATH

### `src/ui/components/settings-panel.tsx`
- No direct changes needed — agents section delegates to `AgentsSettingsContent`

### `src/store/app-store.ts`
- No changes needed — sessions already use driver.buildSpawnArgs() which calls resolveCommand()

### `src/agents/agent-session.ts`
- No changes needed — already uses driver methods transparently

### Bootstrap / Entry Point
- Wherever the app initializes (likely the main entry point or where `settingsStore.load()` is called), add logic to propagate the loaded `agents.claude.customCommand` to the driver instance via the registry.
