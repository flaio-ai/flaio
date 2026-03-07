import React, { useState, useSyncExternalStore } from "react";
import { Box, Text, useInput } from "ink";
import { TextInput } from "@inkjs/ui";
import { settingsStore } from "../../store/settings-store.js";
import { AgentsSettingsContent } from "./agents-settings-content.js";
import { login, logout, isLoggedIn } from "../../relay/relay-auth.js";
import { relayClient } from "../../store/connector-store.js";

interface SettingsPanelProps {
  onClose: () => void;
}

type Section = "connectors" | "ui" | "agents" | "relay" | "worktree";

interface FieldDef {
  label: string;
  type: "boolean" | "string" | "number";
  getValue: () => unknown;
  setValue: (v: unknown) => void;
  isToken?: boolean;
}

function useSettingsStore<T>(selector: (state: ReturnType<typeof settingsStore.getState>) => T): T {
  return useSyncExternalStore(
    settingsStore.subscribe,
    () => selector(settingsStore.getState()),
  );
}

function getConnectorFields(): FieldDef[] {
  const store = () => settingsStore.getState();
  const cfg = () => store().config;
  return [
    // Slack
    { label: "Slack: Enabled", type: "boolean", getValue: () => cfg().connectors.slack.enabled, setValue: (v) => store().updateConnector("slack", { enabled: v }) },
    { label: "Slack: Bot Token", type: "string", isToken: true, getValue: () => cfg().connectors.slack.botToken ?? "", setValue: (v) => store().updateConnector("slack", { botToken: v || undefined }) },
    { label: "Slack: App Token", type: "string", isToken: true, getValue: () => cfg().connectors.slack.appToken ?? "", setValue: (v) => store().updateConnector("slack", { appToken: v || undefined }) },
    { label: "Slack: Channel ID", type: "string", getValue: () => cfg().connectors.slack.channelId ?? "", setValue: (v) => store().updateConnector("slack", { channelId: v || undefined }) },
    { label: "Slack: Poll Interval", type: "number", getValue: () => cfg().connectors.slack.pollInterval, setValue: (v) => store().updateConnector("slack", { pollInterval: v }) },
    { label: "Slack: Timeout", type: "number", getValue: () => cfg().connectors.slack.timeout, setValue: (v) => store().updateConnector("slack", { timeout: v }) },
    // Discord
    { label: "Discord: Enabled", type: "boolean", getValue: () => cfg().connectors.discord.enabled, setValue: (v) => store().updateConnector("discord", { enabled: v }) },
    { label: "Discord: Bot Token", type: "string", isToken: true, getValue: () => cfg().connectors.discord.botToken ?? "", setValue: (v) => store().updateConnector("discord", { botToken: v || undefined }) },
    { label: "Discord: Channel ID", type: "string", getValue: () => cfg().connectors.discord.channelId ?? "", setValue: (v) => store().updateConnector("discord", { channelId: v || undefined }) },
    { label: "Discord: Timeout", type: "number", getValue: () => cfg().connectors.discord.timeout, setValue: (v) => store().updateConnector("discord", { timeout: v }) },
    // Telegram
    { label: "Telegram: Enabled", type: "boolean", getValue: () => cfg().connectors.telegram.enabled, setValue: (v) => store().updateConnector("telegram", { enabled: v }) },
    { label: "Telegram: Bot Token", type: "string", isToken: true, getValue: () => cfg().connectors.telegram.botToken ?? "", setValue: (v) => store().updateConnector("telegram", { botToken: v || undefined }) },
    { label: "Telegram: Chat ID", type: "string", getValue: () => String(cfg().connectors.telegram.chatId ?? ""), setValue: (v) => store().updateConnector("telegram", { chatId: v || undefined }) },
    { label: "Telegram: Timeout", type: "number", getValue: () => cfg().connectors.telegram.timeout, setValue: (v) => store().updateConnector("telegram", { timeout: v }) },
  ];
}

