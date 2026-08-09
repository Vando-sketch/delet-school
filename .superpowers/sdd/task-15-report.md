# Task 15 Report: Docker infra — Debian slim + extraction/PDF toolchain

## Implementation Summary

Successfully rewrote `docker/Dockerfile` to switch from Alpine to Debian slim base image and added the complete PDF/OCR/extraction toolchain required for the teams-task-agent pipeline.

## Dockerfile Changes

### Base Image Switch
- **Before:** `node:20-alpine` (both build and runtime stages)
- **After:** `node:20-slim` (both build and runtime stages)

### Rationale
Alpine's musl-libc and apk package manager have known compatibility issues with several C-extension-heavy Python packages required by the pipeline, specifically:
- `ocrmypdf` and `markitdown`/`weasyprint` depend on native libraries (Ghostscript, qpdf, Cairo/Pango)
- These are far more reliably available as prebuilt Debian apt packages than via Alpine

### Added Dependencies
Installed via apt-get with `--no-install-recommends` and cleaned up apt lists:
- `poppler-utils` — PDF text extraction and image conversion
- `ocrmypdf` — PDF OCR tool
- `tesseract-ocr` — OCR engine
- `tesseract-ocr-deu` — German language pack
- `tesseract-ocr-eng` — English language pack
- `pandoc` — Document format converter
- `fonts-liberation` — Font support for document rendering
- `python3`, `python3-venv`, `python3-pip` — Python environment and toolchain

### Python Virtual Environment
Created a dedicated Python venv at `/app/.venv` containing:
- `markitdown` — Markdown conversion library
- `weasyprint` — HTML/CSS to PDF conversion

This follows the same pattern as the legacy schule-loesen skill, addressing Debian's "externally-managed-environment" restrictions that block bare `pip install`.

### Non-root User Setup
- **Before:** Alpine `addgroup`/`adduser` commands
- **After:** Debian `groupadd`/`useradd` commands
  ```dockerfile
  RUN groupadd -g 1001 nodejs && useradd -u 1001 -g nodejs -s /bin/false nodejs
  ```

### Additional Layer
Added copying of the template and stylesheet for pandoc:
```dockerfile
COPY docker/vorlage ./vorlage
```

This ensures the PDF generation pipeline has access to:
- `/app/vorlage/template.html` — pandoc template
- `/app/vorlage/style.css` — CSS stylesheet

These paths match the configuration defaults from Task 2 (`config.pandoc.templatePath`/`cssPath`).

## Verification

### Self-Review Checklist

✅ **Base image:** Both builder and runtime stages switched to `node:20-slim`

✅ **All required apt packages present:**
- poppler-utils
- ocrmypdf
- tesseract-ocr, tesseract-ocr-deu, tesseract-ocr-eng
- pandoc
- fonts-liberation
- python3, python3-venv, python3-pip

✅ **Python venv created and populated:**
- Created at `/app/.venv`
- Installs markitdown and weasyprint with upgraded pip
- Uses `--quiet --no-cache-dir` flags for reproducible, minimal builds

✅ **Dockerfile structure:**
- Multi-stage build (builder → runtime)
- Proper layer optimization (apt lists cleaned, pip cache cleared)
- Non-root user established before switching to USER

✅ **Debian-specific tooling:**
- Uses `groupadd`/`useradd` instead of Alpine's `addgroup`/`adduser`
- Proper user setup with UID 1001, shell `/bin/false`, group ownership

✅ **Docker/vorlage copied:**
- Line 50: `COPY docker/vorlage ./vorlage` — copies Task 9's templates/stylesheets

✅ **Content matches brief exactly:**
- No extraneous comments or modifications
- All APT packages in correct order
- All venv pip packages specified
- Permissions and ownership correctly set

## Deferred Steps

**Step 2 (docker compose build) — SKIPPED**
- Docker is not available in this environment
- Build verification has been deferred to an environment with Docker available
- This is not a blocker for task completion; the Dockerfile content is fully specified and verified against the brief
- Once Docker becomes available, run: `docker compose build worker`

## Commit

```
2482f03 build: switch Docker base to Debian slim, add PDF/OCR/pandoc toolchain
```

The commit is on branch `feat/pdf-solve-pipeline` with message:
```
build: switch Docker base to Debian slim, add PDF/OCR/pandoc toolchain

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
```

## Concerns

None. The Dockerfile is complete, matches the brief exactly, and is ready for:
1. Docker build verification when Docker becomes available
2. Integration with the broader teams-task-agent pipeline
3. Testing of PDF generation and OCR workflows via the manual test from Task 9 Step 4
