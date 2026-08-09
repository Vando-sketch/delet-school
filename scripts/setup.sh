#!/usr/bin/env bash
# One-command setup: system PDF/OCR toolchain, Python venv (markitdown+weasyprint), npm
# dependencies, the Claude Code CLI, and the agy (Antigravity) CLI.
#
# Usage: ./scripts/setup.sh   (or: npm run setup)
#
# Safe to re-run - every step is idempotent (skips what's already installed/present).

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

LOG_FILE="$REPO_ROOT/setup.log"
: > "$LOG_FILE"

log() {
  local timestamp
  timestamp="$(date '+%Y-%m-%d %H:%M:%S')"
  echo "[$timestamp] $*" | tee -a "$LOG_FILE"
}

log_step() {
  log ""
  log "==> $*"
}

run_logged() {
  # Runs a command, teeing its output into the log file, while still failing the script
  # (via `set -o pipefail`) if the command itself fails.
  "$@" 2>&1 | tee -a "$LOG_FILE"
}

# Root (common in minimal containers/LXC) usually has no `sudo` binary at all, and doesn't
# need one - `sudo` would just fail with "command not found". Only prefix with sudo when
# actually not root, and only if sudo is actually present.
SUDO=()
if [ "$(id -u)" -ne 0 ]; then
  if command -v sudo >/dev/null 2>&1; then
    SUDO=(sudo)
  else
    log "Not running as root and no 'sudo' found - system package installs below will" \
      "likely fail. Re-run as root, install sudo first, or install the packages manually" \
      "(see README.md 'Setup')."
  fi
fi

log_step "delet-school setup starting (full output also written to $LOG_FILE)"

# --- 1. System PDF/OCR/pandoc toolchain -------------------------------------------------
log_step "Installing system dependencies"

if command -v apt-get >/dev/null 2>&1; then
  log "Detected apt-get (Debian/Ubuntu) - installing via apt"
  run_logged "${SUDO[@]}" apt-get update
  run_logged "${SUDO[@]}" apt-get install -y --no-install-recommends \
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
    ca-certificates
elif command -v dnf >/dev/null 2>&1; then
  log "Detected dnf (Fedora/RHEL) - installing via dnf (best-effort; the apt path above" \
    "mirrors docker/Dockerfile and is what's actually tested)"
  run_logged "${SUDO[@]}" dnf install -y \
    poppler-utils \
    ocrmypdf \
    tesseract \
    tesseract-langpack-deu \
    tesseract-langpack-eng \
    hunspell-de \
    hunspell-en \
    pandoc \
    liberation-fonts \
    python3 \
    python3-pip \
    curl \
    ca-certificates
elif command -v brew >/dev/null 2>&1; then
  log "Detected Homebrew (macOS) - installing via brew (best-effort)"
  run_logged brew install poppler ocrmypdf tesseract tesseract-lang hunspell pandoc python3
else
  log "No known package manager (apt-get/dnf/brew) found on PATH."
  log "Install manually: poppler-utils, ocrmypdf, tesseract-ocr (+deu/eng language data)," \
    "hunspell (+de_DE/en_US dictionaries), pandoc, python3. See README.md 'Setup' for the" \
    "full package list, then re-run this script - it will pick up from step 2."
fi

# --- 2. Python venv for markitdown + weasyprint ------------------------------------------
log_step "Setting up Python venv for markitdown + weasyprint"

if [ ! -x "$REPO_ROOT/.venv/bin/python" ]; then
  run_logged python3 -m venv "$REPO_ROOT/.venv"
else
  log ".venv already exists, skipping venv creation"
fi
run_logged "$REPO_ROOT/.venv/bin/pip" install --quiet --upgrade pip
run_logged "$REPO_ROOT/.venv/bin/pip" install --quiet markitdown weasyprint
log "markitdown/weasyprint installed at .venv/bin/ (matches MARKITDOWN_BIN/WEASYPRINT_BIN defaults in .env.example)"

# --- 3. Node dependencies ------------------------------------------------------------------
log_step "Installing npm dependencies"
run_logged npm install

# --- 4. Claude Code CLI (for `claude login` - Claude Agent SDK subscription auth) ---------
log_step "Installing the Claude Code CLI"

if command -v claude >/dev/null 2>&1; then
  log "claude CLI already installed ($(command -v claude)), skipping"
else
  run_logged npm install -g @anthropic-ai/claude-code
fi

# --- 5. agy (Antigravity) CLI (Gemini primary solver path) --------------------------------
log_step "Installing the agy (Antigravity) CLI"

if command -v agy >/dev/null 2>&1; then
  log "agy CLI already installed ($(command -v agy)), skipping"
else
  run_logged bash -c 'curl -fsSL https://antigravity.google/cli/install.sh | bash'
  if [ -x "$HOME/.local/bin/agy" ] && ! command -v agy >/dev/null 2>&1; then
    log "agy installed to $HOME/.local/bin/agy - add that directory to PATH if the" \
      "'agy' command isn't found in new shells."
  fi
fi

# --- 6. .env scaffold -----------------------------------------------------------------------
log_step "Setting up .env"

if [ -f "$REPO_ROOT/.env" ]; then
  log ".env already exists, leaving it untouched"
else
  cp "$REPO_ROOT/.env.example" "$REPO_ROOT/.env"
  log "Created .env from .env.example - fill in STUDENT_NAME, STUDENT_CLASS," \
    "INGEST_WATCH_DIR, and the Nextcloud/Tailscale values before running the app."
fi

log_step "Setup complete"
log "Next steps:"
log "  1. Edit .env (see README.md 'Setup' for what's required)."
log "  2. Authenticate: 'claude login' and/or 'agy' (interactive login on first run)."
log "  3. npm run dev:ingest   # in one terminal"
log "     npm run dev:worker   # in another"
log "Full log written to $LOG_FILE"
