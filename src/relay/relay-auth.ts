import http from "node:http";
import { once } from "node:events";
import { exec } from "node:child_process";
import { settingsStore } from "../store/settings-store.js";

/**
 * Run the browser-based OAuth login flow:
 * 1. Start a local HTTP server on a random port
 * 2. Open the browser to the auth page with ?port=<port>
 * 3. Wait for the browser to redirect back with ?token=<idToken>&refresh=<refreshToken>
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

  const authBaseUrl = settingsStore.getState().config.relay.authUrl;
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
        res.end(
          "<h2>Authenticated successfully!</h2><p>You can close this tab and return to the terminal.</p>",
        );

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

// Firebase Web API key (public — same as in the web app)
const FIREBASE_API_KEY = "AIzaSyC8QMRjys-y0VNAKp_FxdTBGwiANKUVDbI";

/**
 * Refresh the Firebase ID token using the stored refresh token.
 * Returns the new ID token, or null if refresh failed.
 */
export async function refreshAuthToken(): Promise<string | null> {
  const { config } = settingsStore.getState();
  const refreshToken = config.relay.refreshToken;
  if (!refreshToken) return null;

  try {
    const res = await fetch(
      `https://securetoken.googleapis.com/v1/token?key=${FIREBASE_API_KEY}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: `grant_type=refresh_token&refresh_token=${encodeURIComponent(refreshToken)}`,
      },
    );

    if (!res.ok) return null;

    const data = (await res.json()) as {
      id_token?: string;
      refresh_token?: string;
    };

    if (!data.id_token) return null;

    // Persist the new tokens
    settingsStore.getState().updateRelay({
      authToken: data.id_token,
      refreshToken: data.refresh_token ?? refreshToken,
    });

    return data.id_token;
  } catch {
    return null;
  }
}

function openBrowser(url: string): void {
  const cmd =
    process.platform === "darwin"
      ? `open "${url}"`
      : process.platform === "win32"
        ? `start "" "${url}"`
        : `xdg-open "${url}"`;

  exec(cmd, () => {
    // Best effort — ignore errors
  });
}
