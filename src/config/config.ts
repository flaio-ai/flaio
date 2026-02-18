import { z } from "zod";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { DEFAULTS } from "./defaults.js";

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

const UiConfigSchema = z.object({
  sidebarWidth: z.number().default(DEFAULTS.ui.sidebarWidth),
  narrowBreakpoint: z.number().default(DEFAULTS.ui.narrowBreakpoint),
  targetFps: z.number().default(DEFAULTS.ui.targetFps),
});

const AppConfigSchema = z.object({
  ui: UiConfigSchema.default({}),
  connectors: z
    .object({
      slack: SlackConfigSchema.default({}),
      discord: DiscordConfigSchema.default({}),
      telegram: TelegramConfigSchema.default({}),
    })
    .default({}),
  agents: z
    .object({
      statusCheckInterval: z.number().default(DEFAULTS.agents.statusCheckInterval),
      detectorInterval: z.number().default(DEFAULTS.agents.detectorInterval),
    })
    .default({}),
});

export type AppConfig = z.infer<typeof AppConfigSchema>;
export type SlackConfig = z.infer<typeof SlackConfigSchema>;
export type DiscordConfig = z.infer<typeof DiscordConfigSchema>;
export type TelegramConfig = z.infer<typeof TelegramConfigSchema>;

const CONFIG_DIR = path.join(os.homedir(), ".config", "agent-manager");
const CONFIG_FILE = path.join(CONFIG_DIR, "settings.json");

export function loadConfig(): AppConfig {
  try {
    if (fs.existsSync(CONFIG_FILE)) {
      const raw = JSON.parse(fs.readFileSync(CONFIG_FILE, "utf-8"));
      return AppConfigSchema.parse(raw);
    }
  } catch {
    // Invalid config — use defaults
  }
  return AppConfigSchema.parse({});
}

export function saveConfig(config: AppConfig): void {
  fs.mkdirSync(CONFIG_DIR, { recursive: true });
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2) + "\n", "utf-8");
}

export function getConfigPath(): string {
  return CONFIG_FILE;
}
