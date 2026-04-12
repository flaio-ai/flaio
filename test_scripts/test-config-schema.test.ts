import { describe, it, expect } from "vitest";
import { z } from "zod";
import { DEFAULTS } from "../src/config/defaults.js";

// Recreate the schemas locally to test them in isolation without file I/O side effects.
// These mirror the schemas in src/config/config.ts exactly.

const ClaudeAgentConfigSchema = z.object({
  customCommand: z.string().optional(),
});

const GeminiAgentConfigSchema = z.object({
  customCommand: z.string().optional(),
});

const AgentsSchema = z.object({
  statusCheckInterval: z.number().default(DEFAULTS.agents.statusCheckInterval),
  detectorInterval: z.number().default(DEFAULTS.agents.detectorInterval),
  claude: ClaudeAgentConfigSchema.default(() => ClaudeAgentConfigSchema.parse({})),
  gemini: GeminiAgentConfigSchema.default(() => GeminiAgentConfigSchema.parse({})),
});

const UiConfigSchema = z.object({
  sidebarWidth: z.number().default(DEFAULTS.ui.sidebarWidth),
  narrowBreakpoint: z.number().default(DEFAULTS.ui.narrowBreakpoint),
  targetFps: z.number().default(DEFAULTS.ui.targetFps),
  showCost: z.boolean().default(false),
});

const SlackConfigSchema = z.object({
  enabled: z.boolean().default(false),
  botToken: z.string().optional(),
  appToken: z.string().optional(),
  channelId: z.string().optional(),
  pollInterval: z.number().default(DEFAULTS.connectors.slack.pollInterval),
  timeout: z.number().default(DEFAULTS.connectors.slack.timeout),
});

const DiscordConfigSchema = z.object({
  enabled: z.boolean().default(false),
  botToken: z.string().optional(),
  channelId: z.string().optional(),
  timeout: z.number().default(DEFAULTS.connectors.discord.timeout),
});

const TelegramConfigSchema = z.object({
  enabled: z.boolean().default(false),
  botToken: z.string().optional(),
  chatId: z.union([z.string(), z.number()]).optional(),
  timeout: z.number().default(DEFAULTS.connectors.telegram.timeout),
});

const ConnectorsSchema = z.object({
  slack: SlackConfigSchema.default(() => SlackConfigSchema.parse({})),
  discord: DiscordConfigSchema.default(() => DiscordConfigSchema.parse({})),
  telegram: TelegramConfigSchema.default(() => TelegramConfigSchema.parse({})),
});

const RelayConfigSchema = z.object({
  enabled: z.boolean().default(DEFAULTS.relay.enabled),
  authToken: z.string().optional(),
  refreshToken: z.string().optional(),
  autoConnect: z.boolean().default(DEFAULTS.relay.autoConnect),
  defaultShareMode: z
    .enum(["read-only", "read-write"])
    .default(DEFAULTS.relay.defaultShareMode),
  maxReplayBufferKB: z.number().default(DEFAULTS.relay.maxReplayBufferKB),
  e2eEncryption: z.boolean().default(DEFAULTS.relay.e2eEncryption),
  relayUrl: z.string().default(DEFAULTS.relay.relayUrl),
  authUrl: z.string().default(DEFAULTS.relay.authUrl),
});

const WorktreeConfigSchema = z.object({
  planning: z.boolean().default(false),
  interactivePlanning: z.boolean().default(false),
  implementation: z.boolean().default(true),
});

const TelemetryConfigSchema = z.object({
  enabled: z.boolean().default(true),
  crashReports: z.boolean().default(true),
});

const AppConfigSchema = z.object({
  ui: UiConfigSchema.default(() => UiConfigSchema.parse({})),
  connectors: ConnectorsSchema.default(() => ConnectorsSchema.parse({})),
  agents: AgentsSchema.default(() => AgentsSchema.parse({})),
  relay: RelayConfigSchema.default(() => RelayConfigSchema.parse({})),
  worktree: WorktreeConfigSchema.default(() => WorktreeConfigSchema.parse({})),
  telemetry: TelemetryConfigSchema.default(() => TelemetryConfigSchema.parse({})),
});

describe("AppConfig Zod schema — backward compatibility", () => {
  it("parses empty object (no agents field) with defaults", () => {
    const config = AppConfigSchema.parse({});
    expect(config.agents).toBeDefined();
    expect(config.agents.claude).toBeDefined();
    expect(config.agents.gemini).toBeDefined();
    expect(config.agents.claude.customCommand).toBeUndefined();
    expect(config.agents.gemini.customCommand).toBeUndefined();
  });

  it("parses config without agents.claude field", () => {
    const config = AppConfigSchema.parse({
      agents: { statusCheckInterval: 2000 },
    });
    expect(config.agents.claude).toBeDefined();
    expect(config.agents.claude.customCommand).toBeUndefined();
    expect(config.agents.statusCheckInterval).toBe(2000);
  });

  it("preserves agents.claude.customCommand when provided", () => {
    const config = AppConfigSchema.parse({
      agents: {
        claude: { customCommand: "/opt/bin/my-claude" },
      },
    });
    expect(config.agents.claude.customCommand).toBe("/opt/bin/my-claude");
  });

  it("preserves agents.gemini.customCommand when provided", () => {
    const config = AppConfigSchema.parse({
      agents: {
        gemini: { customCommand: "/opt/bin/my-gemini" },
      },
    });
    expect(config.agents.gemini.customCommand).toBe("/opt/bin/my-gemini");
  });

  it("parses config with empty agents object and populates defaults", () => {
    const config = AppConfigSchema.parse({ agents: {} });
    expect(config.agents.claude).toBeDefined();
    expect(config.agents.gemini).toBeDefined();
    expect(config.agents.statusCheckInterval).toBe(DEFAULTS.agents.statusCheckInterval);
    expect(config.agents.detectorInterval).toBe(DEFAULTS.agents.detectorInterval);
  });

  it("accepts agents.claude.customCommand as undefined", () => {
    const config = AppConfigSchema.parse({
      agents: {
        claude: { customCommand: undefined },
      },
    });
    expect(config.agents.claude.customCommand).toBeUndefined();
  });

  it("rejects invalid type for customCommand (number)", () => {
    expect(() =>
      AppConfigSchema.parse({
        agents: {
          claude: { customCommand: 42 },
        },
      }),
    ).toThrow();
  });

  it("rejects invalid type for customCommand (boolean)", () => {
    expect(() =>
      AppConfigSchema.parse({
        agents: {
          gemini: { customCommand: true },
        },
      }),
    ).toThrow();
  });

  it("other top-level sections unaffected by agents changes", () => {
    const config = AppConfigSchema.parse({
      agents: { claude: { customCommand: "x" } },
    });
    expect(config.ui.sidebarWidth).toBe(DEFAULTS.ui.sidebarWidth);
    expect(config.relay.enabled).toBe(false);
    expect(config.connectors.slack.enabled).toBe(false);
  });
});
