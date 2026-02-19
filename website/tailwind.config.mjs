/** @type {import('tailwindcss').Config} */
export default {
  content: ['./src/**/*.{astro,html,js,jsx,md,mdx,svelte,ts,tsx,vue}'],
  theme: {
    extend: {
      colors: {
        page: '#0d1117',
        card: '#161b22',
        terminal: '#1a1b26',
        'card-hover': '#21262d',
        'text-primary': '#e6edf3',
        'text-secondary': '#8b949e',
        'brand-claude': '#D97757',
        'brand-accent': '#06B6D4',
        'status-running': '#22C55E',
        'status-waiting': '#FFA500',
        'status-error': '#EF4444',
        'connector-slack': '#4A154B',
        'connector-discord': '#5865F2',
        'connector-telegram': '#0088CC',
        'border-default': '#30363d',
        'border-accent': '#06B6D4',
      },
      fontFamily: {
        sans: ['Inter', 'system-ui', 'sans-serif'],
        mono: ['JetBrains Mono', 'Menlo', 'monospace'],
      },
    },
  },
  plugins: [],
};
