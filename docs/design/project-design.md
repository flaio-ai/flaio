# Project Design -- Configurable Custom Command for Claude/Gemini Sessions

## 1. Architecture Overview

```
                          Data Flow for Custom Command Configuration

  +-------------------+       +-------------------+       +--------------------+
  | settings.json     |       | config.ts         |       | settings-store.ts  |
  | ~/.config/flaio/  | ----> | Zod parse:        | ----> | Zustand store:     |
  | {                 |       |  AgentsSchema {    |       |  config.agents     |
  |   agents: {       |       |   claude: {       |       |    .claude           |
  |     claude: {     |       |    customCommand? |       |      .customCommand  |
  |       customCom.. |       |   }               |       |                    |
  |     }             |       |  }                |       | updateAgentDriver()|
  |   }               |       |                   |       +--------+-----------+
  | }                 |       +-------------------+                |
  +-------------------+                                            |
                                                                   | subscribe()
                                                                   v
  +---------------------------+       +----------------------------+
  | agent-registry.ts         |       | app.tsx / cli.tsx          |
  |                           | <---- | initDriverConfigs()        |
  | initDriverConfigs():      |       | called after               |
  |   subscribe to store      |       | settingsStore.load()       |
  |   sync customCommand to   |       +----------------------------+
  |   driver instances        |
  +------------+--------------+
               |
               | setCustomCommand(cmd)
               v
  +---------------------------+       +----------------------------+
  | claude-driver.ts          |       | agents-settings-content.tsx|
  |                           |       |                            |
  | _customCommand?: string   |       | Press 'c' to edit          |
  | effectiveCommand getter   |       | TextInput for value         |
  | resolveCommand() override |       | 'which' validation          |
  | checkInstalled() override |       | Calls updateAgentDriver()  |
  +---------------------------+       +----------------------------+
               |
               | resolveCommand() returns custom or default path
               v
  +---------------------------+
  | agent-session.ts          |
  | (NO CHANGES)              |
  | driver.buildSpawnArgs()   |
  |   -> resolveCommand()     |
  |   -> spawns PTY           |
  +---------------------------+
```

**Key points:**
- The custom command value flows from `settings.json` through Zod parsing into the Zustand settings store.
- `initDriverConfigs()` in `agent-registry.ts` reads the initial value and subscribes to future changes, calling `setCustomCommand()` on the driver instance.
- The driver's `resolveCommand()` override uses the custom command (if set) instead of the hardcoded default.
- The Settings UI reads from the store and writes via `updateAgentDriver()`, which triggers the subscription automatically.
- `AgentSession` requires zero changes -- it already delegates to `driver.buildSpawnArgs()` / `buildResumeArgs()` / `buildContinueArgs()`.

---

## 2. Detailed Changes Per File

### 2.1 `src/config/config.ts` -- Zod Schema Extension

**Current code (lines 68-71):**
```typescript
const AgentsSchema = z.object({
  statusCheckInterval: z.number().default(DEFAULTS.agents.statusCheckInterval),
  detectorInterval: z.number().default(DEFAULTS.agents.detectorInterval),
});
```

**New code:**
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

**Additional type exports to add after line 87 (after `export type WorktreeConfig`):**
```typescript
export type ClaudeAgentConfig = z.infer<typeof ClaudeAgentConfigSchema>;
export type GeminiAgentConfig = z.infer<typeof GeminiAgentConfigSchema>;
```

**Why:** The `AgentsSchema` currently has only timing fields. Adding `claude` and `gemini` sub-objects scopes per-driver configuration cleanly. The `.default(() => Schema.parse({}))` pattern matches `ConnectorsSchema` (line 62-66) and ensures backward compatibility -- existing config files without these keys parse successfully.

---

### 2.2 `src/agents/drivers/claude-driver.ts` -- Custom Command Override

**Current code (lines 4-16):**
```typescript
export class ClaudeDriver extends BaseDriver {
  readonly name = "claude";
  readonly displayName = "Claude Code";
  readonly command = "claude";

  async checkInstalled(): Promise<boolean> {
    try {
      execSync("which claude", { stdio: "ignore" });
      return true;
    } catch {
      return false;
    }
  }
```

