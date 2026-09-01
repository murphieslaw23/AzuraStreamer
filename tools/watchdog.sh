#!/bin/bash
# AzuraStreamer container watchdog
# Restart the container if it's been down or unhealthy for too long.
# This is the host-level safety net: docker restart policies handle
# clean crashes, but they don't catch a container that's running but
# unresponsive (e.g. wedged Node event loop on the older builds before
# the in-process self-watchdog landed).

set -e

CONTAINER="${AZURASTREAMER_CONTAINER:-azurastreamer}"
LOG_TAG="azurastreamer-watchdog"
MAX_DOWNTIME_SECONDS="${MAX_DOWNTIME_SECONDS:-300}"   # 5 minutes
HEALTH_ENDPOINT="${HEALTH_ENDPOINT:-http://localhost/api/health}"

log() {
  logger -t "$LOG_TAG" "$*" 2>/dev/null || echo "[$LOG_TAG] $*"
}

# Verify the container is running. If not, restart it.
if ! docker inspect "$CONTAINER" --format '{{.State.Running}}' 2>/dev/null | grep -q true; then
  log "container $CONTAINER not running — restarting"
  docker start "$CONTAINER" || docker run -d --name "$CONTAINER" \
    $(grep -A 50 '^services:' /root/AzuraStreamer/docker-compose.yml | head -80) || {
      log "FATAL: failed to restart $CONTAINER"
      exit 1
    }
  exit 0
fi

# Probe the in-process health endpoint. Caddy fronts /api/health on the
# host (https://freetekno.syco23.org → azurastreamer:3000), so a 200 here
# means Caddy, the Caddy→container network, AND Node are all alive.
if ! curl -fsS -m 5 "$HEALTH_ENDPOINT" > /dev/null 2>&1; then
  log "container $CONTAINER running but /api/health failed — restarting"
  docker restart "$CONTAINER"
  log "restarted $CONTAINER"
fi