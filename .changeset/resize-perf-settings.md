---
"flaio-cli": patch
---

Resize terminal to match active viewer, fix rendering performance, and add settings shortcuts

- Resize PTY to match whichever viewer (CLI, web, portal) is active via focus reporting, keystroke, and scroll fallbacks
- Fix keystroke latency from listener accumulation by cleaning up listeners on session kill
- Improve rendering with synchronous xterm writes and immediate screen buffer flush on idle-to-active transition
- Change default share mode to read-write
- Add 'l' key shortcut for login/logout in settings relay tab
