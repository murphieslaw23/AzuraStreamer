# Extractable components

The frontend is monolithic vanilla HTML, so there are no standalone React/Vue/Svelte layout components to convert into durable DraftComponents. Use the source files directly as design context. Simple primitives are intentionally not extracted.

## SiteHeader

- Source: `public/index.html`
- Category: layout
- Description: Identity, connection state, settings, refresh, logout, legal links, compact overflow menu.
- Extractable props: `connectionState` (string, default `connecting`), `showOverflow` (boolean, default `false`)
- Hardcoded: current inline SVG mark, labels, utility icons, routes, CSS classes.
- Extraction decision: skip; the requested redesign replaces the current generic identity treatment and there is no approved logo file in the repository.

## BroadcastControlRail

- Source: `public/index.html`
- Category: layout
- Description: Platform selection, optional manual key, metadata, visibility, and start/stop controls.
- Extractable props: `isLive` (boolean, default `false`), `platform` (string, default `youtube`)
- Hardcoded: field labels, input structure, control IDs, platform icons.
- Extraction decision: skip; page-specific and tightly coupled to stable DOM IDs consumed by `public/app.js`.

## StationCard

- Source: `public/index.html` (`#tpl-station`)
- Category: basic
- Description: Legacy station summary with art, now playing, status, stats, and destination actions.
- Extractable props: `isLive` (boolean, default `false`), `listenerCount` (number, default `0`)
- Hardcoded: labels, status structure, buttons, CSS classes.
- Extraction decision: skip; not part of the active single-station render branch.
