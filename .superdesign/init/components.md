# Shared UI primitives

## Framework note

This is a vanilla HTML/CSS/JavaScript interface. It has no component library and no standalone component files. Reusable primitives are CSS classes in `public/style.css`, while the only HTML template is the station card in `public/index.html`.

## Button primitive

- Source: `public/style.css`
- Variants: primary, danger, ghost, YouTube, Twitch, small, full width, loading

```css
.btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 8px;
  padding: 10px 16px;
  border: none;
  border-radius: var(--radius-sm);
  font-size: 13px;
  font-weight: 600;
  cursor: pointer;
  transition: all 0.2s ease;
}
.btn--primary { background: var(--primary); color: #fff; box-shadow: 0 4px 15px -5px var(--primary); }
.btn--primary:hover { background: var(--primary-hover); transform: translateY(-1px); }
.btn--danger { background: rgba(239, 68, 68, 0.1); color: var(--danger); border: 1px solid rgba(239, 68, 68, 0.2); }
.btn--danger:hover { background: var(--danger); color: #fff; }
.btn--ghost { background: transparent; color: var(--text-muted); border: 1px solid var(--border); }
.btn--ghost:hover { background: rgba(255, 255, 255, 0.05); color: #fff; }
.btn--sm { padding: 6px 12px; font-size: 12px; border-radius: 6px; }
.btn--full { width: 100%; }
.btn--yt { background: #ff0000; color: #fff; }
.btn--tw { background: #9146ff; color: #fff; }
.btn--loading { position: relative; pointer-events: none; opacity: 0.9; }
```

## Form control primitive

- Source: `public/style.css`
- Used by stream controls and settings.

```css
.form-group { margin-bottom: 20px; }
.form-label { display: block; font-size: 13px; font-weight: 600; margin-bottom: 8px; color: var(--text-muted); }
.form-input, .form-select {
  width: 100%;
  padding: 10px 12px;
  background: var(--bg-input);
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  color: var(--text-main);
  font-size: 13px;
  outline: none;
  transition: border-color 0.2s, box-shadow 0.2s;
}
.form-input:focus, .form-select:focus {
  border-color: var(--border-focus);
  box-shadow: 0 0 0 3px rgba(124, 58, 237, 0.1);
}
```

## Status primitives

- Source: `public/style.css`
- Stable states: online, live, connecting, reconnecting, error.

```css
.badge {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 6px 12px;
  border-radius: 6px;
  font-size: 12px;
  font-weight: 600;
  border: 1px solid var(--border);
  background: rgba(255, 255, 255, 0.04);
  white-space: nowrap;
}
.badge--connecting { color: var(--text-muted); }
.badge--connected { color: var(--success); border-color: rgba(16, 185, 129, 0.3); background: rgba(16, 185, 129, 0.08); }
.badge--error { color: var(--danger); border-color: rgba(239, 68, 68, 0.3); background: rgba(239, 68, 68, 0.08); }
.chip { display: inline-flex; align-items: center; gap: 6px; padding: 4px 10px; border-radius: 999px; font-size: 10px; font-weight: 800; }
.chip--live { background: rgba(239, 68, 68, 0.1); color: var(--danger); border: 1px solid rgba(239, 68, 68, 0.2); }
.chip--online { background: rgba(16, 185, 129, 0.1); color: var(--success); border: 1px solid rgba(16, 185, 129, 0.2); }
```

## StationCard template

- Source: `public/index.html`
- Description: Legacy reusable station card kept for compatibility.

```html
<template id="tpl-station">
  <article class="station-card">
    <div class="station-card__art">
      <img class="art-img" src="" alt="Album art" />
      <div class="stream-preview" hidden>
        <img class="preview-img" src="" alt="Live Preview" />
        <div class="preview-overlay">LIVE PREVIEW</div>
      </div>
      <div class="live-badge" hidden><span class="dot dot--red"></span> LIVE</div>
    </div>
    <div class="station-card__body">
      <h3 class="station-name"></h3>
      <p class="station-desc"></p>
      <div class="stream-status-label" hidden></div>
      <div class="now-playing">
        <div class="np-label">NOW PLAYING</div>
        <div class="np-artist"></div>
        <div class="np-title"></div>
        <div class="np-progress-wrap">
          <div class="np-progress-bar"><div class="np-progress-fill"></div></div>
          <span class="np-time"></span>
        </div>
      </div>
      <div class="stream-stats" hidden>
        <div class="stream-info-grid">
          <div class="stat-box"><div class="stat-label">UPTIME</div><div class="stat-value uptime">00:00:00</div></div>
          <div class="stat-box"><div class="stat-label">BITRATE</div><div class="stat-value bitrate">0k</div></div>
          <div class="stat-box"><div class="stat-label">FPS</div><div class="stat-value fps">0</div></div>
          <div class="stat-box"><div class="stat-label">SPEED</div><div class="stat-value speed">0x</div></div>
        </div>
        <button class="btn btn--danger btn--sm btn--full btn-stop-stream">Stop Stream</button>
      </div>
      <div class="station-footer">
        <div class="listener-count"><span class="listener-num">0</span></div>
        <div class="stream-actions">
          <button class="btn btn--yt btn--sm btn-stream-yt">YT</button>
          <button class="btn btn--tw btn--sm btn-stream-tw">TW</button>
        </div>
      </div>
    </div>
  </article>
</template>
```