**New code:**
```typescript
export class ClaudeDriver extends BaseDriver {
  readonly name = "claude";
  readonly displayName = "Claude Code";
  readonly command = "claude";

  private _customCommand?: string;

  /**
   * Set a custom command to use instead of the default "claude" binary.
   * Pass undefined to revert to the default.
   */
  setCustomCommand(cmd: string | undefined): void {
    this._customCommand = cmd?.trim() || undefined;
  }

  /**
   * Returns the custom command if set, otherwise the default command.
   * Use this instead of `this.command` when you need the actual binary
   * that will be executed.
   */
  get effectiveCommand(): string {
    return this._customCommand ?? this.command;
  }

  override resolveCommand(): string {
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
```

**Why:** Option A from the investigation -- override `resolveCommand()` and `checkInstalled()` in the subclass rather than modifying `BaseDriver`. The `readonly command = "claude"` field stays unchanged, preserving backward compatibility for any code that reads `driver.command` for display or identification. The `effectiveCommand` getter provides the actual binary name. All three `build*Args` methods already call `this.resolveCommand()`, so they automatically pick up the custom command.

---

### 2.3 `src/agents/drivers/gemini-driver.ts` -- Symmetric Custom Command Override

**Current code (lines 4-16):**
```typescript
export class GeminiDriver extends BaseDriver {
  readonly name = "gemini";
  readonly displayName = "Gemini CLI";
  readonly command = "gemini";

  async checkInstalled(): Promise<boolean> {
    try {
      execSync("which gemini", { stdio: "ignore" });
      return true;
    } catch {
      return false;
    }
  }
```

**New code:**
```typescript
export class GeminiDriver extends BaseDriver {
  readonly name = "gemini";
  readonly displayName = "Gemini CLI";
  readonly command = "gemini";

  private _customCommand?: string;

  /**
   * Set a custom command to use instead of the default "gemini" binary.
   * Pass undefined to revert to the default.
   */
  setCustomCommand(cmd: string | undefined): void {
    this._customCommand = cmd?.trim() || undefined;
  }

  /**
   * Returns the custom command if set, otherwise the default command.
   */
  get effectiveCommand(): string {
    return this._customCommand ?? this.command;
  }

  override resolveCommand(): string {
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
```

**Why:** Mirrors the Claude driver pattern exactly. The schema field (`agents.gemini.customCommand`) is already added in config.ts. The UI wiring for Gemini is included in the settings panel (same component handles both sub-tabs). This makes the feature complete for both drivers simultaneously.

---

### 2.4 `src/store/settings-store.ts` -- Add `updateAgentDriver` Method

**Current interface (lines 4-17):**
```typescript
export interface SettingsState {
  config: AppConfig;
  loaded: boolean;

  load: () => void;
  save: () => void;
  update: (patch: Partial<AppConfig>) => void;
  updateConnector: (
    name: "slack" | "discord" | "telegram",
    patch: Record<string, unknown>,
  ) => void;
  updateUi: (patch: Record<string, unknown>) => void;
  updateRelay: (patch: Record<string, unknown>) => void;
}
```

**New interface:**
```typescript
export interface SettingsState {
  config: AppConfig;
  loaded: boolean;

  load: () => void;
  save: () => void;
  update: (patch: Partial<AppConfig>) => void;
  updateConnector: (
    name: "slack" | "discord" | "telegram",
    patch: Record<string, unknown>,
  ) => void;
  updateUi: (patch: Record<string, unknown>) => void;
  updateRelay: (patch: Record<string, unknown>) => void;
  updateAgentDriver: (
    driverName: "claude" | "gemini",
    patch: Record<string, unknown>,
  ) => void;
}
```

**Current store implementation ends at (lines 68-80):**
```typescript
  updateRelay: (patch) => {
    set((prev) => ({
      config: {
        ...prev.config,
        relay: {
          ...prev.config.relay,
          ...patch,
        },
      },
    }));
    get().save();
  },
}));
```

**New code (insert before the closing `}))`):**
```typescript
  updateRelay: (patch) => {
    set((prev) => ({
      config: {
        ...prev.config,
        relay: {
          ...prev.config.relay,
          ...patch,
        },
      },
    }));
    get().save();
  },

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
}));
```

**Why:** Follows the exact same deep-merge pattern as `updateConnector` (lines 39-53) and `updateRelay` (lines 68-79). The `driverName` parameter is typed as a union of `"claude" | "gemini"` to match the schema keys. After merging, it calls `get().save()` to persist to disk immediately.

---

### 2.5 `src/agents/agent-registry.ts` -- Config-to-Driver Bridge

