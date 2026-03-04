# flaio

## 1.0.3

### Patch Changes

- 383d7f2: Resize terminal to match active viewer, fix rendering performance, and add settings shortcuts

  - Resize PTY to match whichever viewer (CLI, web, portal) is active via focus reporting, keystroke, and scroll fallbacks
  - Fix keystroke latency from listener accumulation by cleaning up listeners on session kill
  - Improve rendering with synchronous xterm writes and immediate screen buffer flush on idle-to-active transition
  - Change default share mode to read-write
  - Add 'l' key shortcut for login/logout in settings relay tab

## 1.0.2

### Patch Changes

- 50b1455: Redesign CLI auth success page with dark themed UI. Fix auth URL trailing slash issue.

## 1.0.1

### Patch Changes

- ac212b2: Update Firebase API key to restricted auth-only key for the new flaio-19b05 project.

## 1.0.0

### Major Changes

- 58848ac: Rebrand from agent-manager to Flaio. New CLI command: `flaio`. New domain: flaio.ai.

## 0.3.1

### Patch Changes

- 48705e5: Fix Gemini CLI compatibility and add dynamic driver discovery

  - Fix Gemini driver: use -p (print) / -i (interactive) flags, --resume latest instead of --continue, add --approval-mode plan for print mode
  - Thread driverName through relay protocol so ticket planning/implementation uses the agent selected in the web UI instead of hardcoding "claude"
  - Add relay_list_drivers protocol handler: respond with installed drivers for web app discovery
  - Add DEFAULT_DRIVER_NAME constant to eliminate magic strings

## 0.2.0-beta.1

### Patch Changes

- a2bfd53: Update relay URLs to charliesagents.app production domain

## 0.2.0-beta.0

### Minor Changes

- 48a23a2: Add relay client for remote web terminal access

  - Connect to a relay server for browser-based terminal sessions
  - End-to-end encryption (X25519 + AES-256-GCM) between CLI and browser
  - Remote directory browsing via relay_browse_dir handler
  - Configurable relay server URL via settings
  - Firebase authentication with automatic token refresh

## 0.1.2

### Patch Changes

- Fix alt-screen first-line hidden behind header by reserving 1 row for Ink's trailing newline. Read version from package.json instead of hardcoding. Add update check that shows a yellow notice in the status bar when a newer version is available on npm.

## 0.1.1

### Patch Changes

- Fix permission badge getting stuck and terminal header layout offset. Replace rigid status lock with self-healing permission-pending guard. Revert MemoizedLine React.memo that caused Ink layout miscounting.
