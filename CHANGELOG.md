# agent-manager

## 0.1.2

### Patch Changes

- Fix alt-screen first-line hidden behind header by reserving 1 row for Ink's trailing newline. Read version from package.json instead of hardcoding. Add update check that shows a yellow notice in the status bar when a newer version is available on npm.

## 0.1.1

### Patch Changes

- Fix permission badge getting stuck and terminal header layout offset. Replace rigid status lock with self-healing permission-pending guard. Revert MemoizedLine React.memo that caused Ink layout miscounting.
