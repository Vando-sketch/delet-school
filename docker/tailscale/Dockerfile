# Wraps the official tailscale/tailscale image with an entrypoint that also drains Taildrop's
# file queue on an interval - see
# docs/superpowers/specs/2026-07-23-tailscale-nextcloud-decoupling-design.md
FROM tailscale/tailscale:latest

COPY docker/tailscale/entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh

ENTRYPOINT ["/entrypoint.sh"]
