# Issues - Pending Items

## Pending

1. **initDriverConfigs() lacks idempotency guard** -- The `initDriverConfigs()` function in `src/agents/agent-registry.ts` adds a new `settingsStore.subscribe()` listener on every call. While the current call sites are all guarded by `if (!loaded)` checks, the function itself has no internal guard to prevent duplicate subscriptions if called multiple times. A boolean flag (`let driverConfigsInitialized = false`) at module scope would be a safer approach. **Severity: Low** -- current callers are safe, but future callers may not be.

2. **Custom command with spaces or absolute paths** -- The `which` command does not reliably resolve absolute paths (e.g., `/usr/local/bin/my-claude`). If a user enters an absolute path as the custom command, the PATH validation in the settings UI will show a false warning. The `resolveCommand()` method will also fail the `which` check but returns the raw string, so session spawn will still work. Consider adding a `fs.existsSync` fallback for absolute paths in the validation. **Severity: Low** -- cosmetic warning only, spawn still works.

## Completed

1. **Command injection in `which` calls** -- Fixed. All `execSync(\`which ${cmd}\`)` calls across `base-driver.ts`, `claude-driver.ts`, `gemini-driver.ts`, and `agents-settings-content.tsx` were replaced with `execFileSync("which", [cmd])` to prevent shell metacharacter injection.

2. **Custom command warning persists across sub-tab switches** -- Fixed. The `customCommandWarning` state is now cleared when switching between Claude and Gemini sub-tabs via left/right arrow keys.
