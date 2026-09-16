# SYCO23 Multicast Control — Design System

## Product and job

This is an authenticated operator console that relays one AzuraCast station to YouTube or Twitch. The user must understand current signal state immediately, inspect now-playing data and stream health, configure a destination, then start or stop transmission with confidence. Preserve the current DOM IDs and API-backed behavior.

Primary surface: `/` stream control dashboard. Supporting surfaces: settings modal, login, setup, privacy, terms.

## Source of truth

Match Notion `SYSTEM CORRUPT / SYCO23 — Brand Book v4.0` and the approved `SYCO23 Live Signal` visual system. The public identity is SYCO23; master brand is SYSTEM CORRUPT. Tone: underground transmission, mechanical ritual, physical pressure, DIY sound-system infrastructure.

## Brand principles

- Build the composition like a mechanical totem: stacked, welded, bolted, structural.
- Use panels as slabs, plates, rails, and mounted surfaces—not a generic app dashboard.
- Preserve a strong vertical axis and side-anchored desktop composition.
- Surfaces should suggest iron, charcoal, soot, worn paint, speaker grills, stamped labels, and carved marks.
- Texture is low-opacity atmosphere behind legible controls. Glitch only communicates signal disruption.
- Never use neon rave gradients, cyan/purple tech UI, vaporwave, glossy 3D, cute/playful styling, or an equal-weight card grid.

## Palette

- Void / page: `#080807`
- Oil black: `#0d0d0b`
- Iron plate: `#171714`
- Raised steel: `#22221e`
- Bone primary: `#e8e0cf`
- Dust secondary: `#a29b8d`
- Ash dim: `#69665e`
- Structural line: `#39362f`
- Deep crimson signal: `#9e1f19`
- Hot fault edge: `#c53b2d`
- Dormant signal: `#51302b`
- Success/readiness may use restrained oxidized copper: `#5f7664`

One key color per piece. For this operator surface, deep crimson is the only dominant accent and is reserved for LIVE, ALERT, destructive action, and active signal energy. Do not color ordinary navigation or decorative surfaces red.

## Typography

- Display: `Arial Narrow`, `Roboto Condensed`, or a comparable heavy condensed system sans. Uppercase for major state and station identity only.
- Body: `Inter`, `Arial`, or a neutral sans. Sentence case for descriptive and form copy.
- Utility: `JetBrains Mono`, `IBM Plex Mono`, or monospace only for timestamps, stream IDs, bitrate, FPS, status codes, and logs.
- Avoid making the whole interface feel like a terminal.
- Fluid scale: display 28–54 px; section 15–20 px; body 13–15 px; utility 10–12 px.

## Layout

Desktop:

- Side-anchored composition, not a centered widget grid.
- Left 58–64%: mechanical live-signal stage / artwork, station identity, now playing, and live state.
- Right 36–42%: one stacked operator control rail for destination, metadata, preflight, and transmission action.
- Runtime telemetry forms a narrow structural rail below or alongside the stage.
- Logs are collapsed or visually subordinate, not an equal primary card.

Mobile portrait:

1. SYCO23 identity and connection state.
2. Mechanical live-signal artwork/state.
3. Now playing and listener state.
4. Primary transmission controls.
5. Minimal secondary navigation/settings.

Keep the active state usable without horizontal scrolling. Mobile landscape may split visual left and controls right. Support 375 px through large desktop/projection widths.

## Shape and depth

- Prefer 0–4 px radii; use larger rounding only for status capsules when functionally helpful.
- Use 1 px structural borders, inset shadows, seams, bolt details, and layered plate offsets.
- Avoid floating glass cards and broad soft drop shadows.
- Controls need at least 44 px touch targets on mobile.

## State language

- OFFLINE: monochrome/bone; dormant crimson indicator; almost no distortion.
- LIVE: controlled crimson signal bars/pulse; restrained scanline; fixed totem and typography.
- ALERT / reconnecting / error: stronger but brief signal tear or fault band; fixed composition.
- State must not depend on color alone. Pair color with label, icon/shape, and copy.
- Totem/art geometry and primary typography never move between states.

## Components

- Identity rail: `SYSTEM CORRUPT` eyebrow, `SYCO23` display name, `MULTICAST CONTROL` utility label.
- Connection indicator: compact label plus physical signal lamp.
- Broadcast stage: 16:9 visual field using the approved mechanical-totem imagery or album art, with robust fallback.
- Now-playing block: title first, artist second, progress/time as utility metadata.
- Operator rail: clearly labeled destination selection, key behavior, title, description, visibility, preflight cues, and one dominant `ARM TRANSMISSION` / `START TRANSMISSION` action.
- Live stop action: destructive, confirmation-aware, visually separate from setup inputs.
- Settings: full-height plate/sheet with section grouping, sticky save action, visible close label, focus management.
- Logs: mono utility text, compact density, optional collapse; never decorative terminal cosplay.
- Toasts: concise signal/fault language, clear close control, assertive only for errors.

## Copy

Use short, functional, confident phrases. Preferred vocabulary: signal, stack, pressure, system, ritual, fault, transmission, field, overload, structure, mass, circuit, archive, unit, live, offline, output.

Examples:

- `SIGNAL OFFLINE`
- `STACK READY`
- `TRANSMISSION LIVE`
- `FAULT / RECONNECTING`
- `Arm transmission`
- `Stop transmission`
- `Keep the signal running.`

Avoid corporate marketing, hype, playful microcopy, and phrases such as “premium live bridge.”

## Motion and accessibility

- Motion is functional: a low-rate live pulse, progress movement, a short alert tear, and direct panel transitions.
- Honor `prefers-reduced-motion`; disable pulsing, scanning, displacement, and decorative transitions.
- Maintain visible keyboard focus, semantic labels, 4.5:1 body-text contrast, and non-color state cues.
- Modal must trap focus, close on Escape, restore focus, and expose accessible name/description.
- Do not hide native radio/checkbox controls in a way that removes keyboard focus.

## Asset references

Approved Picsart Drive folder: `SYCO23 Live Signal — 2026-09-07`.

- 16:9 LIVE v2: `https://gcdn.picsart.com/media-engine/c83652b3-2b45-4d93-8455-794853eb5bcc.png`
- 16:9 OFFLINE v2: `https://gcdn.picsart.com/media-engine/c235e4f6-c440-411a-88d6-84441f16937f.png`
- 16:9 ALERT v2: `https://gcdn.picsart.com/media-engine/b427f2bc-809d-479a-8890-8f6d38a2af63.png`
- 9:16 LIVE v2: `https://gcdn.picsart.com/media-engine/09fc51e2-d8ac-4265-b598-1bd5500223c0.png`
- 9:16 OFFLINE v2: `https://gcdn.picsart.com/media-engine/288feca9-fed0-4f2a-9239-2f770bc97cbd.png`
- 9:16 ALERT v2: `https://gcdn.picsart.com/media-engine/adb18606-442a-4a36-a06c-21587f8cc273.png`

These are reference/content assets, not a logo. Do not invent a new logo or replace identity with an emoji/initials.

## Implementation invariants

- Preserve all existing IDs used by `public/app.js`, including connection/status, station/now-playing, stream form, start/stop, settings, logs, toast, and modal hooks.
- Preserve same-origin API and Socket.io behavior.
- Preserve YouTube/Twitch platform semantics, manual-key option, visibility rules, template setting, OAuth/test controls, and legal routes.
- Do not expose secrets in visible copy or client logs.
- Test mobile first, then desktop and large widths.
