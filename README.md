# Code Relay

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

### Setup

```bash
# Clone the repository
git clone https://github.com/georgelivas/code-relay.git
cd code-relay

# Install dependencies
npm install

# Build
npm run build

# Run
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

### Configuring Connectors

Press `Ctrl+S` to open the settings panel, then configure your preferred messaging connectors:

#### Slack

1. Create a Slack app with the following scopes: `chat:write`, `channels:history`, `channels:read`
2. Install the app to your workspace
3. In settings, enable Slack and enter:
   - **Bot Token** (`xoxb-...`)
   - **Channel ID** (right-click a channel > "View channel details" > copy the ID)
   - Optionally: **App Token** (`xapp-...`) for Socket Mode (real-time events instead of polling)

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
├── store/
│   ├── app-store.ts                # Session state (Zustand)
│   ├── settings-store.ts           # Persisted config (Zustand)
│   └── connector-store.ts          # Connector lifecycle & bridges
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
        └── use-terminal-size.ts    # Terminal dimensions
```

### How It Works

1. **CLI entry** (`cli.tsx`) sets up the alternate screen buffer, mouse tracking, and renders the Ink app
2. **App** (`app.tsx`) initializes stores, starts connectors, and renders the shell layout
3. **Sessions** are managed by `AppStore` — each session owns a `PtyManager` (node-pty), `XtermBridge` (headless terminal emulation), and `ScreenBuffer` (FPS-limited rendering)
4. **Keyboard input** is captured by `useRawInput` and forwarded to the active session's PTY, except when intercepted by `useKeybindings` for shortcuts
5. **Hooks** are installed as Claude Code lifecycle hooks that send events to the manager's IPC server, which routes them through `ConnectorManager` to the configured messaging adapters
6. **State** flows through Zustand stores with selector-based subscriptions for efficient re-renders

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

## Legacy Standalone Hooks

The `src/` directory also contains standalone hook scripts (`hook.js`, `stop-hook.js`, `post-tool-hook.js`, `stop-watcher.js`, `slack-client.js`, `config.js`) that work independently of the TUI. These provide direct Slack integration for Claude Code without running the full manager:

```bash
# Set up .env with SLACK_BOT_TOKEN and SLACK_CHANNEL_ID
cp .env.example .env

# Install standalone hooks
node src/install.js install

# Check hook status
node src/install.js status

# Remove standalone hooks
node src/install.js uninstall
```

These are useful if you only need Slack-based permission approval without the terminal UI.

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
