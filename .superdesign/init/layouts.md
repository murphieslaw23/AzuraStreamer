# Shared layouts

The application has one monolithic authenticated shell in `public/index.html`; there are no standalone layout components. The shell is composed of a sticky header, a primary broadcast surface, an operator control rail, a log panel, and a modal settings surface.

## Authenticated shell

- Source: `public/index.html`
- Description: Sticky identity/actions header over a responsive one-column / two-column dashboard.

```html
<header class="site-header">
  <div class="header-inner">
    <div class="brand">
      <div class="brand-icon" aria-hidden="true"></div>
      <div>
        <h1 class="brand-name">AzuraStreamer</h1>
        <p class="brand-sub">Premium Live Bridge</p>
      </div>
    </div>
    <div class="header-actions">
      <div id="connection-badge" class="badge badge--connecting">
        <span class="dot"></span><span class="badge-text">Connecting…</span>
      </div>
      <button id="btn-settings" class="btn btn--ghost btn--sm">Settings</button>
      <button id="btn-refresh" class="btn btn--ghost btn--sm">Refresh</button>
      <button id="btn-logout" class="btn btn--ghost btn--sm" title="Logout">Logout</button>
      <a href="/privacy.html" class="btn btn--ghost btn--sm" title="Privacy Policy">Privacy</a>
      <a href="/terms.html" class="btn btn--ghost btn--sm" title="Terms of Use">Terms</a>
      <button id="btn-overflow" class="btn btn--ghost btn--sm" aria-label="More" aria-haspopup="true" aria-expanded="false">More</button>
    </div>
  </div>
</header>

<main class="layout dashboard">
  <div class="dashboard-primary">
    <header class="station-hero">
      <div class="station-meta">
        <h2 id="station-name-display" class="hero-title">Loading Station...</h2>
        <div class="hero-badges">
          <div id="station-online-badge" class="chip chip--online" hidden>ONLINE</div>
          <div id="station-live-badge" class="live-badge" hidden><span class="dot dot--red"></span> LIVE</div>
          <div class="listener-count"><span id="listener-num-display">0</span></div>
        </div>
      </div>
      <div id="stream-status-banner" class="stream-status-label" hidden></div>
    </header>

    <section class="media-viewport">
      <div class="viewport-main">
        <div class="preview-container">
          <img id="art-img-display" class="art-img-bg" src="" alt="" />
          <div id="preview-overlay" class="stream-preview" hidden>
            <img id="preview-img-display" class="preview-img" src="" alt="Live Preview" />
            <div class="preview-overlay-text">LIVE FEED</div>
          </div>
        </div>
        <div class="now-playing-hero">
          <div class="np-label">NOW PLAYING</div>
          <h3 id="np-title-display" class="np-title-large">—</h3>
          <p id="np-artist-display" class="np-artist-large">—</p>
          <div class="np-progress-wrap">
            <div class="np-progress-bar"><div id="np-fill-display" class="np-progress-fill"></div></div>
            <span id="np-time-display" class="np-time"></span>
          </div>
        </div>
      </div>
      <div id="stream-stats-container" class="stream-stats-bar" hidden></div>
    </section>

    <section class="card log-card">
      <div class="card-header"><h3 class="panel-title">System Logs</h3><button id="btn-clear-logs" class="btn btn--ghost btn--sm">Clear</button></div>
      <div id="log-display" class="log-viewport"></div>
    </section>
  </div>

  <aside class="dashboard-sidebar">
    <div class="card control-card">
      <div class="card-header"><h3 class="panel-title">Stream Control</h3></div>
      <div class="card-body"><form id="stream-form"><!-- platform, metadata, start/stop controls --></form></div>
    </div>
  </aside>
</main>

<div id="settings-modal" class="modal-overlay">
  <div class="modal">
    <div class="panel-header"><h2 class="panel-title">System Settings</h2><button class="btn btn--ghost btn--sm btn-close-modal">&times;</button></div>
    <form id="settings-form"><!-- connection, destination, and template settings --></form>
  </div>
</div>
```

## Responsive structure

```css
.dashboard {
  display: grid;
  grid-template-columns: 1fr;
  gap: 16px;
}
@media (min-width: 900px) {
  .dashboard { grid-template-columns: 1fr 380px; gap: 24px; }
}
.dashboard-primary { display: flex; flex-direction: column; gap: 24px; }
.dashboard-sidebar { min-width: 0; }
```
