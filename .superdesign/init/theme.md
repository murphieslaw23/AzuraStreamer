# Theme

## Compact token summary

- Current palette: `#0a0a0c` background, translucent dark panels, purple `#7c3aed` primary, blue `#2563eb` secondary, `#f8fafc` primary text, slate metadata, semantic green/amber/red/blue.
- Current typography: Inter for all UI, JetBrains Mono for utility values.
- Current radii: 8 / 12 / 16 px. Current shadow: soft 30 px black glass shadow.
- Current spacing: mostly 8 / 12 / 16 / 20 / 24 px.
- Breakpoints: 600 px compact mobile and 900 px desktop split.
- SYCO23 target delta: replace purple/blue tech glass with near-black/oil/iron/bone and one deep-crimson signal color; use condensed industrial display + neutral body + mono only for metadata; prefer squared plates and structural rails over floating rounded cards.

## Raw source: `public/style.css` tokens

```css
:root {
  --bg-main: #0a0a0c;
  --bg-panel: rgba(18, 18, 22, 0.7);
  --bg-card: rgba(30, 30, 35, 0.6);
  --bg-input: rgba(0, 0, 0, 0.3);
  --primary: #7c3aed;
  --primary-hover: #8b5cf6;
  --secondary: #2563eb;
  --text-main: #f8fafc;
  --text-muted: #94a3b8;
  --text-dim: #64748b;
  --border: rgba(255, 255, 255, 0.08);
  --border-focus: rgba(124, 58, 237, 0.5);
  --success: #10b981;
  --warning: #f59e0b;
  --danger: #ef4444;
  --info: #3b82f6;
  --radius-lg: 16px;
  --radius-md: 12px;
  --radius-sm: 8px;
  --shadow: 0 10px 30px -10px rgba(0, 0, 0, 0.5);
  --glass: blur(12px) saturate(180%);
}

body {
  font-family: 'Inter', -apple-system, BlinkMacSystemFont, sans-serif;
  background-color: var(--bg-main);
  background-image:
    radial-gradient(circle at 0% 0%, rgba(124, 58, 237, 0.1) 0%, transparent 40%),
    radial-gradient(circle at 100% 100%, rgba(37, 99, 235, 0.1) 0%, transparent 40%);
  color: var(--text-main);
  line-height: 1.5;
  min-height: 100vh;
}

@media (max-width: 600px) { /* compact header and one-column controls */ }
@media (min-width: 900px) { /* 1fr + 380px dashboard split */ }
```

No Tailwind config, CSS modules, theme provider, or dark/light theme switch exists.
