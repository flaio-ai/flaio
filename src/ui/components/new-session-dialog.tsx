import React, { useState } from "react";
import { Box, Text, useInput } from "ink";
import { Select, TextInput } from "@inkjs/ui";
import { getAllDrivers } from "../../agents/agent-registry.js";

interface NewSessionDialogProps {
  onSubmit: (driverName: string, cwd: string) => void;
  onCancel: () => void;
}

type Step = "select-agent" | "enter-cwd";

export function NewSessionDialog({
  onSubmit,
  onCancel,
}: NewSessionDialogProps): React.ReactElement {
  const [step, setStep] = useState<Step>("select-agent");
  const [selectedDriver, setSelectedDriver] = useState<string>("");
  const drivers = getAllDrivers();

  useInput((_input, key) => {
    if (key.escape) {
      onCancel();
    }
  });

  if (step === "select-agent") {
    const options = drivers.map((d) => ({
      label: d.displayName,
      value: d.name,
    }));

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
        <Box marginTop={1}>
          <Select
            options={options}
            onChange={(value) => {
              setSelectedDriver(value);
              setStep("enter-cwd");
            }}
          />
        </Box>
        <Text dimColor>Esc to cancel</Text>
      </Box>
    );
  }

  return (
    <Box
      flexDirection="column"
      borderStyle="round"
      borderColor="cyan"
      paddingX={2}
      paddingY={1}
    >
      <Text bold color="cyan">
        New Session — {drivers.find((d) => d.name === selectedDriver)?.displayName}
      </Text>
      <Text dimColor>Working directory:</Text>
      <Box marginTop={1}>
        <TextInput
          defaultValue={process.cwd()}
          onSubmit={(cwd) => {
            onSubmit(selectedDriver, cwd || process.cwd());
          }}
        />
      </Box>
      <Text dimColor>Enter to confirm, Esc to cancel</Text>
    </Box>
  );
}