**Current code (full file, lines 1-31):**
```typescript
import type { BaseDriver } from "./drivers/base-driver.js";
import { ClaudeDriver } from "./drivers/claude-driver.js";
import { GeminiDriver } from "./drivers/gemini-driver.js";

const drivers: Map<string, BaseDriver> = new Map();

export function registerDriver(driver: BaseDriver): void {
  drivers.set(driver.name, driver);
}

export function getDriver(name: string): BaseDriver | undefined {
  return drivers.get(name);
}

export function getAllDrivers(): BaseDriver[] {
  return Array.from(drivers.values());
}

export async function getInstalledDrivers(): Promise<BaseDriver[]> {
  const results: BaseDriver[] = [];
  for (const driver of drivers.values()) {
    if (await driver.checkInstalled()) {
      results.push(driver);
    }
  }
  return results;
}

// Register built-in drivers
registerDriver(new ClaudeDriver());
registerDriver(new GeminiDriver());
```

**New code (complete file):**
```typescript
import type { BaseDriver } from "./drivers/base-driver.js";
import { ClaudeDriver } from "./drivers/claude-driver.js";
import { GeminiDriver } from "./drivers/gemini-driver.js";
import { settingsStore } from "../store/settings-store.js";

const drivers: Map<string, BaseDriver> = new Map();

export function registerDriver(driver: BaseDriver): void {
  drivers.set(driver.name, driver);
}

export function getDriver(name: string): BaseDriver | undefined {
  return drivers.get(name);
}

export function getAllDrivers(): BaseDriver[] {
  return Array.from(drivers.values());
}

export async function getInstalledDrivers(): Promise<BaseDriver[]> {
  const results: BaseDriver[] = [];
  for (const driver of drivers.values()) {
    if (await driver.checkInstalled()) {
      results.push(driver);
    }
  }
  return results;
}

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

// Register built-in drivers
registerDriver(new ClaudeDriver());
registerDriver(new GeminiDriver());
```

**Why:** The `initDriverConfigs()` function is the bridge between the configuration layer and the driver layer. It uses a Zustand `subscribe()` callback to keep drivers in sync automatically whenever settings change. The `as ClaudeDriver` cast is safe because we know the registered instance type. The function must be called once after `settingsStore.load()` completes.

---

### 2.6 `src/app.tsx` -- Bootstrap `initDriverConfigs`

**Current code (lines 36-38):**
```typescript
  useEffect(() => {
    settingsStore.getState().load();
  }, []);
```

**New code:**
```typescript
  useEffect(() => {
    settingsStore.getState().load();
    initDriverConfigs();
  }, []);
```

**New import to add (after line 14, with the other store imports):**
```typescript
import { initDriverConfigs } from "./agents/agent-registry.js";
```

**Why:** The TUI entry point must call `initDriverConfigs()` after the settings store loads so that driver instances have the correct custom command before any session is created. The `subscribe()` inside `initDriverConfigs` ensures subsequent changes from the Settings UI propagate automatically.

---

### 2.7 `src/cli.tsx` -- Bootstrap `initDriverConfigs` for CLI Subcommands

The `ensureLoaded()` helper (lines 273-277) is the centralized function that calls `settingsStore.getState().load()` for CLI subcommands:

**Current code (lines 273-277):**
```typescript
function ensureLoaded() {
  if (!settingsStore.getState().loaded) {
    settingsStore.getState().load();
  }
}
```

**New code:**
```typescript
function ensureLoaded() {
  if (!settingsStore.getState().loaded) {
    settingsStore.getState().load();
    initDriverConfigs();
  }
}
```

**New import to add (after line 35, with the other store imports):**
```typescript
import { initDriverConfigs } from "./agents/agent-registry.js";
```

**Additional sites:** The `login` command (line 172-173) and `logout` command (line 199-200) each have inline `if (!settingsStore.getState().loaded) { settingsStore.getState().load(); }` checks rather than calling `ensureLoaded()`. These should also call `initDriverConfigs()`:

**login command (lines 172-174), change:**
```typescript
    if (!settingsStore.getState().loaded) {
      settingsStore.getState().load();
    }
```
**to:**
```typescript
    if (!settingsStore.getState().loaded) {
      settingsStore.getState().load();
      initDriverConfigs();
    }
```

**logout command (lines 199-201), same change:**
```typescript
    if (!settingsStore.getState().loaded) {
      settingsStore.getState().load();
    }
```
**to:**
```typescript
    if (!settingsStore.getState().loaded) {
      settingsStore.getState().load();
      initDriverConfigs();
    }
```