function getUiFields(): FieldDef[] {
  const store = () => settingsStore.getState();
  const cfg = () => store().config;
  return [
    { label: "Sidebar Width", type: "number", getValue: () => cfg().ui.sidebarWidth, setValue: (v) => store().updateUi({ sidebarWidth: v }) },
    { label: "Narrow Breakpoint", type: "number", getValue: () => cfg().ui.narrowBreakpoint, setValue: (v) => store().updateUi({ narrowBreakpoint: v }) },
    { label: "Target FPS", type: "number", getValue: () => cfg().ui.targetFps, setValue: (v) => store().updateUi({ targetFps: v }) },
    { label: "Show Cost", type: "boolean", getValue: () => cfg().ui.showCost, setValue: (v) => store().updateUi({ showCost: v }) },
  ];
}

function getRelayFields(): FieldDef[] {
  const store = () => settingsStore.getState();
  const cfg = () => store().config;
  return [
    { label: "Remote Access: Enabled", type: "boolean", getValue: () => cfg().relay.enabled, setValue: (v) => store().updateRelay({ enabled: v }) },
    { label: "Remote Access: Logged In", type: "boolean", getValue: () => !!cfg().relay.authToken, setValue: () => {} },
    { label: "Auto-Connect", type: "boolean", getValue: () => cfg().relay.autoConnect, setValue: (v) => store().updateRelay({ autoConnect: v }) },
    { label: "Default Share Mode", type: "string", getValue: () => cfg().relay.defaultShareMode, setValue: (v) => { if (v === "read-only" || v === "read-write") store().updateRelay({ defaultShareMode: v }); } },
    { label: "Replay Buffer (KB)", type: "number", getValue: () => cfg().relay.maxReplayBufferKB, setValue: (v) => store().updateRelay({ maxReplayBufferKB: v }) },
  ];
}

function getWorktreeFields(): FieldDef[] {
  const store = () => settingsStore.getState();
  const cfg = () => store().config;
  return [
    {
      label: "Planning",
      type: "boolean",
      getValue: () => cfg().worktree.planning,
      setValue: (v) => {
        store().update({ worktree: { ...cfg().worktree, planning: v as boolean } });
        relayClient.sendUserSettings({ planning: v as boolean });
      },
    },
    {
      label: "Interactive Planning",
      type: "boolean",
      getValue: () => cfg().worktree.interactivePlanning,
      setValue: (v) => {
        store().update({ worktree: { ...cfg().worktree, interactivePlanning: v as boolean } });
        relayClient.sendUserSettings({ interactivePlanning: v as boolean });
      },
    },
    {
      label: "Implementation",
      type: "boolean",
      getValue: () => cfg().worktree.implementation,
      setValue: (v) => {
        store().update({ worktree: { ...cfg().worktree, implementation: v as boolean } });
        relayClient.sendUserSettings({ implementation: v as boolean });
      },
    },
  ];
}

function displayValue(field: FieldDef): string {
  const val = field.getValue();
  if (field.type === "boolean") return val ? "yes" : "no";
  if (field.isToken && val) return "***";
  return String(val ?? "");
}

function FieldRow({
  field,
  focused,
  editing,
  editValue,
  onEditChange,
  onEditSubmit,
}: {
  field: FieldDef;
  focused: boolean;
  editing: boolean;
  editValue: string;
  onEditChange: (v: string) => void;
  onEditSubmit: (v: string) => void;
}): React.ReactElement {
  const hint = focused && !editing
    ? field.type === "boolean" ? " (Enter to toggle)" : " (Enter to edit)"
    : "";

  return (
    <Box>
      <Text color={focused ? "cyan" : undefined}>
        {focused ? "> " : "  "}
      </Text>
      <Box width={24}>
        <Text color={focused ? "cyan" : undefined}>{field.label}</Text>
      </Box>
      <Text> </Text>
      {editing ? (
        <TextInput
          defaultValue={editValue}
          onChange={onEditChange}
          onSubmit={onEditSubmit}
        />
      ) : (
        <Text>
          <Text color={field.type === "boolean" ? (field.getValue() ? "green" : "red") : undefined}>
            {displayValue(field)}
          </Text>
          <Text dimColor>{hint}</Text>
        </Text>
      )}
    </Box>
  );
}

