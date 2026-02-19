export interface NavItem {
  title: string;
  href: string;
  children?: NavItem[];
}

export const docsNavigation: NavItem[] = [
  { title: 'Getting Started', href: '/docs' },
  { title: 'Installation', href: '/docs/installation' },
  { title: 'Configuration', href: '/docs/configuration' },
  { title: 'Keyboard Shortcuts', href: '/docs/keyboard-shortcuts' },
  {
    title: 'Connectors',
    href: '/docs/connectors',
    children: [
      { title: 'Slack', href: '/docs/connectors/slack' },
      { title: 'Discord', href: '/docs/connectors/discord' },
      { title: 'Telegram', href: '/docs/connectors/telegram' },
    ],
  },
  { title: 'Hook System', href: '/docs/hooks' },
  { title: 'Portals', href: '/docs/portals' },
  { title: 'Architecture', href: '/docs/architecture' },
  {
    title: 'Contributing',
    href: '/docs/contributing/new-drivers',
    children: [
      { title: 'Adding Drivers', href: '/docs/contributing/new-drivers' },
      { title: 'Adding Connectors', href: '/docs/contributing/new-connectors' },
    ],
  },
];

export function flatNavItems(): { title: string; href: string }[] {
  const items: { title: string; href: string }[] = [];
  for (const item of docsNavigation) {
    items.push({ title: item.title, href: item.href });
    if (item.children) {
      for (const child of item.children) {
        items.push({ title: child.title, href: child.href });
      }
    }
  }
  return items;
}
