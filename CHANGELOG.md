# agent-manager

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
