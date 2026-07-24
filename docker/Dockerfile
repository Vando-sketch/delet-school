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
    && rm -rf /var/lib/apt/lists/*

# Dedicated venv for markitdown + weasyprint - same workaround as the old schule-loesen skill
# used for weasyprint (Debian's "externally-managed-environment" blocks a bare `pip install`).
RUN python3 -m venv /app/.venv \
    && /app/.venv/bin/pip install --quiet --no-cache-dir --upgrade pip \
    && /app/.venv/bin/pip install --quiet --no-cache-dir markitdown weasyprint

RUN groupadd -g 1001 nodejs && useradd -u 1001 -g nodejs -s /bin/false nodejs

COPY package.json package-lock.json* ./
RUN npm install --omit=dev

COPY --from=builder /app/dist ./dist
COPY docker/vorlage ./vorlage

RUN chown -R nodejs:nodejs /app

USER nodejs

# No CMD or ENTRYPOINT here — the command is supplied via docker-compose's `command:` field
