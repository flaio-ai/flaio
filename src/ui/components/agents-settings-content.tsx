import React, { useState, useEffect, useCallback } from "react";
import { Box, Text, useInput } from "ink";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import {
  installHookScripts,
  getClaudeHooksConfig,
  getClaudeStatusLineConfig,
  getGeminiHooksConfig,
  mergeSettingsFile,
  areClaudeHooksConfigured,
  areGeminiHooksConfigured,
} from "../../agents/sideband/hook-scripts.js";
import os from "node:os";
import path from "node:path";

const execFileAsync = promisify(execFile);

type InstallMethod = "npm" | "brew";

const AGENT_DEFS = [
  { driverName: "claude", displayName: "Claude Code", command: "claude", npmPackage: "@anthropic-ai/claude-code", brewFormula: "claude-code" },
  { driverName: "gemini", displayName: "Gemini CLI", command: "gemini", npmPackage: "@google/gemini-cli", brewFormula: "gemini-cli" },
] as const;

type AgentInstallStatus = "checking" | "not_installed" | "up_to_date" | "update_available" | "installing" | "error";

interface AgentVersionInfo {
  displayName: string;
  command: string;
  npmPackage: string;
  brewFormula: string;
  installMethod: InstallMethod;
  installedVersion: string | null;
  latestVersion: string | null;
  status: AgentInstallStatus;
  error?: string;
}

const SEMVER_RE = /(\d+\.\d+\.\d+)/;

function initAgents(): AgentVersionInfo[] {
  return AGENT_DEFS.map((def) => ({
    displayName: def.displayName,
    command: def.command,
    npmPackage: def.npmPackage,
    brewFormula: def.brewFormula,
    installMethod: "npm",
    installedVersion: null,
    latestVersion: null,
    status: "checking",
  }));
}

function getLatestVersion(agent: AgentVersionInfo): Promise<string | null> {
  if (agent.installMethod === "brew") {
    return execFileAsync("brew", ["info", "--json=v2", agent.brewFormula])
      .then(({ stdout }) => {
        const info = JSON.parse(stdout) as { formulae: { versions: { stable: string } }[] };
        return info.formulae[0]?.versions.stable ?? null;
      })
      .catch(() => null);
  }
  return execFileAsync("npm", ["show", agent.npmPackage, "version"])
    .then(({ stdout }) => stdout.trim())
    .catch(() => null);
}

function installAgent(agent: AgentVersionInfo): Promise<{ stdout: string; stderr: string }> {
  if (agent.installMethod === "brew") {
    // brew upgrade handles both install and update
    return execFileAsync("brew", ["upgrade", agent.brewFormula], { timeout: 120_000 })
      .catch(() => execFileAsync("brew", ["install", agent.brewFormula], { timeout: 120_000 }));
  }
  return execFileAsync("npm", ["install", "-g", agent.npmPackage], { timeout: 120_000 });
}

interface AgentsSettingsContentProps {
  isActive: boolean;
}

type HooksStatus = "checking" | "configured" | "not_configured" | "installing" | "done" | "error";

