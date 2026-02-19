import React, { useState, useEffect } from "react";
import { Box, Text } from "ink";
import type { ScreenContent, SpanLine, Span } from "../../terminal/screen-buffer.js";
import type { AgentSession } from "../../agents/agent-session.js";

interface TerminalViewProps {
  session: AgentSession | null;
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

/** Compare two SpanLine arrays by value so React.memo can skip unchanged lines */
function spanLinesEqual(a: SpanLine, b: SpanLine): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    const sa = a[i]!;
    const sb = b[i]!;
    if (
      sa.text !== sb.text ||
      sa.fg !== sb.fg ||
      sa.bg !== sb.bg ||
      sa.bold !== sb.bold ||
      sa.italic !== sb.italic ||
      sa.underline !== sb.underline ||
      sa.dim !== sb.dim ||
      sa.inverse !== sb.inverse ||
      sa.strikethrough !== sb.strikethrough
    ) {
      return false;
    }
  }
  return true;
}

interface MemoizedLineProps {
  line: SpanLine;
  lineIndex: number;
}

const MemoizedLine = React.memo(
  function MemoizedLine({ line, lineIndex }: MemoizedLineProps): React.ReactElement {
    return (
      <Box key={lineIndex} flexDirection="row" height={1}>
        {line.length === 0 ? (
          <Text> </Text>
        ) : (
          line.map((span, i) => renderSpan(span, i))
        )}
      </Box>
    );
  },
  (prev, next) => spanLinesEqual(prev.line, next.line),
);

export function TerminalView({
  session,
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

  // Take exactly `height` lines — xterm viewport handles scrollback
  const visibleLines = content.slice(0, height);

  // Pad to fill pane exactly
  const paddedLines: SpanLine[] = [...visibleLines];
  while (paddedLines.length < height) {
    paddedLines.push([]);
  }

  return (
    <Box flexDirection="column" width={width} height={height}>
      {paddedLines.map((line, i) => (
        <MemoizedLine key={i} line={line} lineIndex={i} />
      ))}
    </Box>
  );
}
