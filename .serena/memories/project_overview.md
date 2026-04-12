# Flaio - Project Overview

## Purpose
Terminal UI (TUI) for managing multiple AI CLI agents (Claude, Gemini) with tabbed sessions. Published as `flaio-cli` on npm.

## Tech Stack
- Language: TypeScript (ESM, `"type": "module"`)
- UI Framework: Ink 6 (React for CLI) + React 19
- Terminal: node-pty, @xterm/headless
- State: Zustand
- Validation: Zod
- Build: tsc
- Test: Vitest
- Dev runner: tsx
- Package manager: npm
- Node requirement: >=18

## Key Directories
- `src/agents/` - Agent detection, sessions, drivers (Claude, Gemini)
- `src/store/` - Zustand stores (app, settings, connector, portal)
- `src/ui/` - React/Ink components, hooks, layout
- `src/config/` - Configuration defaults
- `src/terminal/` - PTY management, screen buffer, xterm bridge
- `src/hooks/` - Claude Code hooks integration
- `src/relay/` - Relay client/protocol for remote connections
- `src/portal/` - Portal server/client for shared sessions
- `src/connectors/` - Slack, Discord, Telegram adapters
- `src/analytics/` - Sentry, PostHog, crash recovery

## Entry Points
- `src/cli.tsx` - Main CLI entry (commander-based)
- `src/app.tsx` - Main React/Ink app component
