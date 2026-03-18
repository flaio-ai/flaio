import type { BaseDriver } from "./drivers/base-driver.js";
import { ClaudeDriver } from "./drivers/claude-driver.js";
import { GeminiDriver } from "./drivers/gemini-driver.js";
import { CopilotDriver } from "./drivers/copilot-driver.js";

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

// Register built-in drivers
registerDriver(new ClaudeDriver());
registerDriver(new GeminiDriver());
registerDriver(new CopilotDriver());
