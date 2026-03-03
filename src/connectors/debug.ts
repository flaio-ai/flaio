// Shared debug logging for the connector layer.
// Enabled with DEBUG=flaio* or DEBUG=*

export const DEBUG =
  typeof process !== "undefined" &&
  /flaio|agent-manager|\*/i.test(process.env.DEBUG ?? "");

export function makeDebugLog(
  prefix: string,
): (msg: string, ...args: unknown[]) => void {
  return (msg: string, ...args: unknown[]): void => {
    if (!DEBUG) return;
    const ts = new Date().toISOString().slice(11, 23);
    process.stderr.write(`[${ts}] ${prefix}: ${msg}\n`);
    for (const a of args) {
      process.stderr.write(
        `  ${typeof a === "string" ? a : JSON.stringify(a)}\n`,
      );
    }
  };
}