**Why:** CLI subcommands that interact with agents (even indirectly) need the drivers configured. The `initDriverConfigs()` call is idempotent for the initial sync but adds a new `subscribe()` listener each time, so it must only be called once (guarded by the `loaded` check).

---

### 2.8 `src/ui/components/agents-settings-content.tsx` -- Custom Command UI

#### 2.8.1 New imports

**Current imports (lines 1-15):**
```typescript
import React, { useState, useEffect, useCallback } from "react";
import { Box, Text, useInput } from "ink";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import {
  installHookScripts,
  getClaudeHooksConfig,
  getClaudeStatusLineConfig,
  getGeminiHooksConfig,
  mergeSettingsFile,
  areClaudeHooksConfigured,
  areGeminiHooksConfigured,
} from "../../agents/sideband/hook-scripts.js";
import os from "node:os";
import path from "node:path";
```

**New imports:**
```typescript
import React, { useState, useEffect, useCallback } from "react";
import { Box, Text, useInput } from "ink";
import { TextInput } from "@inkjs/ui";
import { execFile, execSync } from "node:child_process";
import { promisify } from "node:util";
import {
  installHookScripts,
  getClaudeHooksConfig,
  getClaudeStatusLineConfig,
  getGeminiHooksConfig,
  mergeSettingsFile,
  areClaudeHooksConfigured,
  areGeminiHooksConfigured,
} from "../../agents/sideband/hook-scripts.js";
import { settingsStore } from "../../store/settings-store.js";
import os from "node:os";
import path from "node:path";
```

**Why:** `TextInput` from `@inkjs/ui` provides the inline text editing component. `execSync` is used for `which` validation. `settingsStore` is needed to read and write the custom command setting.

#### 2.8.2 New state variables

**Insert after line 88 (after existing useState calls):**
```typescript
  const [editingCustomCommand, setEditingCustomCommand] = useState(false);
  const [customCommandDraft, setCustomCommandDraft] = useState("");
  const [customCommandWarning, setCustomCommandWarning] = useState<string | null>(null);
```

#### 2.8.3 Helper to read current custom command

**Insert after the new state declarations:**
```typescript
  const getCustomCommand = useCallback((): string | undefined => {
    const { agents } = settingsStore.getState().config;
    const driverName = AGENT_DEFS[subTab]!.driverName as "claude" | "gemini";
    return agents[driverName]?.customCommand;
  }, [subTab]);
```

#### 2.8.4 Submit handler

**Insert after `handleSetupHooks` (after line 175):**
```typescript
  const handleCustomCommandSubmit = useCallback((value: string) => {
    const trimmed = value.trim();
    const driverName = AGENT_DEFS[subTab]!.driverName as "claude" | "gemini";

    if (trimmed === "") {
      // Clear custom command -- revert to default
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

#### 2.8.5 Modified useInput handler

**Current code (lines 253-275):**
```typescript
  useInput((input, key) => {
    if (!isActive) return;

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
    if (key.return) {
      handleAction(subTab);
    }
  });
```

**New code:**
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

**Why:** The `editingCustomCommand` early-return MUST be the first check after the `isActive` guard. When the TextInput is active, every keystroke (including "m", "h", Enter, arrows) must be passed to the TextInput rather than triggering other actions. Pressing Escape cancels the edit. Pressing "c" enters edit mode.

#### 2.8.6 New JSX section for Custom Command display

**Insert after the Sideband Hooks section (after line 377, before the closing `</Box>` of the agent info card on line 378):**

```tsx
        {/* Custom Command */}
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

**Why:** Placed after the Sideband Hooks section to maintain the visual hierarchy. When not editing, it shows the current command (or default) with a hint to press "c". When editing, a TextInput replaces the display text. The warning line appears conditionally below when the command is not found on PATH.

---

## 3. Implementation Units

### Unit A: Schema + Defaults (`config.ts`)

**Standalone -- no dependencies.**

Changes:
- Add `ClaudeAgentConfigSchema` and `GeminiAgentConfigSchema` Zod objects
- Modify `AgentsSchema` to include `claude` and `gemini` sub-objects
- Export `ClaudeAgentConfig` and `GeminiAgentConfig` types

Verification: `npx tsc --noEmit`

### Unit B: Driver Changes (`claude-driver.ts`, `gemini-driver.ts`)

**Standalone -- no dependencies.**

