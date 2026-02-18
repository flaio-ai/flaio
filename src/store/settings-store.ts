import { createStore } from "zustand/vanilla";
import { loadConfig, saveConfig, type AppConfig } from "../config/config.js";

export interface SettingsState {
  config: AppConfig;
  loaded: boolean;

  load: () => void;
  save: () => void;
  update: (patch: Partial<AppConfig>) => void;
  updateConnector: (
    name: "slack" | "discord" | "telegram",
    patch: Record<string, unknown>,
  ) => void;
  updateUi: (patch: Record<string, unknown>) => void;
}

export const settingsStore = createStore<SettingsState>((set, get) => ({
  config: loadConfig(),
  loaded: false,

  load: () => {
    const config = loadConfig();
    set({ config, loaded: true });
  },

  save: () => {
    saveConfig(get().config);
  },

  update: (patch) => {
    set((prev) => ({
      config: { ...prev.config, ...patch },
    }));
    get().save();
  },

  updateConnector: (name, patch) => {
    set((prev) => ({
      config: {
        ...prev.config,
        connectors: {
          ...prev.config.connectors,
          [name]: {
            ...prev.config.connectors[name],
            ...patch,
          },
        },
      },
    }));
    get().save();
  },

  updateUi: (patch) => {
    set((prev) => ({
      config: {
        ...prev.config,
        ui: {
          ...prev.config.ui,
          ...patch,
        },
      },
    }));
    get().save();
  },
}));
