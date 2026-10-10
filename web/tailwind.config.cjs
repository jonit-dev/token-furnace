const path = require('node:path');

module.exports = {
  content: [path.join(__dirname, 'index.html'), path.join(__dirname, 'src/**/*.{ts,tsx}')],
  darkMode: 'media',
  theme: {
    extend: {
      colors: {
        bg: 'var(--bg)', card: 'var(--card)', ink: 'var(--ink)', muted: 'var(--muted)',
        line: 'var(--line)', chip: 'var(--chip)',
        accent: '#f97316', bar: '#4a9eff', ok: '#4ade80', hot: '#ef4444',
      },
      fontFamily: { heading: ['Inter', 'system-ui', '-apple-system', 'Segoe UI', 'sans-serif'] },
    },
  },
};
