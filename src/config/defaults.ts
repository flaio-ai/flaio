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
} as const;
