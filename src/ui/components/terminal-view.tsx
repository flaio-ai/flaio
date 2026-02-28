import React, { useState, useEffect } from "react";
import { Box, Text } from "ink";
import type { ScreenContent, SpanLine, Span } from "../../terminal/screen-buffer.js";
import type { AgentSession } from "../../agents/agent-session.js";
import type { SessionState } from "../../store/app-store.js";

interface TerminalViewProps {
  session: AgentSession | null;
  sessionState?: SessionState;
  width: number;
  height: number;
}

// Default terminal colors for inverse rendering — when inverse is set
// but fg/bg are undefined, we need real values so the swap is visible
const DEFAULT_FG = "white";
const DEFAULT_BG = "black";

function renderSpan(span: Span, key: number): React.ReactElement | null {
  if (span.text === "") return null;

  let fg = span.fg;
  let bg = span.bg;

  if (span.inverse) {
    // Swap fg/bg, substituting defaults so the inverse is actually visible
    const realFg = fg ?? DEFAULT_FG;
    const realBg = bg ?? DEFAULT_BG;
    fg = realBg;
    bg = realFg;
  }

  return (
    <Text
      key={key}
      color={fg}
      backgroundColor={bg}
      bold={span.bold}
      italic={span.italic}
      underline={span.underline}
      dimColor={span.dim}
      strikethrough={span.strikethrough}
    >
      {span.text}
    </Text>
  );
}

function renderLine(line: SpanLine, lineIndex: number): React.ReactElement {
  return (
    <Box key={lineIndex} flexDirection="row" height={1}>
      {line.length === 0 ? (
        <Text> </Text>
      ) : (
        line.map((span, i) => renderSpan(span, i))
      )}
    </Box>
  );
}

export function TerminalView({
  session,
  sessionState,
  width,
  height,
}: TerminalViewProps): React.ReactElement {
  const [content, setContent] = useState<ScreenContent>([]);

  useEffect(() => {
    if (!session) return;

    const onContent = (newContent: ScreenContent) => {
      setContent(newContent);
    };

    session.on("content", onContent);
    setContent(session.getContent());

    return () => {
      session.off("content", onContent);
    };
  }, [session]);

  if (!session) {
    return (
      <Box
        flexDirection="column"
        alignItems="center"
        justifyContent="center"
        width={width}
        height={height}
      >
        <Text dimColor>No active session</Text>
        <Text dimColor>Press Ctrl+T to create a new session</Text>
      </Box>
    );
  }

  // Check if this session is non-interactive (print mode)
  const isNonInteractive = sessionState?.interactive === false;

  // Take exactly `height` lines — xterm viewport handles scrollback
  const visibleLines = content.slice(0, height);

  // Pad to fill pane exactly
  const paddedLines: SpanLine[] = [...visibleLines];
  while (paddedLines.length < height) {
    paddedLines.push([]);
  }

  return (
    <Box flexDirection="column" width={width} height={height}>
      {isNonInteractive && (
        <Box
          flexDirection="column"
          alignItems="center"
          justifyContent="center"
          width={width}
          height={height}
          position="absolute"
        >
          <Box
            flexDirection="column"
            alignItems="center"
            borderStyle="round"
            borderColor="#7c3aed"
            paddingX={3}
            paddingY={1}
          >
            <Text color="#7c3aed" bold>
              ◈ Non-Interactive Session
            </Text>
            <Text dimColor> </Text>
            <Text dimColor>This session is running in print mode.</Text>
            {sessionState?.command && (
              <Text dimColor>{sessionState.command}</Text>
            )}
          </Box>
        </Box>
      )}
      {paddedLines.map((line, i) => renderLine(line, i))}
    </Box>
  );
}
