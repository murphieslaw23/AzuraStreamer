# Deployment — split backend (IONOS) and dashboard (Vercel)

| Half | Where | What runs there |
|---|---|---|
| Backend | IONOS VPS, Docker | Express + Socket.io, FFmpeg stream rendering, SQLite, AzuraCast polling |
| Dashboard | Vercel | The static files in `public/` |

FFmpeg processes, a persistent SQLite database and long-lived Socket.io
connections cannot run on Vercel, so it hosts only the static dashboard.

## How the two halves talk

`vercel.json` proxies `/api/*` and `/socket.io/*` from the dashboard origin to
`${AZURA_API_ORIGIN}`. The browser sees one origin, so the dashboard's relative
`fetch()` calls and the session cookie keep working with no CORS involved.

The Socket.io **connection** is the exception: WebSocket upgrades do not survive
a proxy rewrite, so the client dials the backend origin directly using the
`apiOrigin` value in `public/config.js`, which the deploy workflow generates.
Because that connection is cross-site and carries the session cookie, the
backend switches the cookie to `SameSite=None; Secure` and enables Socket.io
CORS for exactly the configured origins whenever `PUBLIC_APP_ORIGINS` is set.

```
browser ──── /api/*, /socket.io/socket.io.js ──▶ Vercel ──▶ https://api.example.org
        └─── socket.io connection ─────────────────────────▶ https://api.example.org (direct)
```

Leaving `PUBLIC_APP_ORIGINS` empty keeps the all-in-one behaviour: the backend
serves the dashboard itself, the cookie stays `SameSite=Lax`, and Socket.io
accepts same-origin connections only.

## One-time IONOS setup

1. Provision a VPS (Ubuntu/Debian) and run `sudo ./install.sh` to install Docker
   and FFmpeg, or install them yourself.
2. Create the application directory, e.g. `/opt/azurastreamer`, owned by the
   deploy user.
3. Copy `.env.example` to `/opt/azurastreamer/.env` and fill it in. Generate
   `SESSION_SECRET` with `openssl rand -hex 32`, and set `PUBLIC_APP_ORIGINS` to
   the Vercel dashboard origin. The deploy workflow never overwrites this file;
   it only rewrites the `AZURA_IMAGE` line.
4. Put a TLS reverse proxy (Caddy or nginx + Let's Encrypt) in front of the
   loopback port on the public API hostname. **TLS is mandatory**: the dashboard
   is served over HTTPS, browsers block calls from it to an HTTP origin, and
   `SameSite=None` cookies are rejected without `Secure`. The proxy must forward
   `Upgrade`/`Connection` headers so Socket.io can establish a WebSocket.
5. Add the deploy user's public key to `~/.ssh/authorized_keys`.

## Sharing the VPS with the SYCO23 v5 runtime

If you deploy onto `87.106.219.4`, that host is owned by the SYCO23 Multicast
Control v5 deploy bundle, which runs its own Caddy bound to ports 80, 443 and
443/udp and serves `api.syco23.org`.

This backend is already built to coexist: `compose.prod.yml` binds only to
loopback (`127.0.0.1:${AZURA_BIND_PORT}`) and expects an external reverse proxy.
It must **not** be given its own Caddy or nginx on that host — the second one to
start would fail to bind, and forcing it would take the v5 runtime off the air.

To integrate, give this backend its own hostname (for example
`azura.syco23.org`, DNS pointed at the same IP) and add a second site block to
the bundle's Caddyfile at `/opt/syco23-multicast-control/current/Caddyfile`:

```caddyfile
azura.syco23.org {
  encode zstd gzip
  reverse_proxy host.docker.internal:3000 {
    flush_interval -1
  }
}
```

Reach the loopback port from inside the Caddy container by adding
`extra_hosts: ["host.docker.internal:host-gateway"]` to that Caddy service, or
put both stacks on a shared Docker network and proxy to the container name
instead. Reload with `docker compose up -d` in the bundle's directory — never
`down -v`, which would destroy the v5 SQLite and Caddy certificate volumes.

The `Upgrade`/`Connection` forwarding that Socket.io needs is handled by Caddy's
`reverse_proxy` automatically.

## GitHub secrets

| Secret | Purpose |
|---|---|
| `IONOS_HOST` | VPS hostname or IP |
| `IONOS_USER` | SSH user with Docker access |
| `IONOS_SSH_KEY` | Private key for that user |
| `IONOS_SSH_PORT` | Optional, defaults to 22 |
| `IONOS_SSH_KNOWN_HOSTS` | Optional; pins the host key. Without it the workflow falls back to trust-on-first-use |
| `IONOS_APP_DIR` | Application directory, e.g. `/opt/azurastreamer` |
| `IONOS_API_HEALTH_URL` | Optional; public health URL verified after rollout |
| `VERCEL_TOKEN`, `VERCEL_ORG_ID`, `VERCEL_PROJECT_ID` | Dashboard deployment |

GHCR uses the built-in `GITHUB_TOKEN`; no registry secret is needed.

## Check the Vercel Git integration before enabling the workflow

`deploy-frontend-vercel.yml` should be the single owner of dashboard
deployments. A Vercel project named `azura-streamer` already exists and holds
the `azura-streamer.vercel.app` alias from a one-off production deployment.

It does **not** appear to be Git-connected — pushes to this repository produce
no Vercel deployments or PR checks, unlike the sibling SYCO23 repository. Treat
that as an observation rather than a guarantee and confirm in **Vercel →
project → Settings → Git** before enabling the workflow.

If a Git integration is connected, disconnect it. Otherwise every push deploys
twice from two different build paths, racing for the same production alias —
and the Git integration's build does **not** generate `public/config.js`, so the
dashboard it publishes would have no backend origin and the connection badge
would never leave "Disconnected".

## Vercel project variables

| Variable | Purpose | Example |
|---|---|---|
| `AZURA_API_ORIGIN` | Expanded per request by the proxy routes, and read back at deploy time to generate `public/config.js` | `https://api.example.org` |

It is defined once, in Vercel project settings — the workflow reads it back via
`vercel pull` rather than duplicating it as a GitHub secret.

## Rollout behaviour

`deploy-backend-ionos.yml` builds and pushes the image to GHCR, then deploys the
**immutable digest**. On the VPS, `deploy.sh` records the outgoing image, pulls
the new one, waits up to 120s for the container healthcheck, and **restores the
previous image if the new release does not become healthy**.

To redeploy an image that already exists, run the workflow manually with
`image_tag`; the build job is skipped.

## Health endpoint

`GET /api/health` reports process liveness and whether AzuraCast is configured.
It deliberately does **not** contact AzuraCast — an unreachable upstream is an
operational condition for the UI to surface, not a reason to declare the process
dead and trigger a rollback. The container healthcheck and the rollout gate both
use it.

```bash
curl --fail http://127.0.0.1:3000/api/health     # on the VPS
curl --fail https://api.example.org/api/health   # publicly
```

## Verifying a deployment

The dashboard is working end to end when station data loads (proxied REST) *and*
the connection badge reads "Connected" (direct Socket.io). If data loads but the
badge stays disconnected, check `PUBLIC_APP_ORIGINS`, that the reverse proxy
forwards upgrade headers, and that the API origin is HTTPS.
