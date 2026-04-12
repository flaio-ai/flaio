import type { BaseDriver } from "./drivers/base-driver.js";
import { ClaudeDriver } from "./drivers/claude-driver.js";
import { GeminiDriver } from "./drivers/gemini-driver.js";
import { settingsStore } from "../store/settings-store.js";

const drivers: Map<string, BaseDriver> = new Map();

export function registerDriver(driver: BaseDriver): void {
  drivers.set(driver.name, driver);
}

export function getDriver(name: string): BaseDriver | undefined {
  return drivers.get(name);
}

export function getAllDrivers(): BaseDriver[] {
  return Array.from(drivers.values());
}

export async function getInstalledDrivers(): Promise<BaseDriver[]> {
  const results: BaseDriver[] = [];
  for (const driver of drivers.values()) {
    if (await driver.checkInstalled()) {
      results.push(driver);
    }
  }
  return results;
}

/**
 * Syncs driver custom commands from the settings store.
 * Call once after settingsStore.load(). Subscribes to future changes
 * so that drivers pick up config changes from the Settings UI.
 */
export function initDriverConfigs(): void {
  const syncCustomCommands = (): void => {
    const { agents } = settingsStore.getState().config;

    const claude = getDriver("claude") as ClaudeDriver | undefined;
    if (claude) {
      claude.setCustomCommand(agents.claude?.customCommand);
    }

    const gemini = getDriver("gemini") as GeminiDriver | undefined;
    if (gemini) {
      gemini.setCustomCommand(agents.gemini?.customCommand);
    }
  };

  syncCustomCommands();
  settingsStore.subscribe(syncCustomCommands);
}

// Register built-in drivers
registerDriver(new ClaudeDriver());
registerDriver(new GeminiDriver());
