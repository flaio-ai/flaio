---
"flaio-cli": patch
---

Reduce memory usage: skip no-op Zustand state updates, cap planning session buffers at 2MB, release ScreenBuffer resources on cleanup, and reduce xterm scrollback for non-interactive sessions
