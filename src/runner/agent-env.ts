// ---------------------------------------------------------------------------
// Provider key → agent session env (cloud runner only).
//
// The key lives in runner memory. It reaches the agent process only through
// the explicit env of that one PTY spawn, named in the pty-manager's allow
// marker; it is never put in argv, process.env or any file.
// ---------------------------------------------------------------------------

import type { JobSecrets } from "../contracts/agent-loop.js";
import { OPENCODE } from "../agents/drivers/opencode-driver.js";
import { ALLOW_SECRET_ENV_MARKER } from "../terminal/pty-manager.js";

export function providerSessionEnv(secrets: Pick<JobSecrets, "provider" | "providerApiKey">): Record<string, string> {
  const spec = OPENCODE.providers[secrets.provider];
  if (!spec) throw new Error(`Unsupported model provider "${String(secrets.provider)}"`);
  return {
    [spec.keyEnv]: secrets.providerApiKey,
    [ALLOW_SECRET_ENV_MARKER]: spec.keyEnv,
  };
}
