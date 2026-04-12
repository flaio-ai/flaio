import { describe, it, expect, vi, beforeEach } from "vitest";
import { DEFAULTS } from "../src/config/defaults.js";

function makeDefaultConfig() {
  return {
    ui: {
      sidebarWidth: DEFAULTS.ui.sidebarWidth,
      narrowBreakpoint: DEFAULTS.ui.narrowBreakpoint,
      targetFps: DEFAULTS.ui.targetFps,
      showCost: false,
    },
    connectors: {
      slack: { enabled: false, pollInterval: DEFAULTS.connectors.slack.pollInterval, timeout: DEFAULTS.connectors.slack.timeout },
      discord: { enabled: false, timeout: DEFAULTS.connectors.discord.timeout },
      telegram: { enabled: false, timeout: DEFAULTS.connectors.telegram.timeout },
    },
    agents: {
      statusCheckInterval: DEFAULTS.agents.statusCheckInterval,
      detectorInterval: DEFAULTS.agents.detectorInterval,
      claude: {} as Record<string, unknown>,
      gemini: {} as Record<string, unknown>,
    },
    relay: {
      enabled: DEFAULTS.relay.enabled,
      autoConnect: DEFAULTS.relay.autoConnect,
      defaultShareMode: DEFAULTS.relay.defaultShareMode,
      maxReplayBufferKB: DEFAULTS.relay.maxReplayBufferKB,
      e2eEncryption: DEFAULTS.relay.e2eEncryption,
      relayUrl: DEFAULTS.relay.relayUrl,
      authUrl: DEFAULTS.relay.authUrl,
    },
    worktree: {
      planning: false,
      interactivePlanning: false,
      implementation: true,
    },
    telemetry: {
      enabled: true,
      crashReports: true,
    },
  };
}

// Mock config module to avoid real file I/O
vi.mock("../src/config/config.js", async () => {
  return {
    loadConfig: vi.fn(() => makeDefaultConfig()),
    saveConfig: vi.fn(),
    getConfigPath: vi.fn(() => "/tmp/test-settings.json"),
  };
});

// Import after mocking
import { settingsStore } from "../src/store/settings-store.js";
import { saveConfig } from "../src/config/config.js";

const mockedSaveConfig = vi.mocked(saveConfig);

describe("settingsStore.updateAgentDriver", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Reset store to fresh config
    settingsStore.getState().load();
  });

  it("updates claude customCommand", () => {
    settingsStore.getState().updateAgentDriver("claude", { customCommand: "my-cmd" });

    const config = settingsStore.getState().config;
    expect(config.agents.claude.customCommand).toBe("my-cmd");
  });

  it("clears claude customCommand when set to undefined", () => {
    settingsStore.getState().updateAgentDriver("claude", { customCommand: "my-cmd" });
    settingsStore.getState().updateAgentDriver("claude", { customCommand: undefined });

    const config = settingsStore.getState().config;
    expect(config.agents.claude.customCommand).toBeUndefined();
  });

  it("preserves gemini config when updating claude", () => {
    settingsStore.getState().updateAgentDriver("gemini", { customCommand: "my-gemini" });
    settingsStore.getState().updateAgentDriver("claude", { customCommand: "my-claude" });

    const config = settingsStore.getState().config;
    expect(config.agents.gemini.customCommand).toBe("my-gemini");
    expect(config.agents.claude.customCommand).toBe("my-claude");
  });

  it("preserves claude config when updating gemini", () => {
    settingsStore.getState().updateAgentDriver("claude", { customCommand: "my-claude" });
    settingsStore.getState().updateAgentDriver("gemini", { customCommand: "my-gemini" });

    const config = settingsStore.getState().config;
    expect(config.agents.claude.customCommand).toBe("my-claude");
    expect(config.agents.gemini.customCommand).toBe("my-gemini");
  });

  it("preserves other agents fields (statusCheckInterval, detectorInterval)", () => {
    settingsStore.getState().updateAgentDriver("claude", { customCommand: "x" });

    const config = settingsStore.getState().config;
    expect(config.agents.statusCheckInterval).toBeDefined();
    expect(config.agents.detectorInterval).toBeDefined();
  });

  it("calls saveConfig after updating", () => {
    settingsStore.getState().updateAgentDriver("claude", { customCommand: "saved-cmd" });
    expect(mockedSaveConfig).toHaveBeenCalled();
  });

  it("updates gemini customCommand", () => {
    settingsStore.getState().updateAgentDriver("gemini", { customCommand: "custom-gem" });

    const config = settingsStore.getState().config;
    expect(config.agents.gemini.customCommand).toBe("custom-gem");
  });
});
