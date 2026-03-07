export function parseSettingValue(value: string): unknown {
  if (value === "true") return true;
  if (value === "false") return false;
  if (value === "null") return null;
  const num = Number(value);
  if (!isNaN(num) && value.trim() !== "") return num;
  return value;
}

export function setNestedValue(
  obj: Record<string, unknown>,
  path: string,
  value: unknown,
): void {
  const keys = path.split(".");
  let current: Record<string, unknown> = obj;
  for (let i = 0; i < keys.length - 1; i++) {
    if (
      !(keys[i] in current) ||
      typeof current[keys[i]] !== "object" ||
      current[keys[i]] === null
    ) {
      throw new Error(`Invalid setting path: ${path}`);
    }
    current = current[keys[i]] as Record<string, unknown>;
  }
  const lastKey = keys[keys.length - 1];
  if (!(lastKey in current)) {
    throw new Error(`Unknown setting: ${path}`);
  }
  current[lastKey] = value;
}

export async function checkLatestVersion(): Promise<string | null> {
  try {
    const res = await fetch("https://registry.npmjs.org/flaio-cli/latest", {
      signal: AbortSignal.timeout(3000),
    });
    if (!res.ok) return null;
    const data = (await res.json()) as { version?: string };
    return data.version ?? null;
  } catch {
    return null;
  }
}
