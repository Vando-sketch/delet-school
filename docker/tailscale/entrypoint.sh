#!/bin/sh
set -e

# containerboot is the official image's own entrypoint (handles TS_AUTHKEY/TS_STATE_DIR/
# TS_EXTRA_ARGS login and starts tailscaled) - run it in the background so this script can
# also drain Taildrop's file queue, which containerboot has no built-in support for.
/usr/local/bin/containerboot &
CONTAINERBOOT_PID=$!

until tailscale status >/dev/null 2>&1; do
  sleep 1
done

# Enable Tailscale Serve (HTTPS termination for the web dashboard on your tailnet) if enabled
if [ "${TS_SERVE:-false}" = "true" ]; then
  SERVE_PORT="${TS_SERVE_PORT:-3000}"
  echo "Enabling Tailscale Serve reverse proxy for port $SERVE_PORT..."
  tailscale serve --bg "$SERVE_PORT" || true
fi

STAGING_DIR="${TAILDROP_STAGING_DIR:-/taildrop-staging}"
POLL_INTERVAL_MS="${TAILDROP_POLL_INTERVAL_MS:-5000}"
mkdir -p "$STAGING_DIR"

SLEEP_SECONDS=$(( POLL_INTERVAL_MS / 1000 ))
if [ "$SLEEP_SECONDS" -lt 1 ]; then
  SLEEP_SECONDS=1
fi

trap 'kill "$CONTAINERBOOT_PID" 2>/dev/null; exit 0' TERM INT

while kill -0 "$CONTAINERBOOT_PID" 2>/dev/null; do
  # `tailscale file get` moves queued Taildrop files onto disk - it queues internally rather
  # than writing straight to a folder, since this is a headless (no GUI) container.
  tailscale file get "$STAGING_DIR" || true
  sleep "$SLEEP_SECONDS"
done
