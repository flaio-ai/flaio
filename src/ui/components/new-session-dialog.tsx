import React, { useState, useEffect, useMemo } from "react";
import { Box, Text, useInput } from "ink";
import { getAllDrivers } from "../../agents/agent-registry.js";
import type { BaseDriver } from "../../agents/drivers/base-driver.js";
import { PathInput } from "./path-input.js";

interface NewSessionDialogProps {
  onSubmit: (driverName: string, cwd: string) => void;
  onCancel: () => void;
}

type Step = "select-agent" | "enter-cwd";

interface DriverEntry {
  driver: BaseDriver;
  installed: boolean | null; // null = still checking
}

export function NewSessionDialog({
  onSubmit,
  onCancel,
}: NewSessionDialogProps): React.ReactElement {
  const [step, setStep] = useState<Step>("select-agent");
  const [selectedDriver, setSelectedDriver] = useState<string>("");
  const [entries, setEntries] = useState<DriverEntry[]>(() =>
    getAllDrivers().map((d) => ({ driver: d, installed: null })),
  );
  const [selectedIndex, setSelectedIndex] = useState(0);

  // Check installation status on mount
  useEffect(() => {
    let cancelled = false;
    for (const entry of entries) {
      entry.driver.checkInstalled().then((installed) => {
        if (cancelled) return;
        setEntries((prev) =>
          prev.map((e) =>
            e.driver.name === entry.driver.name ? { ...e, installed } : e,
          ),
        );
      });
    }
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const isLoading = entries.some((e) => e.installed === null);

  // Indices of installed (selectable) drivers
  const installedIndices = useMemo(
    () =>
      entries
        .map((e, i) => (e.installed === true ? i : -1))
        .filter((i) => i >= 0),
    [entries],
  );

  // Snap selectedIndex to nearest installed driver when results come in
  useEffect(() => {
    if (installedIndices.length > 0 && !installedIndices.includes(selectedIndex)) {
      setSelectedIndex(installedIndices[0]!);
    }
  }, [installedIndices, selectedIndex]);

  useInput((_input, key) => {
    if (key.escape) {
      onCancel();
      return;
    }

    if (step !== "select-agent") return;

    if (key.downArrow) {
      // Find next installed index after current
      const next = installedIndices.find((i) => i > selectedIndex);
      if (next !== undefined) setSelectedIndex(next);
      return;
    }

    if (key.upArrow) {
      // Find previous installed index before current
      const prev = [...installedIndices].reverse().find((i) => i < selectedIndex);
      if (prev !== undefined) setSelectedIndex(prev);
      return;
    }

    if (key.return && !isLoading) {
      const entry = entries[selectedIndex];
      if (entry && entry.installed) {
        setSelectedDriver(entry.driver.name);
        setStep("enter-cwd");
      }
    }
  });

  if (step === "select-agent") {
    return (
      <Box
        flexDirection="column"
        borderStyle="round"
        borderColor="cyan"
        paddingX={2}
        paddingY={1}
      >
        <Text bold color="cyan">
          New Session
        </Text>
        <Text dimColor>Select an agent:</Text>
        <Box flexDirection="column" marginTop={1}>
          {isLoading && <Text color="yellow">⠋ Checking installed agents…</Text>}
          {entries.map((entry, i) => {
            const isSelected = i === selectedIndex;
            const isInstalled = entry.installed === true;
            const isPending = entry.installed === null;

            if (isPending && !isLoading) return null;

            if (isInstalled) {
              return (
                <Text key={entry.driver.name}>
                  <Text color="cyan" bold={isSelected}>
                    {isSelected ? "▸ " : "  "}
                  </Text>
                  <Text bold={isSelected}>{entry.driver.displayName}</Text>
                </Text>
              );
            }

            return (
              <Text key={entry.driver.name} dimColor>
                {"  "}
                {entry.driver.displayName}
                {isPending ? " (checking…)" : " (not installed)"}
              </Text>
            );
          })}
        </Box>
        <Box marginTop={1}>
          <Text dimColor>↑↓ navigate · Enter select · Esc cancel</Text>
        </Box>
      </Box>
    );
  }

  const driverDisplayName = entries.find(
    (e) => e.driver.name === selectedDriver,
  )?.driver.displayName;

  return (
    <Box
      flexDirection="column"
      borderStyle="round"
      borderColor="cyan"
      paddingX={2}
      paddingY={1}
    >
      <Text bold color="cyan">
        New Session — {driverDisplayName}
      </Text>
      <Text dimColor>Working directory:</Text>
      <Box marginTop={1}>
        <PathInput
          defaultValue={process.cwd()}
          onSubmit={(cwd) => {
            onSubmit(selectedDriver, cwd || process.cwd());
          }}
        />
      </Box>
      <Box marginTop={1}>
        <Text dimColor>↓ suggestions · Tab accept · Enter confirm · Esc cancel</Text>
      </Box>
    </Box>
  );
}
