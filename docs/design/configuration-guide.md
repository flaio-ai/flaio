# Configuration Guide: Custom Agent Commands

## Rationale

Claude Code and Gemini CLI support multiple API backends beyond their default providers. Claude Code, for example, can route requests through **Azure AI Foundry**, **Google Vertex AI**, or **Amazon Bedrock** instead of the standard Anthropic API. Each backend requires specific environment variables and configuration to be set before the CLI launches.

When running agents directly from a terminal, users typically handle this with shell aliases or functions in `.zshrc`/`.bashrc` — for example, a `claudey` function that sets Azure Foundry environment variables before invoking `claude`. However, **flaio spawns agent sessions programmatically via `node-pty`**, which executes commands directly without loading a shell profile. This means:

- Shell aliases and functions are **invisible** to flaio
- Environment variables set in `.zshrc` are **not inherited** by spawned processes
- CLI flags like `--permission-mode` or `--mcp-config` cannot be injected without modifying the driver code

The **Custom Command** feature solves this by allowing users to point flaio at an **executable wrapper script** that sets up the required environment and flags before delegating to the actual agent CLI.

## How It Works

Each agent driver (Claude, Gemini) has a `customCommand` configuration field. When set:

1. The driver uses the custom command instead of the default (`claude` or `gemini`) when spawning, resuming, or continuing sessions
2. The custom command must be a **real executable on PATH** — not a shell alias or function
3. If the custom command is cleared, the driver reverts to the default binary

The setting is persisted in `~/.config/flaio/settings.json` under:

```json
{
  "agents": {
    "claude": {
      "customCommand": "claudeysh.sh"
    },
    "gemini": {
      "customCommand": "my-gemini-wrapper"
    }
  }
}
```

## Setting Up a Custom Command

### Step 1: Identify What Your Alias Does

If you have a shell alias or function like:

```bash
function claudey() {
    export CLAUDE_CODE_USE_FOUNDRY=1
    export ANTHROPIC_FOUNDRY_RESOURCE=biksaiservice-east-us-2
    export ANTHROPIC_DEFAULT_SONNET_MODEL='claude-sonnet-4-6'
    export ANTHROPIC_DEFAULT_HAIKU_MODEL='claude-haiku-4-6'
    export ANTHROPIC_DEFAULT_OPUS_MODEL='claude-opus-4-6'
    claude "$@" --permission-mode bypassPermissions --mcp-config ~/.claude/mcp-settings.json
}
```

Extract the environment variables, flags, and the final `claude "$@"` invocation.

### Step 2: Create an Executable Script

Convert the alias/function into a standalone script. Place it in a directory on your PATH (e.g., `~/.local/bin/`):

```bash
mkdir -p ~/.local/bin
```

Create the script file (e.g., `~/.local/bin/claudeysh.sh`):

```bash
#!/bin/bash
export CLAUDE_CODE_USE_FOUNDRY=1
export ANTHROPIC_FOUNDRY_RESOURCE=biksaiservice-east-us-2
export ANTHROPIC_DEFAULT_SONNET_MODEL='claude-sonnet-4-6'
export ANTHROPIC_DEFAULT_HAIKU_MODEL='claude-haiku-4-6'
export ANTHROPIC_DEFAULT_OPUS_MODEL='claude-opus-4-6'
claude "$@" --permission-mode bypassPermissions --mcp-config ~/.claude/mcp-settings.json
```

Make it executable:

```bash
chmod +x ~/.local/bin/claudeysh.sh
```

Verify it's found on PATH:

```bash
which claudeysh.sh
# Should output: /Users/<you>/.local/bin/claudeysh.sh
```

> **Important:** Ensure `~/.local/bin` is in your PATH. If not, add this to your `.zshrc`:
> ```bash
> export PATH="$HOME/.local/bin:$PATH"
> ```

### Step 3: Test the Script Standalone

Before configuring flaio, verify the script works from the terminal:

```bash
claudeysh.sh --version
# Should output the Claude Code version
```

### Step 4: Configure in Flaio

1. Launch flaio
2. Press **Ctrl+S** to open Settings
3. Navigate to the **Agents** tab
4. Select the **Claude Code** sub-tab
5. Press **c** to edit the Custom Command field
6. Type the script name: `claudeysh.sh`
7. Press **Enter** to save

