export interface Shortcut {
  key: string;
  action: string;
}

export interface ShortcutGroup {
  title: string;
  shortcuts: Shortcut[];
}

export const shortcutGroups: ShortcutGroup[] = [
  {
    title: 'Navigation',
    shortcuts: [
      { key: 'Ctrl+T', action: 'New session' },
      { key: 'Ctrl+W', action: 'Close active session' },
      { key: 'Ctrl+N / Ctrl+Down', action: 'Next session' },
      { key: 'Ctrl+P / Ctrl+Up', action: 'Previous session' },
      { key: 'Alt+1 — Alt+9', action: 'Jump to session by number' },
    ],
  },
  {
    title: 'Scrolling',
    shortcuts: [
      { key: 'Ctrl+U', action: 'Scroll up' },
      { key: 'Ctrl+D', action: 'Scroll down' },
      { key: 'Mouse Wheel', action: 'Scroll up/down' },
    ],
  },
  {
    title: 'Panels & Modals',
    shortcuts: [
      { key: 'Ctrl+S', action: 'Toggle settings panel' },
      { key: 'Ctrl+B', action: 'Toggle sidebar' },
      { key: 'Ctrl+G', action: 'Toggle help modal' },
      { key: 'Alt+A', action: 'Adopt standalone agent' },
      { key: 'Esc', action: 'Close modal / cancel dialog' },
    ],
  },
  {
    title: 'Application',
    shortcuts: [
      { key: 'Ctrl+Q', action: 'Quit' },
    ],
  },
];
