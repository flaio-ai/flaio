import React, { useState, useSyncExternalStore } from "react";
import { Box, Text, useInput } from "ink";
import { TextInput } from "@inkjs/ui";
import { settingsStore } from "../../store/settings-store.js";

interface SettingsPanelProps {
  onClose: () => void;
}

type Section = "connectors" | "ui";

function useSettingsStore<T>(selector: (state: ReturnType<typeof settingsStore.getState>) => T): T {
  return useSyncExternalStore(
    settingsStore.subscribe,
    () => selector(settingsStore.getState()),
  );
}

export function SettingsPanel({
  onClose,
}: SettingsPanelProps): React.ReactElement {
  const config = useSettingsStore((s) => s.config);
  const [section, setSection] = useState<Section>("connectors");
  const [editingField, setEditingField] = useState<string | null>(null);

  useInput((_input, key) => {
    if (key.escape) {
      if (editingField) {
        setEditingField(null);
      } else {
        onClose();
      }
    }
    if (key.tab) {
      setSection((s) => (s === "connectors" ? "ui" : "connectors"));
    }
  });

  return (
    <Box
      flexDirection="column"
      borderStyle="round"
      borderColor="cyan"
      paddingX={2}
      paddingY={1}
      width={60}
    >
      <Text bold color="cyan">
        Settings
      </Text>

      {/* Section tabs */}
      <Box marginY={1}>
        <Text
          bold={section === "connectors"}
          underline={section === "connectors"}
          color={section === "connectors" ? "cyan" : undefined}
        >
          Connectors
        </Text>
        <Text> | </Text>
        <Text
          bold={section === "ui"}
          underline={section === "ui"}
          color={section === "ui" ? "cyan" : undefined}
        >
          UI
        </Text>
      </Box>

      {section === "connectors" && (
        <Box flexDirection="column">
          {/* Slack */}
          <Box flexDirection="column" marginBottom={1}>
            <Text bold>Slack</Text>
            <Text>
              Enabled:{" "}
              <Text color={config.connectors.slack.enabled ? "green" : "red"}>
                {config.connectors.slack.enabled ? "yes" : "no"}
              </Text>
            </Text>
            <Text dimColor>
              Channel: {config.connectors.slack.channelId ?? "(not set)"}
            </Text>
            <Text dimColor>
              Bot Token: {config.connectors.slack.botToken ? "***" : "(not set)"}
            </Text>
          </Box>

          {/* Discord */}
          <Box flexDirection="column" marginBottom={1}>
            <Text bold>Discord</Text>
            <Text>
              Enabled:{" "}
              <Text color={config.connectors.discord.enabled ? "green" : "red"}>
                {config.connectors.discord.enabled ? "yes" : "no"}
              </Text>
            </Text>
            <Text dimColor>
              Channel: {config.connectors.discord.channelId ?? "(not set)"}
            </Text>
          </Box>

          {/* Telegram */}
          <Box flexDirection="column" marginBottom={1}>
            <Text bold>Telegram</Text>
            <Text>
              Enabled:{" "}
              <Text color={config.connectors.telegram.enabled ? "green" : "red"}>
                {config.connectors.telegram.enabled ? "yes" : "no"}
              </Text>
            </Text>
            <Text dimColor>
              Chat ID: {config.connectors.telegram.chatId ?? "(not set)"}
            </Text>
          </Box>
        </Box>
      )}

      {section === "ui" && (
        <Box flexDirection="column">
          <Text>Sidebar Width: {config.ui.sidebarWidth}</Text>
          <Text>Narrow Breakpoint: {config.ui.narrowBreakpoint} cols</Text>
          <Text>Target FPS: {config.ui.targetFps}</Text>
        </Box>
      )}

      <Box marginTop={1}>
        <Text dimColor>Tab: switch section | Esc: close</Text>
      </Box>
    </Box>
  );
}