export function AgentsSettingsContent({ isActive }: AgentsSettingsContentProps): React.ReactElement {
  const [subTab, setSubTab] = useState(0);
  const [agents, setAgents] = useState<AgentVersionInfo[]>(initAgents);
  const [hooksStatus, setHooksStatus] = useState<{ claude: HooksStatus; gemini: HooksStatus }>({ claude: "checking", gemini: "checking" });
  const [hooksError, setHooksError] = useState<string | null>(null);

  const checkVersions = useCallback((currentAgents: AgentVersionInfo[]) => {
    let cancelled = false;

    for (let idx = 0; idx < currentAgents.length; idx++) {
      const agent = currentAgents[idx]!;
      const i = idx;

      // Reset to checking
      setAgents((prev) => prev.map((a, j) => j === i ? { ...a, status: "checking" as const, error: undefined } : a));

      const getInstalled = execFileAsync(agent.command, ["--version"])
        .then(({ stdout }) => {
          const match = stdout.match(SEMVER_RE);
          return match ? match[1]! : null;
        })
        .catch(() => null);

      const getLatest = getLatestVersion(agent);

      Promise.all([getInstalled, getLatest]).then(([installed, latest]) => {
        if (cancelled) return;

        let status: AgentInstallStatus;
        if (installed === null) {
          status = "not_installed";
        } else if (latest && installed === latest) {
          status = "up_to_date";
        } else if (latest && installed !== latest) {
          status = "update_available";
        } else {
          status = "up_to_date";
        }

        setAgents((prev) =>
          prev.map((a, j) =>
            j === i ? { ...a, installedVersion: installed, latestVersion: latest, status } : a,
          ),
        );
      });
    }

    return () => { cancelled = true; };
  }, []);

  useEffect(() => {
    return checkVersions(agents);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Check hooks status on mount
  useEffect(() => {
    Promise.all([areClaudeHooksConfigured(), areGeminiHooksConfigured()]).then(
      ([claude, gemini]) => {
        setHooksStatus({
          claude: claude ? "configured" : "not_configured",
          gemini: gemini ? "configured" : "not_configured",
        });
      },
    );
  }, []);

  const handleSetupHooks = useCallback(async () => {
    setHooksStatus((prev) => ({ ...prev, claude: "installing", gemini: "installing" }));
    setHooksError(null);
    try {
      const { hookPath, statusLinePath } = await installHookScripts();

      const claudeSettingsPath = path.join(os.homedir(), ".claude", "settings.json");
      const hooksCfg = getClaudeHooksConfig(hookPath);
      const statusLineCfg = getClaudeStatusLineConfig(statusLinePath);
      await mergeSettingsFile(claudeSettingsPath, { ...hooksCfg, ...statusLineCfg });

      const geminiSettingsPath = path.join(os.homedir(), ".gemini", "settings.json");
      const geminiCfg = getGeminiHooksConfig(hookPath);
      await mergeSettingsFile(geminiSettingsPath, geminiCfg);

      setHooksStatus({ claude: "done", gemini: "done" });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setHooksError(msg);
      setHooksStatus((prev) => ({
        claude: prev.claude === "installing" ? "error" : prev.claude,
        gemini: prev.gemini === "installing" ? "error" : prev.gemini,
      }));
    }
  }, []);

  const handleAction = useCallback((idx: number) => {
    const agent = agents[idx];
    if (!agent) return;
    if (agent.status !== "not_installed" && agent.status !== "update_available" && agent.status !== "error") return;

    setAgents((prev) => prev.map((a, j) => j === idx ? { ...a, status: "installing" as const, error: undefined } : a));

    installAgent(agent)
      .then(() => {
        // Re-check version after install
        const getInstalled = execFileAsync(agent.command, ["--version"])
          .then(({ stdout }) => {
            const match = stdout.match(SEMVER_RE);
            return match ? match[1]! : null;
          })
          .catch(() => null);

        const getLatest = getLatestVersion(agent);

        return Promise.all([getInstalled, getLatest]);
      })
      .then(([installed, latest]) => {
        let status: AgentInstallStatus;
        if (installed === null) {
          status = "not_installed";
        } else if (latest && installed === latest) {
          status = "up_to_date";
        } else if (latest && installed !== latest) {
          status = "update_available";
        } else {
          status = "up_to_date";
        }
        setAgents((prev) =>
          prev.map((a, j) =>
            j === idx ? { ...a, installedVersion: installed, latestVersion: latest, status } : a,
          ),
        );
      })
      .catch((err: unknown) => {
        const msg = err instanceof Error ? err.message : String(err);
        setAgents((prev) =>
          prev.map((a, j) =>
            j === idx ? { ...a, status: "error" as const, error: msg } : a,
          ),
        );
      });
  }, [agents]);

  const toggleMethod = useCallback((idx: number) => {
    setAgents((prev) => {
      const updated = prev.map((a, j) => {
        if (j !== idx) return a;
        const newMethod: InstallMethod = a.installMethod === "npm" ? "brew" : "npm";
        return { ...a, installMethod: newMethod, status: "checking" as const, installedVersion: null, latestVersion: null, error: undefined };
      });
      // Re-check versions for the toggled agent
      const agent = updated[idx]!;
      const getInstalled = execFileAsync(agent.command, ["--version"])
        .then(({ stdout }) => {
          const match = stdout.match(SEMVER_RE);
          return match ? match[1]! : null;
        })
        .catch(() => null);
      const getLatest = getLatestVersion(agent);
      Promise.all([getInstalled, getLatest]).then(([installed, latest]) => {
        let status: AgentInstallStatus;
        if (installed === null) status = "not_installed";
        else if (latest && installed === latest) status = "up_to_date";
        else if (latest && installed !== latest) status = "update_available";
        else status = "up_to_date";
        setAgents((p) => p.map((a, j) => j === idx ? { ...a, installedVersion: installed, latestVersion: latest, status } : a));
      });
      return updated;
    });
  }, []);

  useInput((input, key) => {
    if (!isActive) return;

    if (key.leftArrow) {
      setSubTab((t) => (t > 0 ? t - 1 : AGENT_DEFS.length - 1));
      return;
    }
    if (key.rightArrow) {
      setSubTab((t) => (t < AGENT_DEFS.length - 1 ? t + 1 : 0));
      return;
    }
    if (input === "m") {
      toggleMethod(subTab);
      return;
    }
    if (input === "h") {
      handleSetupHooks();
      return;
    }
    if (key.return) {
      handleAction(subTab);
    }
  });

  const agent = agents[subTab]!;

  return (
    <Box flexDirection="column">
      {/* Sub-tabs */}
      <Box marginBottom={1}>
        {AGENT_DEFS.map((def, i) => (
          <React.Fragment key={def.driverName}>
            {i > 0 && <Text> | </Text>}
            <Text
              bold={subTab === i}
              underline={subTab === i}
              color={subTab === i ? "cyan" : undefined}
            >
              {def.displayName}
            </Text>
          </React.Fragment>
        ))}
      </Box>

      {/* Agent info card */}
      <Box
        flexDirection="column"
        borderStyle="single"
        borderColor="gray"
        paddingX={2}
        paddingY={1}
      >
        <Text bold>{agent.displayName}</Text>
        <Box marginTop={1} flexDirection="column">
          <Text>
            Method:     <Text color="magenta" bold>{agent.installMethod === "npm" ? "npm" : "Homebrew"}</Text>
            <Text dimColor>  (m to switch)</Text>
          </Text>
          <Text>
            Installed:  {agent.status === "checking" ? "..." : agent.installedVersion ?? "not installed"}
          </Text>
          <Text>
            Latest:     {agent.status === "checking" ? "..." : agent.latestVersion ?? "unknown"}
          </Text>
        </Box>

        <Box marginTop={1}>
          {agent.status === "checking" && (
            <Text color="yellow">Checking versions...</Text>
          )}
          {agent.status === "not_installed" && (
            <Text color="cyan" bold>[ Install ]  (Enter)</Text>
          )}
          {agent.status === "update_available" && (
            <Text color="yellow" bold>[ Update ]  (Enter)</Text>
          )}
          {agent.status === "up_to_date" && (
            <Text color="green">Up to date</Text>
          )}
          {agent.status === "installing" && (
            <Text color="yellow">Installing...</Text>
          )}
          {agent.status === "error" && (
            <Box flexDirection="column">
              <Text color="red">{agent.error}</Text>
              <Text dimColor>(Enter to retry)</Text>
            </Box>
          )}
        </Box>

        {/* Sideband hooks status */}
        <Box marginTop={1} flexDirection="column">
          <Text dimColor>─── Sideband Hooks ───</Text>
          {(() => {
            const hs = agent.command === "claude" ? hooksStatus.claude : hooksStatus.gemini;
            return (
              <Box marginTop={0}>
                <Text>
                  Hooks:      {hs === "checking" ? <Text color="yellow">checking...</Text>
                    : hs === "configured" || hs === "done" ? <Text color="green">configured</Text>
                    : hs === "installing" ? <Text color="yellow">installing...</Text>
                    : hs === "error" ? <Text color="red">error</Text>
                    : <Text color="gray">not configured</Text>}
                </Text>
              </Box>
            );
          })()}
          {(() => {
            const hs = agent.command === "claude" ? hooksStatus.claude : hooksStatus.gemini;
            if (hs === "not_configured" || hs === "error") {
              return (
                <Box>
                  <Text color="cyan" bold>[ Setup Hooks ]  (h)</Text>
                </Box>
              );
            }
            if (hs === "done") {
              return <Text color="green">Hooks installed successfully</Text>;
            }
            return null;
          })()}
          {hooksError && (
            <Text color="red">{hooksError}</Text>
          )}
        </Box>
      </Box>
    </Box>
  );
}
