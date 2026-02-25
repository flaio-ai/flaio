import React from "react";
import { Box, Text, useInput } from "ink";

interface HelpModalProps {
  onClose: () => void;
}

const KEYBINDINGS: Array<[string, string]> = [
  ["Ctrl+T", "New session"],
  ["Ctrl+W", "Close active session"],
  ["Ctrl+Q", "Quit app"],
  ["Ctrl+S", "Toggle settings"],
  ["Ctrl+B", "Toggle sidebar"],
  ["Ctrl+N / Ctrl+Down", "Next session"],
  ["Ctrl+P / Ctrl+Up", "Previous session"],
  ["Alt+1-9", "Jump to session N"],
  ["Alt+A", "Adopt standalone agent"],
  ["Ctrl+U", "Scroll up"],
  ["Ctrl+D", "Scroll down"],
  ["Mouse Wheel", "Scroll up/down"],
  ["Shift+Drag", "Select text (terminal)"],
  ["Ctrl+G / ?", "Toggle this help"],
  ["Esc", "Close modal / cancel"],
];

const KEY_COL_WIDTH = 22;

export function HelpModal({ onClose }: HelpModalProps): React.ReactElement {
  useInput((_input, key) => {
    if (key.escape) {
      onClose();
    }
  });

  return (
    <Box
      flexDirection="column"
      alignItems="center"
      justifyContent="center"
      width="100%"
      height="100%"
    >
      <Box
        flexDirection="column"
        borderStyle="round"
        borderColor="cyan"
        paddingX={2}
        paddingY={1}
        width={52}
      >
        <Text bold color="cyan">
          Keybindings
        </Text>
        <Box marginTop={1} flexDirection="column">
          {KEYBINDINGS.map(([key, desc]) => (
            <Box key={key}>
              <Box width={KEY_COL_WIDTH}>
                <Text color="yellow">{key}</Text>
              </Box>
              <Text>{desc}</Text>
            </Box>
          ))}
        </Box>
        <Box marginTop={1}>
          <Text dimColor>Press Esc to close</Text>
        </Box>
      </Box>
    </Box>
  );
}
