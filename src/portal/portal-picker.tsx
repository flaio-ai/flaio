import React, { useState, useEffect } from "react";
import path from "node:path";
import os from "node:os";
import { Box, Text, useApp, useInput } from "ink";
import {
  listSessions,
  listDrivers,
  createSession,
} from "./portal-client.js";
import type { PortalSessionInfo, PortalDriverInfo } from "./shared.js";

const AGENT_ICONS: Record<string, string> = {
  claude: "◈",
  gemini: "◆",
};
const DEFAULT_ICON = "●";

const AGENT_COLORS: Record<string, string> = {
  claude: "#D97757",
  gemini: "cyan",
};

const STATUS_COLORS: Record<string, string> = {
  idle: "gray",
  starting: "yellow",
  running: "green",
  waiting_input: "#FFA500",
  exited: "red",
};

function shortenPath(fullPath: string): string {
  const home = os.homedir();
  if (fullPath === home) return "~";
  if (fullPath.startsWith(home + "/")) return "~" + fullPath.slice(home.length);
  return fullPath;
}

interface PortalPickerProps {
  onSelect: (sessionId: string) => void;
  cwd: string;
}

type Step = "sessions" | "drivers";

export function PortalPicker({
  onSelect,
  cwd,
}: PortalPickerProps): React.ReactElement {
  const { exit } = useApp();
  const [sessions, setSessions] = useState<PortalSessionInfo[] | null>(null);
  const [drivers, setDrivers] = useState<PortalDriverInfo[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [step, setStep] = useState<Step>("sessions");
  const [creating, setCreating] = useState(false);

  useEffect(() => {
    Promise.all([listSessions(), listDrivers()]).then(([s, d]) => {
      setSessions(s ?? []);
      setDrivers(d ?? []);
      setLoading(false);
    });
  }, []);

  const sortedSessions = sessions
    ? [...sessions].sort((a, b) =>
        path.basename(a.cwd).localeCompare(path.basename(b.cwd)),
      )
    : [];

  // In "sessions" step: first item is "+ New Session", then existing sessions
  const sessionItems = sortedSessions.length > 0
    ? ["__new__", ...sortedSessions.map((s) => s.id)]
    : ["__new__"];

  // In "drivers" step: installed drivers only
  const installedDrivers = drivers
    ? drivers.filter((d) => d.installed)
    : [];

  useInput((input, key) => {
    if (creating) return;

    if (key.escape) {
      if (step === "drivers") {
        setStep("sessions");
        setSelectedIndex(0);
      } else {
        exit();
      }
      return;
    }

    if (step === "sessions") {
      const count = sessionItems.length;
      if (key.upArrow) {
        setSelectedIndex((i) => (i - 1 + count) % count);
      } else if (key.downArrow) {
        setSelectedIndex((i) => (i + 1) % count);
      } else if (key.return) {
        const item = sessionItems[selectedIndex];
        if (item === "__new__") {
          if (installedDrivers.length === 0) return;
          setStep("drivers");
          setSelectedIndex(0);
        } else if (item) {
          onSelect(item);
        }
      }
    } else if (step === "drivers") {
      const count = installedDrivers.length;
      if (count === 0) return;
      if (key.upArrow) {
        setSelectedIndex((i) => (i - 1 + count) % count);
      } else if (key.downArrow) {
        setSelectedIndex((i) => (i + 1) % count);
      } else if (key.return) {
        const driver = installedDrivers[selectedIndex];
        if (driver) {
          setCreating(true);
          createSession(driver.name, cwd).then((sessionId) => {
            if (sessionId) {
              onSelect(sessionId);
            } else {
              setCreating(false);
              setStep("sessions");
              setSelectedIndex(0);
            }
          });
        }
      }
    }
  });

  if (loading) {
    return <Text dimColor>Loading sessions...</Text>;
  }

  if (creating) {
    return <Text dimColor>Creating session...</Text>;
  }

  if (step === "drivers") {
    return (
      <Box flexDirection="column">
        <Text bold>Select an agent driver:</Text>
        <Text> </Text>
        {installedDrivers.map((driver, i) => {
          const selected = i === selectedIndex;
          const icon = AGENT_ICONS[driver.name] ?? DEFAULT_ICON;
          const color = AGENT_COLORS[driver.name] ?? "white";
          return (
            <Box key={driver.name}>
              <Text color={selected ? "cyan" : undefined}>
                {selected ? "❯ " : "  "}
              </Text>
              <Text color={color}>{icon} </Text>
              <Text bold={selected}>{driver.displayName}</Text>
            </Box>
          );
        })}
        <Text> </Text>
        <Text dimColor>↑↓ navigate  Enter select  Esc back</Text>
      </Box>
    );
  }

  return (
    <Box flexDirection="column">
      <Text bold>Select a session:</Text>
      <Text> </Text>
      {sessionItems.map((item, i) => {
        const selected = i === selectedIndex;
        if (item === "__new__") {
          return (
            <Box key="__new__">
              <Text color={selected ? "cyan" : undefined}>
                {selected ? "❯ " : "  "}
              </Text>
              <Text color="green" bold={selected}>
                + New Session
              </Text>
              <Text dimColor> (starts in {shortenPath(cwd)})</Text>
            </Box>
          );
        }
        const session = sortedSessions.find((s) => s.id === item)!;
        const icon = AGENT_ICONS[session.driverName] ?? DEFAULT_ICON;
        const iconColor = AGENT_COLORS[session.driverName] ?? "white";
        const statusColor = STATUS_COLORS[session.status] ?? "gray";
        return (
          <Box key={session.id}>
            <Text color={selected ? "cyan" : undefined}>
              {selected ? "❯ " : "  "}
            </Text>
            <Text color={iconColor}>{icon} </Text>
            <Text bold={selected}>
              {path.basename(session.cwd).padEnd(16)}
            </Text>
            <Text dimColor>{session.displayName.padEnd(14)}</Text>
            <Text color={statusColor}>● {session.status.padEnd(14)}</Text>
            <Text dimColor>{shortenPath(session.cwd)}</Text>
          </Box>
        );
      })}
      <Text> </Text>
      <Text dimColor>↑↓ navigate  Enter select  Esc quit</Text>
    </Box>
  );
}