export function SettingsPanel({
  onClose,
}: SettingsPanelProps): React.ReactElement {
  useSettingsStore((s) => s.config);

  const [section, setSection] = useState<Section>("connectors");
  const [focusedIndex, setFocusedIndex] = useState(0);
  const [editingField, setEditingField] = useState<number | null>(null);
  const [editValue, setEditValue] = useState("");

  const fields = section === "agents" ? [] : section === "connectors" ? getConnectorFields() : section === "relay" ? getRelayFields() : section === "worktree" ? getWorktreeFields() : getUiFields();

  useInput((input, key) => {
    if (editingField !== null) {
      if (key.escape) {
        setEditingField(null);
        setEditValue("");
      }
      return;
    }

    if (key.escape) {
      onClose();
      return;
    }

    if (key.tab) {
      setSection((s) => s === "connectors" ? "ui" : s === "ui" ? "agents" : s === "agents" ? "relay" : s === "relay" ? "worktree" : "connectors");
      setFocusedIndex(0);
      return;
    }

    if (section === "relay" && input === "l") {
      if (isLoggedIn()) {
        logout();
        settingsStore.getState().updateRelay({ enabled: false });
      } else {
        login();
      }
      return;
    }

    if (section === "agents") return;

    if (key.downArrow) {
      setFocusedIndex((i) => Math.min(i + 1, fields.length - 1));
      return;
    }

    if (key.upArrow) {
      setFocusedIndex((i) => Math.max(i - 1, 0));
      return;
    }

    if (key.return) {
      const field = fields[focusedIndex];
      if (!field) return;
      if (field.type === "boolean") {
        field.setValue(!field.getValue());
      } else {
        const raw = field.getValue();
        setEditValue(field.isToken ? "" : String(raw ?? ""));
        setEditingField(focusedIndex);
      }
    }
  });

  const handleEditSubmit = (value: string) => {
    const field = fields[editingField!];
    if (field) {
      if (field.type === "number") {
        const num = Number(value);
        if (!isNaN(num)) field.setValue(num);
      } else {
        field.setValue(value);
      }
    }
    setEditingField(null);
    setEditValue("");
  };

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
        <Text> | </Text>
        <Text
          bold={section === "agents"}
          underline={section === "agents"}
          color={section === "agents" ? "cyan" : undefined}
        >
          Agents
        </Text>
        <Text> | </Text>
        <Text
          bold={section === "relay"}
          underline={section === "relay"}
          color={section === "relay" ? "cyan" : undefined}
        >
          Remote
        </Text>
        <Text> | </Text>
        <Text
          bold={section === "worktree"}
          underline={section === "worktree"}
          color={section === "worktree" ? "cyan" : undefined}
        >
          Worktree
        </Text>
      </Box>

      <Box flexDirection="column">
        {section === "agents" ? (
          <AgentsSettingsContent isActive={section === "agents"} />
        ) : (
          fields.map((field, i) => (
            <FieldRow
              key={field.label}
              field={field}
              focused={i === focusedIndex}
              editing={i === editingField}
              editValue={editValue}
              onEditChange={setEditValue}
              onEditSubmit={handleEditSubmit}
            />
          ))
        )}
      </Box>

      <Box marginTop={1}>
        <Text dimColor>{section === "agents" ? "Tab: section | \u2190\u2192: agent | m: method | h: hooks | Enter: action | Esc: close" : section === "relay" ? "Tab: section | Up/Down: navigate | Enter: edit | l: login/logout | Esc: close" : section === "worktree" ? "Tab: section | Up/Down: navigate | Enter: edit | Esc: close" : "Tab: section | Up/Down: navigate | Enter: edit | Esc: close"}</Text>
      </Box>
    </Box>
  );
}
