---
"agent-manager": minor
---

Add relay client for remote web terminal access

- Connect to a relay server for browser-based terminal sessions
- End-to-end encryption (X25519 + AES-256-GCM) between CLI and browser
- Remote directory browsing via relay_browse_dir handler
- Configurable relay server URL via settings
- Firebase authentication with automatic token refresh
