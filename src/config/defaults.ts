export const DEFAULTS = {
  ui: {
    sidebarWidth: 24,
    narrowBreakpoint: 100,
    targetFps: 30,
  },
  agents: {
    statusCheckInterval: 1000,
    detectorInterval: 5000,
  },
  connectors: {
    slack: {
      pollInterval: 2000,
      timeout: 300000,
    },
    discord: {
      timeout: 300000,
    },
    telegram: {
      timeout: 300000,
    },
  },
  relay: {
    enabled: false,
    autoConnect: true,
    defaultShareMode: "read-write" as const,
    maxReplayBufferKB: 100,
    e2eEncryption: true,
    relayUrl: "wss://api.flaio.ai",
    authUrl: "https://flaio.ai/auth/cli",
  },
} as const;
