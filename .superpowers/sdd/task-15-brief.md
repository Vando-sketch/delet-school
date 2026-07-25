### Task 15: Docker infra — Debian slim base, extraction/PDF toolchain

**Files:**
- Modify: `docker/Dockerfile` (full rewrite)

**Interfaces:**
- Consumes: `docker/vorlage/template.html`, `docker/vorlage/style.css` (Task 9).
- Produces: an image where `pandoc`, `ocrmypdf`, `pdftotext`/`pdftoppm`/`pdfinfo`, and a Python venv with `markitdown`+`weasyprint` are all on `PATH`/at the config-default paths from Task 2, matching `/app/.venv/bin/...` and `/app/vorlage/...`.

Alpine's `node:20-alpine` (the current base) has genuinely poor coverage for this toolchain: `ocrmypdf` and `markitdown`/`weasyprint` are Python packages whose native dependencies (Ghostscript, qpdf, Cairo/Pango for WeasyPrint) are far more reliably available as prebuilt Debian `apt` packages than via Alpine's `apk`/musl-libc combination, which has known compatibility issues with several of these C-extension-heavy wheels. Debian's `python3-venv`, `poppler-utils`, `ocrmypdf`, `tesseract-ocr-deu`/`tesseract-ocr-eng`, `pandoc`, and `fonts-liberation` are all standard `apt` packages. This task switches the runtime stage (and, for a consistent build environment, the builder stage) to `node:20-slim`.

- [ ] **Step 1: Rewrite the Dockerfile**

```dockerfile
# Multi-stage Dockerfile for teams-task-agent ingest and worker services
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
```

- [ ] **Step 2: Build the image to confirm it succeeds**

Run: `docker compose build worker`
Expected: build completes with exit code 0. This step has no unit test — it's a container build; the manual pandoc/weasyprint render from Task 9 Step 4 is the functional verification once this is done.

- [ ] **Step 3: Commit**

```bash
git add docker/Dockerfile
git commit -m "build: switch Docker base to Debian slim, add PDF/OCR/pandoc toolchain"
```

---

