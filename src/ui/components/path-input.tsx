import React, { useState, useMemo } from "react";
import { Box, Text, useInput } from "ink";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

interface PathInputProps {
  defaultValue: string;
  onSubmit: (path: string) => void;
}

function resolveTilde(p: string): string {
  if (p === "~") return os.homedir();
  if (p.startsWith("~/")) return path.join(os.homedir(), p.slice(2));
  return p;
}

function listDirectories(inputValue: string): string[] {
  const resolved = resolveTilde(inputValue);

  let dirToRead: string;
  let prefix: string;

  if (resolved.endsWith("/")) {
    dirToRead = resolved;
    prefix = "";
  } else {
    dirToRead = path.dirname(resolved);
    prefix = path.basename(resolved).toLowerCase();
  }

  try {
    const entries = fs.readdirSync(dirToRead, { withFileTypes: true });
    const dirs = entries
      .filter((e) => e.isDirectory() && !e.name.startsWith("."))
      .map((e) => e.name)
      .filter((name) => prefix === "" || name.toLowerCase().startsWith(prefix))
      .sort();
    return dirs.map((name) => path.join(dirToRead, name));
  } catch {
    return [];
  }
}

function displayPath(fullPath: string): string {
  const home = os.homedir();
  if (fullPath === home) return "~";
  if (fullPath.startsWith(home + "/")) return "~/" + fullPath.slice(home.length + 1);
  return fullPath;
}

const MAX_VISIBLE = 6;

export function PathInput({
  defaultValue,
  onSubmit,
}: PathInputProps): React.ReactElement {
  const [value, setValue] = useState(defaultValue);
  const [cursorOffset, setCursorOffset] = useState(0); // offset from end
  const [highlightIndex, setHighlightIndex] = useState(-1);
  const [inSuggestions, setInSuggestions] = useState(false);

  const suggestions = useMemo(() => listDirectories(value), [value]);

  const scrollOffset = useMemo(() => {
    if (highlightIndex < 0) return 0;
    if (highlightIndex < MAX_VISIBLE) return 0;
    return Math.min(
      highlightIndex - MAX_VISIBLE + 1,
      Math.max(0, suggestions.length - MAX_VISIBLE),
    );
  }, [highlightIndex, suggestions.length]);

  const visibleSuggestions = suggestions.slice(
    scrollOffset,
    scrollOffset + MAX_VISIBLE,
  );

  const cursorPos = value.length - cursorOffset;

  useInput((input, key) => {
    // --- Suggestion navigation ---
    if (key.downArrow) {
      if (suggestions.length > 0) {
        setInSuggestions(true);
        setHighlightIndex((prev) =>
          prev < suggestions.length - 1 ? prev + 1 : prev,
        );
      }
      return;
    }

    if (key.upArrow) {
      if (inSuggestions) {
        if (highlightIndex <= 0) {
          setInSuggestions(false);
          setHighlightIndex(-1);
        } else {
          setHighlightIndex((prev) => prev - 1);
        }
      }
      return;
    }

    if (
      key.tab &&
      inSuggestions &&
      highlightIndex >= 0 &&
      highlightIndex < suggestions.length
    ) {
      const selected = suggestions[highlightIndex]!;
      setValue(selected + "/");
      setCursorOffset(0);
      setInSuggestions(false);
      setHighlightIndex(-1);
      return;
    }

    // --- Submit ---
    if (key.return) {
      if (
        inSuggestions &&
        highlightIndex >= 0 &&
        highlightIndex < suggestions.length
      ) {
        const selected = suggestions[highlightIndex]!;
        setValue(selected + "/");
        setCursorOffset(0);
        setInSuggestions(false);
        setHighlightIndex(-1);
      } else {
        onSubmit(resolveTilde(value));
      }
      return;
    }

    // --- Text editing (exits suggestion mode) ---
    if (key.backspace || key.delete) {
      if (cursorOffset < value.length) {
        const pos = value.length - cursorOffset;
        setValue(value.slice(0, pos - 1) + value.slice(pos));
      }
      setInSuggestions(false);
      setHighlightIndex(-1);
      return;
    }

    if (key.leftArrow) {
      setCursorOffset((prev) => Math.min(prev + 1, value.length));
      return;
    }

    if (key.rightArrow) {
      setCursorOffset((prev) => Math.max(prev - 1, 0));
      return;
    }

    // Ignore control sequences
    if (key.ctrl || key.meta || key.escape || key.tab) {
      return;
    }

    // --- Character input ---
    if (input) {
      const pos = value.length - cursorOffset;
      setValue(value.slice(0, pos) + input + value.slice(pos));
      setInSuggestions(false);
      setHighlightIndex(-1);
    }
  });

  // Render text input with cursor
  const beforeCursor = value.slice(0, cursorPos);
  const cursorChar = cursorPos < value.length ? value[cursorPos] : " ";
  const afterCursor = cursorPos < value.length ? value.slice(cursorPos + 1) : "";

  return (
    <Box flexDirection="column">
      <Text>
        <Text color="cyan">{"❯ "}</Text>
        <Text>{beforeCursor}</Text>
        <Text inverse>{cursorChar}</Text>
        <Text>{afterCursor}</Text>
      </Text>
      {suggestions.length > 0 && (
        <Box flexDirection="column" marginLeft={2}>
          {scrollOffset > 0 && <Text dimColor>{"  ↑ more"}</Text>}
          {visibleSuggestions.map((suggestion, i) => {
            const actualIndex = scrollOffset + i;
            const isHighlighted =
              inSuggestions && actualIndex === highlightIndex;
            return (
              <Text key={suggestion}>
                {isHighlighted ? (
                  <Text color="cyan" bold>
                    {"▸ " + displayPath(suggestion)}
                  </Text>
                ) : (
                  <Text dimColor>{"  " + displayPath(suggestion)}</Text>
                )}
              </Text>
            );
          })}
          {scrollOffset + MAX_VISIBLE < suggestions.length && (
            <Text dimColor>{"  ↓ more"}</Text>
          )}
        </Box>
      )}
    </Box>
  );
}
