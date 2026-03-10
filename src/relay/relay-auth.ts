import http from "node:http";
import { once } from "node:events";
import { execFile } from "node:child_process";
import { settingsStore } from "../store/settings-store.js";
import {
  identifyCliUser,
  clearCliUser,
  trackCliEvent,
} from "../analytics/index.js";
import { setSentryUser, clearSentryUser } from "../analytics/sentry.js";

/**
 * Run the browser-based OAuth login flow:
 * 1. Start a local HTTP server on a random port
 * 2. Open the browser to the auth page with ?port=<port>
 * 3. Wait for the browser to redirect back with ?token=<accessToken>&refresh=<refreshToken>
 * 4. Store tokens in settings and shut down the server
 */
export async function login(): Promise<{ success: boolean; error?: string }> {
  const server = http.createServer();

  // Listen on random available port
  server.listen(0, "127.0.0.1");
  await once(server, "listening");

  const addr = server.address();
  if (!addr || typeof addr === "string") {
    server.close();
    return { success: false, error: "Failed to bind local server" };
  }
  const port = addr.port;

  const authBaseUrl = process.env.AUTH_URL || settingsStore.getState().config.relay.authUrl;
  const authUrl = `${authBaseUrl}?port=${port}`;
  process.stdout.write(`Opening browser to authenticate...\n`);
  process.stdout.write(`If the browser doesn't open, visit:\n  ${authUrl}\n\n`);

  // Open browser (best-effort — works on macOS, Linux, Windows)
  openBrowser(authUrl);

  return new Promise((resolve) => {
    const timeout = setTimeout(() => {
      server.close();
      resolve({ success: false, error: "Login timed out (5 minutes)" });
    }, 5 * 60 * 1000);

    server.on("request", (req, res) => {
      const url = new URL(req.url ?? "/", `http://127.0.0.1:${port}`);

      if (url.pathname === "/callback") {
        const token = url.searchParams.get("token");
        const refreshToken = url.searchParams.get("refresh");

        if (!token) {
          res.writeHead(400, { "Content-Type": "text/html" });
          res.end("<h2>Missing token. Please try again.</h2>");
          return;
        }

        // Store tokens
        settingsStore.getState().updateRelay({
          authToken: token,
          refreshToken: refreshToken ?? undefined,
        });

        // Success page
        res.writeHead(200, { "Content-Type": "text/html" });
        res.end(`<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Flaio — Authenticated</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
      background: #0f0f1a;
      color: #e6edf3;
      display: flex;
      justify-content: center;
      align-items: center;
      min-height: 100vh;
    }
    .card {
      background: rgba(255, 255, 255, 0.05);
      border: 1px solid rgba(255, 255, 255, 0.1);
      border-radius: 16px;
      padding: 48px;
      text-align: center;
      max-width: 400px;
    }
    .check {
      width: 48px;
      height: 48px;
      background: rgba(34, 197, 94, 0.15);
      border-radius: 50%;
      display: flex;
      align-items: center;
      justify-content: center;
      margin: 0 auto 24px;
    }
    .check svg { width: 24px; height: 24px; color: #22c55e; }
    h1 { font-size: 20px; font-weight: 600; margin-bottom: 8px; }
    p { font-size: 14px; color: #8b949e; line-height: 1.5; }
    .brand { font-size: 12px; color: #484f58; margin-top: 32px; }
  </style>
</head>
<body>
  <div class="card">
    <div class="check">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
        <polyline points="20 6 9 17 4 12"></polyline>
      </svg>
    </div>
    <h1>You're in</h1>
    <p>You can close this tab and return to your terminal.</p>
    <p class="brand">Flaio</p>
  </div>
</body>
</html>`);

        // Identify user in analytics
        const uid = extractUidFromToken(token);
        if (uid) {
          identifyCliUser(uid);
          setSentryUser(uid);
        }
        trackCliEvent("cli_auth_completed");

        clearTimeout(timeout);
        server.close();
        resolve({ success: true });
      } else {
        res.writeHead(404);
        res.end("Not found");
      }
    });
  });
}

/**
 * Clear stored auth tokens.
 */
export function logout(): void {
  clearCliUser();
  clearSentryUser();
  settingsStore.getState().updateRelay({
    authToken: undefined,
    refreshToken: undefined,
  });
}

/**
 * Check if the user has a stored auth token.
 */
export function isLoggedIn(): boolean {
  const { config } = settingsStore.getState();
  return !!config.relay.authToken;
}

/**
 * Get the stored auth token, or null if not logged in.
 */
export function getAuthToken(): string | null {
  const { config } = settingsStore.getState();
  return config.relay.authToken ?? null;
}

/** Base URL for the CLI token endpoint. */
const CLI_TOKEN_URL = "https://flaio.ai/api/auth/cli-token";

/**
 * Refresh the access token using the stored refresh token.
 * Returns the new access token, or null if refresh failed.
 */
export async function refreshAuthToken(): Promise<string | null> {
  const { config } = settingsStore.getState();
  const refreshToken = config.relay.refreshToken;
  if (!refreshToken) return null;

  try {
    const res = await fetch(process.env.CLI_TOKEN_URL || CLI_TOKEN_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        grant_type: "refresh_token",
        refresh_token: refreshToken,
      }),
    });

    if (!res.ok) return null;

    const data = (await res.json()) as {
      token?: string;
      refreshToken?: string;
    };

    if (!data.token) return null;

    // Persist the new tokens (refresh token is rotated)
    settingsStore.getState().updateRelay({
      authToken: data.token,
      refreshToken: data.refreshToken ?? refreshToken,
    });

    return data.token;
  } catch {
    return null;
  }
}

export function extractUidFromToken(token: string): string | null {
  try {
    const parts = token.split(".");
    if (parts.length !== 3) return null;
    const payload = JSON.parse(Buffer.from(parts[1], "base64url").toString());
    return (payload.user_id as string) ?? (payload.sub as string) ?? null;
  } catch {
    return null;
  }
}

export function extractEmailFromToken(token: string): string | null {
  try {
    const parts = token.split(".");
    if (parts.length !== 3) return null;
    const payload = JSON.parse(Buffer.from(parts[1], "base64url").toString());
    return (payload.email as string) ?? null;
  } catch {
    return null;
  }
}

function openBrowser(url: string): void {
  const [cmd, args]: [string, string[]] =
    process.platform === "darwin"
      ? ["open", [url]]
      : process.platform === "win32"
        ? ["cmd", ["/c", "start", "", url]]
        : ["xdg-open", [url]];

  execFile(cmd, args, () => {
    // Best effort — ignore errors
  });
}