If the command is found on PATH, no warning appears. If not, a yellow warning is shown — but the value is still saved (useful if you plan to install the script later).

To revert to the default `claude` command, press **c**, clear the field, and press **Enter**.

## Common Provider Configurations

### Azure AI Foundry

```bash
#!/bin/bash
export CLAUDE_CODE_USE_FOUNDRY=1
export ANTHROPIC_FOUNDRY_RESOURCE=<your-resource-name>
export ANTHROPIC_DEFAULT_SONNET_MODEL='claude-sonnet-4-6'
export ANTHROPIC_DEFAULT_HAIKU_MODEL='claude-haiku-4-6'
export ANTHROPIC_DEFAULT_OPUS_MODEL='claude-opus-4-6'
claude "$@"
```

> **Prerequisite:** You must have authenticated with Azure via `az login` and have the appropriate Foundry resource provisioned.

### Google Vertex AI

```bash
#!/bin/bash
export CLAUDE_CODE_USE_VERTEX=1
export ANTHROPIC_VERTEX_PROJECT_ID=<your-gcp-project-id>
export CLOUD_ML_REGION=<your-region>
export ANTHROPIC_DEFAULT_OPUS_MODEL='claude-opus-4-6[1m]'
export ANTHROPIC_DEFAULT_SONNET_MODEL='claude-sonnet-4-6[1m]'
export ANTHROPIC_DEFAULT_HAIKU_MODEL='claude-haiku-4-5-20251001'
claude "$@"
```

> **Prerequisite:** You must have authenticated with Google Cloud via `gcloud auth application-default login` and have the Vertex AI API enabled.

### Amazon Bedrock

```bash
#!/bin/bash
export CLAUDE_CODE_USE_BEDROCK=1
export AWS_REGION=<your-region>
export ANTHROPIC_MODEL='us.anthropic.claude-sonnet-4-6-20250514-v1:0'
claude "$@"
```

> **Prerequisite:** You must have configured AWS credentials via `aws configure` or environment variables.

### Adding Extra CLI Flags

You can embed any Claude Code CLI flags in the script:

```bash
#!/bin/bash
# Use Azure Foundry with custom MCP config and bypass permissions
export CLAUDE_CODE_USE_FOUNDRY=1
export ANTHROPIC_FOUNDRY_RESOURCE=my-resource
claude "$@" \
    --permission-mode bypassPermissions \
    --mcp-config ~/.claude/mcp-settings.json
```

## Multiple Configurations

You can create multiple scripts for different providers and switch between them in flaio's settings:

| Script | Provider | Description |
|--------|----------|-------------|
| `claude-foundry.sh` | Azure AI Foundry | Routes through Azure |
| `claude-vertex.sh` | Google Vertex AI | Routes through GCP |
| `claude-bedrock.sh` | Amazon Bedrock | Routes through AWS |
| (default `claude`) | Anthropic API | Direct Anthropic access |

Switch between them by changing the Custom Command in Settings > Agents > Claude Code.

## Troubleshooting

### "Command not found on PATH" warning

- Verify the script exists: `ls -la ~/.local/bin/your-script.sh`
- Verify it's executable: `chmod +x ~/.local/bin/your-script.sh`
- Verify PATH includes the directory: `echo $PATH | tr ':' '\n' | grep local/bin`
- Shell aliases and functions do NOT work — you must use a real executable script

### Session fails to start

- Test the script directly: `your-script.sh --version`
- Check that the underlying `claude` binary is installed and on PATH
- Verify your provider credentials are valid (e.g., `az login`, `gcloud auth application-default login`)

### Custom command not taking effect

- After changing the setting, new sessions will use the updated command
- Existing running sessions are not affected — close and reopen them
- Verify the setting was saved: check `~/.config/flaio/settings.json`

### Why can't flaio use shell aliases directly?

Flaio uses `node-pty` to spawn agent processes. `node-pty` calls `execvp()` directly — it does not launch a shell, so `.zshrc`/`.bashrc` are never loaded. This is by design for performance and security. The wrapper script approach gives you the same flexibility while being compatible with direct process spawning.
