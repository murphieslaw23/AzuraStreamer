# Page dependency trees

## `/` — Stream control dashboard

Entry: `public/index.html`

Dependencies:

- `public/style.css`
- `public/config.js`
- `public/app.js`
  - Socket.io browser client (served by backend)
  - `/api/stations`
  - `/api/nowplaying`
  - `/api/streams`
  - `/api/settings`
  - `/api/streams/start`
  - `/api/streams/:id`
  - `/api/youtube/auth`
  - `/api/twitch/auth`
- `public/warehouse-bg.jpg` (available local atmosphere asset; not currently rendered by the dashboard)
- `server/index.js` (auth gate, static serving, API contract)

## `/login.html`

Entry: `public/login.html`

Dependencies:

- embedded page CSS
- `/api/login`
- `/api/setup/status`

## `/setup.html`

Entry: `public/setup.html`

Dependencies:

- embedded page CSS
- `/api/setup`

## `/privacy.html`

Entry: `public/privacy.html`

Dependencies: embedded page CSS only.

## `/terms.html`

Entry: `public/terms.html`

Dependencies: embedded page CSS only.
