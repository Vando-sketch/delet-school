# Multi-stage Dockerfile for delet-school ingest and worker services
# Both services use the same image with different entrypoint commands (supplied via docker-compose)
#
# Debian slim (not Alpine) - ocrmypdf/markitdown/weasyprint's native dependencies (Ghostscript,
# qpdf, Cairo/Pango) are far more reliably available via apt than via Alpine's musl-libc/apk.

# === Build stage ===
FROM node:20-slim AS builder

WORKDIR /app

COPY package.json package-lock.json* ./
RUN npm install

COPY tsconfig.json ./
COPY src ./src

RUN npm run build

# === Runtime stage ===
FROM node:20-slim

WORKDIR /app

RUN apt-get update && apt-get install -y --no-install-recommends \
    poppler-utils \
    ocrmypdf \
    tesseract-ocr \
    tesseract-ocr-deu \
    tesseract-ocr-eng \
    hunspell-de-de \
    hunspell-en-us \
    pandoc \
    fonts-liberation \
    python3 \
    python3-venv \
    python3-pip \
    curl \
    ca-certificates \
    && rm -rf /var/lib/apt/lists/*

# agy (Antigravity CLI) - only `worker` actually calls it (see src/agy/index.ts), but it's
# installed into this shared image since ingest/worker are built from the same Dockerfile.
# UNVERIFIED: this installer has only been confirmed to work interactively on macOS/arm64
# (the author's local setup) - it has not been run against this Debian/Linux image. If the
# install script doesn't support this platform, this build step will fail and needs
# adjusting (e.g. pinning a specific release asset) once verified on a real Docker host.
RUN curl -fsSL https://antigravity.google/cli/install.sh | bash \
    && mv /root/.local/bin/agy /usr/local/bin/agy \
    && chmod 755 /usr/local/bin/agy

# Dedicated venv for markitdown + weasyprint - same workaround as the old schule-loesen skill
# used for weasyprint (Debian's "externally-managed-environment" blocks a bare `pip install`).
RUN python3 -m venv /app/.venv \
    && /app/.venv/bin/pip install --quiet --no-cache-dir --upgrade pip \
    && /app/.venv/bin/pip install --quiet --no-cache-dir markitdown weasyprint

RUN groupadd -g 1001 nodejs && useradd -u 1001 -g nodejs -s /bin/false -m -d /home/nodejs nodejs
# HOME must be set explicitly - `useradd -s /bin/false` gives no login shell to source a
# profile from, and agy's credential lookup is expected to resolve relative to $HOME/.gemini
# (see docker-compose.yml's agy-credentials mount on the worker service). UNVERIFIED: exact
# path agy expects has not been confirmed against a real container - see the design spec's
# "Infra changes" section.
ENV HOME=/home/nodejs

COPY package.json package-lock.json* ./
RUN npm install --omit=dev

COPY --from=builder /app/dist ./dist
COPY docker/template ./template

RUN chown -R nodejs:nodejs /app /home/nodejs

USER nodejs

# No CMD or ENTRYPOINT here — the command is supplied via docker-compose's `command:` field
