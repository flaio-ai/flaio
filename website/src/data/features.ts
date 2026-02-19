export interface Feature {
  title: string;
  description: string;
  icon: string;
}

export const features: Feature[] = [
  {
    title: 'Multi-Agent Sessions',
    description: 'Run Claude Code and Gemini CLI side by side in tabbed sessions, each with a full PTY-backed terminal.',
    icon: 'tabs',
  },
  {
    title: 'Agent Adoption',
    description: 'Auto-detect standalone agents running on your system and adopt them into managed tabs with one key.',
    icon: 'adopt',
  },
  {
    title: 'Messaging Connectors',
    description: 'Forward permission requests to Slack, Discord, or Telegram. Approve from your phone, reply with prompts.',
    icon: 'message',
  },
  {
    title: 'Terminal Emulation',
    description: 'Full ANSI color, text attributes, mouse scrolling, and 1000-line scrollback via xterm-headless.',
    icon: 'terminal',
  },
  {
    title: 'Responsive Layout',
    description: 'Sidebar with session list on wide terminals, compact tab bar on narrow ones. Adapts automatically.',
    icon: 'layout',
  },
  {
    title: 'Portal System',
    description: 'Connect to running sessions from another terminal. Full mirroring, input forwarding, remote session creation.',
    icon: 'portal',
  },
];
