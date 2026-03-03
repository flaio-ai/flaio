---
"agent-manager": patch
---

Fix Gemini CLI compatibility and add dynamic driver discovery

- Fix Gemini driver: use -p (print) / -i (interactive) flags, --resume latest instead of --continue, add --approval-mode plan for print mode
- Thread driverName through relay protocol so ticket planning/implementation uses the agent selected in the web UI instead of hardcoding "claude"
- Add relay_list_drivers protocol handler: respond with installed drivers for web app discovery
- Add DEFAULT_DRIVER_NAME constant to eliminate magic strings