Changes:
- Add `_customCommand` private field, `setCustomCommand()` method, `effectiveCommand` getter
- Override `resolveCommand()` to use `effectiveCommand`
- Update `checkInstalled()` to use `effectiveCommand`

Verification: `npx tsc --noEmit`

### Unit C: Settings Store (`settings-store.ts`)

**Depends on Unit A** (needs the updated `AppConfig` type with `agents.claude` and `agents.gemini` keys for type-safe access in the implementation).

Changes:
- Add `updateAgentDriver` to `SettingsState` interface
- Add `updateAgentDriver` implementation in the store

Verification: `npx tsc --noEmit`

### Unit D: Registry Bridge + App Bootstrap (`agent-registry.ts`, `app.tsx`, `cli.tsx`)

**Depends on Units A, B, C** (needs the schema types, the `setCustomCommand()` method on drivers, and the store subscription).

Changes:
- Add `initDriverConfigs()` function to `agent-registry.ts`
- Add import and call in `app.tsx` `useEffect`
- Add import and call in `cli.tsx` `ensureLoaded()` and inline load sites

Verification: `npx tsc --noEmit`

### Unit E: Settings UI (`agents-settings-content.tsx`)

**Depends on Units A, C** (needs the updated `AppConfig` type and `updateAgentDriver()` store method). Does not depend on Unit B for compilation, but runtime correctness requires Unit D (the subscription bridge).

Changes:
- Add imports (`TextInput`, `execSync`, `settingsStore`)
- Add state variables for editing mode
- Add `getCustomCommand()` helper
- Add `handleCustomCommandSubmit()` handler
- Modify `useInput` handler with editing guard and "c" binding
- Add JSX section for Custom Command display

Verification: `npx tsc --noEmit`, manual testing in TUI

### Parallelization Summary

| Batch | Units | Files | Notes |
|-------|-------|-------|-------|
| Batch 1 | A + B | `config.ts`, `claude-driver.ts`, `gemini-driver.ts` | Fully independent |
| Batch 2 | C + E | `settings-store.ts`, `agents-settings-content.tsx` | Both depend on A only |
| Batch 3 | D | `agent-registry.ts`, `app.tsx`, `cli.tsx` | Depends on A, B, C |
| Batch 4 | (testing) | -- | Integration testing |

---

## 4. Interface Contracts

### Contract 1: Schema Types (Unit A exports, consumed by C, D, E)

```typescript
// Exported from config.ts

export type ClaudeAgentConfig = {
  customCommand?: string;
};

export type GeminiAgentConfig = {
  customCommand?: string;
};

// AppConfig["agents"] shape becomes:
type AgentsConfig = {
  statusCheckInterval: number;
  detectorInterval: number;
  claude: ClaudeAgentConfig;   // always present after parse (default: {})
  gemini: GeminiAgentConfig;   // always present after parse (default: {})
};
```

### Contract 2: Driver Custom Command API (Unit B exports, consumed by D)

```typescript
// On ClaudeDriver and GeminiDriver:

/**
 * Set a custom command override. Pass undefined to clear.
 * Whitespace-only strings are treated as undefined.
 */
setCustomCommand(cmd: string | undefined): void;

/**
 * Returns _customCommand if set, otherwise the readonly `command` property.
 */
get effectiveCommand(): string;

/**
 * Resolves effectiveCommand via `which`. Falls back to the raw string
 * if `which` fails.
 */
resolveCommand(): string;
```

The `setCustomCommand` method is the ONLY way external code should modify the driver's command. The `command` readonly property remains `"claude"` or `"gemini"` always.

### Contract 3: Settings Store Method (Unit C exports, consumed by D, E)

```typescript
// On SettingsState interface:

updateAgentDriver: (
  driverName: "claude" | "gemini",
  patch: Record<string, unknown>,
) => void;
```

