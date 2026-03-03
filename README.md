# Agent Manager

> **This project has been renamed to [Flaio](https://github.com/flaio-ai/flaio) and now lives at [github.com/flaio-ai/flaio](https://github.com/flaio-ai/flaio).**
>
> Install the new package: `npm install -g flaio-cli`
>
> This repository is archived and will no longer receive updates.

---

A terminal UI application for managing multiple AI CLI agents in tabbed sessions. Run Claude Code and Gemini CLI side by side, get permission requests forwarded to Slack, Discord, or Telegram, and adopt standalone agents already running on your system — all from a single interface.

Built with [Ink](https://github.com/vadimdemedes/ink) (React for CLIs), [node-pty](https://github.com/microsoft/node-pty), and [xterm-headless](https://github.com/xtermjs/xterm.js).

![Version](https://img.shields.io/badge/version-0.1.0-blue)
![License](https://img.shields.io/badge/license-MIT-green)
![Node](https://img.shields.io/badge/node-%3E%3D18-brightgreen)

## Features

### Multi-Agent Sessions
- **Tabbed interface** — Run multiple AI agents simultaneously, each in its own tab with a full PTY-backed terminal
- **Supported agents** — Claude Code and Gemini CLI out of the box, with a driver abstraction for adding more
- **Session lifecycle** — Create new sessions, resume previous ones, or continue where you left off
- **Intelligent status detection** — Automatically detects when an agent is idle, running, or waiting for input

### Standalone Agent Adoption
- **Auto-detection** — Continuously scans for Claude Code and Gemini CLI processes running outside the manager
- **One-key adoption** — Press `Alt+A` to bring a standalone agent into a managed tab, seamlessly continuing its session

### Messaging Connectors
Forward permission requests, tool results, and session notifications to your preferred messaging platform:

| Platform | Permission Requests | Tool Results | Notifications | Threading |
|----------|-------------------|--------------|---------------|-----------|
| **Slack** | Text replies (allow/deny) | Per-session threads | Session start/stop | Per-session threads |
| **Discord** | Thread replies | Formatted output | Status messages | Auto-created threads |
| **Telegram** | Inline keyboard buttons | Formatted output | Status messages | — |

All connector dependencies are optional — only install what you need.

### Portal — Remote Session Access
Connect to running sessions from another terminal window without disrupting the main UI:

- **Interactive picker** — Run `agent-manager portal` to browse and select sessions
- **Create sessions remotely** — Start new agent sessions directly from the portal
- **Full terminal mirroring** — See the exact same output as the main app in real-time
- **Input forwarding** — Type commands and interact with the agent as if you were in the main app
- **Scroll support** — Mouse wheel, `Ctrl+U`/`Ctrl+D`, and `PageUp`/`PageDown` all work
- **Connection indicator** — The main app shows a `⇄` icon in the header when a portal client is connected

### Hooks System
An IPC-based hooks system bridges Claude Code's lifecycle events to the manager:

- **PermissionRequest** — Tool execution approval routed through connectors
- **PostToolUse** — Tool results forwarded to messaging platforms
- **Notification** — Agent responses and status changes relayed to connectors

Hooks communicate via Unix socket IPC (`/tmp/agent-manager/hooks.sock`) with newline-delimited JSON.

### Terminal Emulation
- Full ANSI color support (16, 256, and truecolor RGB)
- Text attributes: bold, italic, underline, dim, inverse, strikethrough
- Mouse wheel scrolling and keyboard scroll (`Ctrl+U`/`Ctrl+D`)
- 1000-line scrollback buffer
- FPS-limited screen rendering (default 30 FPS)

### Responsive Layout
- **Wide terminals (100+ cols):** Sidebar with session list on the left, terminal on the right
- **Narrow terminals (< 100 cols):** Compact tab bar at the top, full-width terminal below

## Installation

### Prerequisites
- Node.js >= 18
- At least one supported AI CLI agent installed:
  - [Claude Code](https://docs.anthropic.com/en/docs/claude-code) — `npm install -g @anthropic-ai/claude-code`
  - [Gemini CLI](https://github.com/google-gemini/gemini-cli) — `npm install -g @google/gemini-cli`

### Install from npm

```bash
npm install -g agent-manager
```

Then run it:

```bash
agent-manager
```

### Install from Source

```bash
git clone https://github.com/georgelivas/agent-manager.git
cd agent-manager
npm install
npm run build
npm start
```

### Development

```bash
# Run with live reload
npm run dev
```

### Hook Installation

To enable messaging connector integration with Claude Code, install the hooks:

```bash
npm run install-hooks
```

This registers three hooks in `~/.claude/settings.json` that route Claude Code events through the manager's IPC server. To remove them:

```bash
npm run uninstall-hooks
```

## Usage

### Starting the Manager

```bash
# Development
npm run dev

# Production
npm start
```

### Creating a Session

1. Press `Ctrl+T` to open the new session dialog
2. Select an agent (Claude Code or Gemini CLI)
3. Enter the working directory (supports tab completion)
4. The agent spawns in a new tab with a full terminal

### Adopting a Standalone Agent

If you have a Claude Code or Gemini CLI process running in another terminal:

1. Press `Alt+A` to open the adopt dialog
2. Select the detected agent from the list
3. The external process is terminated and its session continues in a new managed tab

### Using Portals

Portals let you access running sessions from a separate terminal — useful for monitoring agents on a remote machine, pairing, or just keeping the main UI on one screen while interacting from another.

```bash
# Interactive picker — browse sessions, create new ones
agent-manager portal

# Connect directly to a known session
agent-manager portal <session-id>

# Static table of running sessions
agent-manager portal --list
```

In the interactive picker:
- Use **arrow keys** to navigate, **Enter** to select
- Choose **"+ New Session"** to start a fresh agent from the portal
- Press **Esc** to exit

Once connected, the portal mirrors the session in real-time. Press **Ctrl+C** to disconnect and return to your shell.

### Configuring Connectors

Press `Ctrl+S` to open the settings panel, then configure your preferred messaging connectors.

#### Slack

Slack integration gives you per-session threads, permission approval via text replies, and agent response forwarding — so you can monitor and interact with agents from your phone or desktop.

**1. Create a Slack App**

Go to [api.slack.com/apps](https://api.slack.com/apps) and create a new app "From scratch."

**2. Configure Bot Scopes**

Under **OAuth & Permissions**, add these Bot Token Scopes:

| Scope | Purpose |
|-------|---------|
| `chat:write` | Post messages and thread replies |
| `channels:history` | Read replies in public channels (for permission responses and prompts) |
| `channels:read` | Resolve channel info |

If you're using a **private channel**, also add `groups:history` and `groups:read`.

**3. Install to Workspace**

Click **Install to Workspace** and authorize. Copy the **Bot User OAuth Token** (`xoxb-...`).

**4. Invite the Bot to a Channel**

In Slack, go to your channel and type `/invite @YourBotName`.

**5. Get the Channel ID**

Right-click the channel name > **View channel details** > copy the **Channel ID** at the bottom.

**6. (Optional) Enable Socket Mode for Real-Time Events**

By default, the manager polls Slack threads every 3 seconds. For faster message delivery:

1. Go to **Socket Mode** in your app settings and enable it
2. Generate an **App-Level Token** with `connections:write` scope
3. Copy the token (`xapp-...`)

**7. Configure in Agent Manager**

Press `Ctrl+S` in the manager, enable Slack, and enter:

| Field | Value |
|-------|-------|
| **Bot Token** | `xoxb-...` from step 3 |
| **Channel ID** | From step 5 |
| **App Token** (optional) | `xapp-...` from step 6 |

Or edit `~/.config/agent-manager/settings.json` directly:

```json
{
  "connectors": {
    "slack": {
      "enabled": true,
      "botToken": "xoxb-your-token",
      "appToken": "xapp-your-token",
      "channelId": "C0123456789",
      "pollInterval": 3000,
      "timeout": 300000
    }
  }
}
```

**8. Install Hooks**

```bash
npm run install-hooks
```

This registers lifecycle hooks in `~/.claude/settings.json` so Claude Code events (permission requests, agent responses, notifications) are forwarded to Slack.

**How It Works**

When a session starts, the bot creates a thread in your Slack channel:

```
Session started
Project: my-project
CWD: ~/projects/my-project
Session: abc123
```

All agent interactions happen in that thread:
- **Agent responses** are posted automatically
- **Permission requests** appear with the tool name and input — reply `allow` or `deny`
- **You can send prompts** by replying in the thread — they're forwarded directly to the agent's input

Messages from Slack are delivered via Socket Mode (instant) or thread polling (every 3s), with built-in deduplication to prevent double delivery.

#### Discord

1. Create a Discord bot at the [Developer Portal](https://discord.com/developers/applications)
2. Enable the bot and grant `Send Messages` + `Read Message History` permissions
3. In settings, enable Discord and enter:
   - **Bot Token**
   - **Channel ID**

#### Telegram

1. Create a bot via [@BotFather](https://t.me/botfather)
2. In settings, enable Telegram and enter:
   - **Bot Token** (from BotFather)
   - **Chat ID** (your personal or group chat ID)

### Managing Agents

Press `Ctrl+S` and navigate to the **Agents** tab to:
- Check installed agent versions
- Switch install method (npm or Homebrew)
- Install or update agents directly from the UI

## Keyboard Shortcuts

### Navigation

| Key | Action |
|-----|--------|
| `Ctrl+T` | New session |
| `Ctrl+W` | Close active session |
| `Ctrl+N` / `Ctrl+Down` | Next session |
| `Ctrl+P` / `Ctrl+Up` | Previous session |
| `Alt+1` — `Alt+9` | Jump to session by number |

### Scrolling

| Key | Action |
|-----|--------|
| `Ctrl+U` | Scroll up |
| `Ctrl+D` | Scroll down |
| `Mouse Wheel` | Scroll up/down |

### Panels & Modals

| Key | Action |
|-----|--------|
| `Ctrl+S` | Toggle settings panel |
| `Ctrl+B` | Toggle sidebar |
| `Ctrl+G` | Toggle help modal |
| `Alt+A` | Adopt standalone agent |
| `Esc` | Close modal / cancel dialog |

### Application

| Key | Action |
|-----|--------|
| `Ctrl+Q` | Quit |

> **Note:** On macOS, `Alt` shortcuts use the `Option` key or the `Esc` prefix (press `Esc` then the key).

## Architecture

```
src/
├── cli.tsx                         # Entry point (Commander + Ink)
├── app.tsx                         # Root component
├── agents/
│   ├── agent-session.ts            # Session lifecycle & events
│   ├── agent-registry.ts           # Driver registry
│   ├── agent-detector.ts           # Standalone process scanner
│   └── drivers/
│       ├── base-driver.ts          # Abstract driver interface
│       ├── claude-driver.ts        # Claude Code driver
│       └── gemini-driver.ts        # Gemini CLI driver
├── connectors/
│   ├── connector-interface.ts      # Connector contract
│   ├── connector-manager.ts        # Routes events to connectors
│   └── adapters/
│       ├── slack-adapter.ts        # Slack (Web API + Socket Mode)
│       ├── discord-adapter.ts      # Discord (discord.js)
│       └── telegram-adapter.ts     # Telegram (Telegraf)
├── terminal/
│   ├── pty-manager.ts              # node-pty wrapper
│   ├── xterm-bridge.ts             # xterm-headless rendering
│   └── screen-buffer.ts            # FPS-limited display buffer
├── hooks/
│   ├── hook-server.ts              # Unix socket IPC server
│   ├── hook.ts                     # PermissionRequest handler
│   ├── post-tool-hook.ts           # PostToolUse handler
│   ├── notification-hook.ts        # Notification handler
│   ├── stop-hook.ts                # Stop event handler
│   └── install.ts                  # Hook installer/uninstaller
├── portal/
│   ├── shared.ts                  # Protocol types (client ↔ server)
│   ├── portal-server.ts           # Unix socket server (main app)
│   ├── portal-client.ts           # IPC client functions
│   ├── portal-picker.tsx           # Interactive session picker
│   └── ansi-renderer.ts           # ScreenContent → ANSI converter
├── store/
│   ├── app-store.ts                # Session state (Zustand)
│   ├── settings-store.ts           # Persisted config (Zustand)
│   ├── connector-store.ts          # Connector lifecycle & bridges
│   └── portal-store.ts            # Portal connection tracking
├── config/
│   ├── config.ts                   # Zod schema & load/save
│   └── defaults.ts                 # Default configuration
└── ui/
    ├── layout/
    │   ├── shell.tsx               # Main layout container
    │   ├── sidebar.tsx             # Session list panel
    │   ├── main-pane.tsx           # Terminal + header
    │   └── status-bar.tsx          # Bottom status indicators
    ├── components/
    │   ├── terminal-view.tsx       # xterm grid renderer
    │   ├── agent-tab.tsx           # Session tab
    │   ├── new-session-dialog.tsx  # Create session dialog
    │   ├── adopt-agent-dialog.tsx  # Adopt agent dialog
    │   ├── standalone-agents.tsx   # Detected agents list
    │   ├── settings-panel.tsx      # Settings UI
    │   ├── agents-settings-content.tsx  # Agent install/update UI
    │   ├── help-modal.tsx          # Keybindings reference
    │   └── path-input.tsx          # Directory autocomplete
    └── hooks/
        ├── use-keybindings.ts      # Keyboard shortcut handler
        ├── use-raw-input.ts        # Raw stdin forwarding
        ├── use-terminal-size.ts    # Terminal dimensions
        ├── use-spinner.ts          # Cycling animation hook
        ├── use-git-info.ts         # Git branch/status polling
        └── use-portal-connected.ts # Portal connection state
```

### How It Works

1. **CLI entry** (`cli.tsx`) sets up the alternate screen buffer, mouse tracking, and renders the Ink app. The `portal` subcommand launches the interactive picker or connects to a session directly.
2. **App** (`app.tsx`) initializes stores, starts connectors and the portal server, and renders the shell layout
3. **Sessions** are managed by `AppStore` — each session owns a `PtyManager` (node-pty), `XtermBridge` (headless terminal emulation), and `ScreenBuffer` (FPS-limited rendering)
4. **Keyboard input** is captured by `useRawInput` and forwarded to the active session's PTY, except when intercepted by `useKeybindings` for shortcuts
5. **Portal server** (`portal-server.ts`) listens on a Unix socket (`/tmp/agent-manager/portal.sock`). Portal clients subscribe to sessions, receive throttled screen frames, and forward keystrokes — providing full remote access without disrupting the main UI
6. **Hooks** are installed as Claude Code lifecycle hooks that send events to the manager's IPC server, which routes them through `ConnectorManager` to the configured messaging adapters
7. **State** flows through Zustand stores with selector-based subscriptions for efficient re-renders

## Configuration

Settings are persisted to `~/.config/agent-manager/settings.json` and validated with Zod on load.

```jsonc
{
  "ui": {
    "sidebarWidth": 24,         // Sidebar character width
    "narrowBreakpoint": 100,    // Column threshold for responsive layout
    "targetFps": 30             // Screen buffer refresh rate
  },
  "connectors": {
    "slack": {
      "enabled": false,
      "botToken": "",           // xoxb-... token
      "appToken": "",           // xapp-... token (optional, for Socket Mode)
      "channelId": "",
      "pollInterval": 2000,     // Thread polling interval (ms)
      "timeout": 300000         // Permission request timeout (ms)
    },
    "discord": {
      "enabled": false,
      "botToken": "",
      "channelId": "",
      "timeout": 300000
    },
    "telegram": {
      "enabled": false,
      "botToken": "",
      "chatId": "",
      "timeout": 300000
    }
  },
  "agents": {
    "statusCheckInterval": 1000,  // Agent status polling (ms)
    "detectorInterval": 5000      // Standalone agent scan interval (ms)
  }
}
```

## Contributing

Contributions are welcome! Please feel free to submit issues and pull requests.

### Adding a New Agent Driver

1. Create a new driver in `src/agents/drivers/` extending `BaseDriver`
2. Implement the required methods: `spawn()`, `resume()`, `continue()`, `detectStatus()`
3. Register it in `src/agents/agent-registry.ts`

### Adding a New Connector

1. Create a new adapter in `src/connectors/adapters/` implementing `ConnectorInterface`
2. Implement: `connect()`, `disconnect()`, `requestPermission()`, `postToolResult()`, `postNotification()`
3. Add config schema in `src/config/config.ts`
4. Wire it up in `src/connectors/connector-manager.ts`

## License

This project is licensed under the MIT License. See the [LICENSE](LICENSE) file for details.