Behavior:
- Deep-merges `patch` into `config.agents[driverName]`
- Preserves all other `agents` fields (`statusCheckInterval`, `detectorInterval`, the other driver's config)
- Calls `save()` immediately (persists to disk)
- Triggers Zustand subscribers (which includes the bridge in Unit D)

### Contract 4: Registry Bridge (Unit D exports, consumed by `app.tsx` and `cli.tsx`)

```typescript
// Exported from agent-registry.ts:

/**
 * Must be called exactly once after settingsStore.getState().load().
 * - Reads current config and calls setCustomCommand() on each driver.
 * - Subscribes to settingsStore for future changes.
 */
export function initDriverConfigs(): void;
```

Caller contract:
- Call after `settingsStore.getState().load()` has completed
- Call only once per process (the subscribe callback accumulates)
- Safe to call before any session is created

---

## 5. Error Handling

### 5.1 Invalid/Missing Custom Command Binary

**When configured via UI:**
- On submit, `execSync(`which ${trimmed}`)` is called
- If `which` fails, a yellow warning is displayed: `Command "xxx" not found on PATH`
- The value is still saved (the user may install the command later)
- The warning is visual only; it does not prevent saving

**When spawning a session:**
- `driver.resolveCommand()` calls `which <effectiveCommand>`
- If `which` fails, it returns the raw command string (e.g., `"claude-vertex"`)
- `node-pty.spawn()` receives this raw string as the command
- If the binary does not exist, `node-pty` throws an error
- `AgentSession.start()` catches the error and rejects the Promise
- The `handleNewSession` callback in `app.tsx` (lines 104-122) catches this rejection and shows `Failed to start session: <message>`, then cleans up the dead session

**No silent fallback:** Per project convention, if `customCommand` is set and the binary is missing, the spawn fails. The driver does NOT fall back to `"claude"`. This is enforced by `effectiveCommand` returning `_customCommand` unconditionally when set.

### 5.2 `checkInstalled()` with Custom Command

- `checkInstalled()` uses `which ${this.effectiveCommand}`
- If the custom command binary does not exist, it returns `false`
- The agent card in the main UI may show "not installed" status, which is correct behavior

### 5.3 Custom Command with Special Characters

- The `which` command may fail for paths with spaces
- The `setCustomCommand()` method trims whitespace but does not validate further
- Absolute paths (e.g., `/usr/local/bin/my-claude`) work in `node-pty.spawn()` even if `which` cannot find them
- Edge case: if the user enters a command with shell metacharacters, `which` may produce unexpected results; however, `node-pty.spawn()` does not go through a shell, so injection is not a concern

### 5.4 Config Parse Errors

- If `settings.json` contains malformed JSON or invalid types for `agents.claude.customCommand` (e.g., a number instead of a string), Zod will reject it
- The `loadConfig()` function (lines 101-111 of `config.ts`) catches parse errors and returns defaults: `AppConfigSchema.parse({})`
- The user's custom command is lost in this case, but the app starts cleanly

---

## 6. Backward Compatibility

### Existing Config Files Without New Fields

**Scenario:** A user has `settings.json` with:
```json
{
  "agents": {
    "statusCheckInterval": 2000,
    "detectorInterval": 5000
  }
}
```

**Behavior after schema change:**
1. `AgentsSchema.parse(data)` is called on the raw object
2. The `claude` key is missing -- Zod applies `.default(() => ClaudeAgentConfigSchema.parse({}))`
3. `ClaudeAgentConfigSchema.parse({})` returns `{ customCommand: undefined }` (because `customCommand` is `.optional()`)
4. Same for `gemini`
5. Result: `agents.claude` and `agents.gemini` exist as empty objects with `customCommand: undefined`
6. The driver receives `undefined` from `agents.claude?.customCommand`, which means "use the default command"

**Scenario:** Config file has no `agents` key at all:
```json
{
  "ui": { "showCost": true }
}
```

**Behavior:** `AppConfigSchema` has `agents: AgentsSchema.default(...)`, so a missing `agents` key produces the full default object including the new `claude` and `gemini` sub-objects.

### Serialization of New Fields

When `saveConfig()` writes the config back to disk after a change, the `claude` and `gemini` keys will appear in the JSON even if `customCommand` is undefined:
```json
{
  "agents": {
    "statusCheckInterval": 2000,
    "detectorInterval": 5000,
    "claude": {},
    "gemini": {}
  }
}
```

When `customCommand` is set:
```json
{
  "agents": {
    "statusCheckInterval": 2000,
    "detectorInterval": 5000,
    "claude": { "customCommand": "claude-vertex" },
    "gemini": {}
  }
}
```

This is benign. The `JSON.stringify` serializer omits `undefined` values, so `{ customCommand: undefined }` serializes as `{}`.

### `driver.command` Property Unchanged

Code that reads `driver.command` for identification, display, or comparison (e.g., `AGENT_DEFS[subTab]!.command` in the settings UI) continues to see `"claude"` or `"gemini"`. Only `resolveCommand()`, `checkInstalled()`, and `effectiveCommand` reflect the custom override.
