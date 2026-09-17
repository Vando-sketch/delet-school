#!/usr/bin/env bash
# One-command setup: system PDF/OCR toolchain, Python venv (markitdown+weasyprint+fints), npm
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
  timestamp="$(date '+%Y-%m-%d %H:%M:%S')
"
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

# --- 1.5. Tailscale client (Nextcloud reachability; NOT the Docker sidecar's Taildrop drain) --
log_step "Installing the Tailscale client"

if command -v tailscale >/dev/null 2>&1; then
  log "tailscale already installed ($(command -v tailscale)), skipping"
else
  run_logged bash -c 'curl -fsSL https://tailscale.com/install.sh | sh'
fi
log "This installs the client only - it does NOT join a tailnet. Run 'tailscale up'" \
  "yourself (interactive browser auth, or 'tailscale up --authkey=...') before starting" \
  "the worker, so NEXTCLOUD_BASE_URL (a tailnet MagicDNS hostname) is reachable."
log "Also: outside Docker there is no Taildrop delivery path at all. The 'tailscale file" \
  "get' polling loop that drains Taildrop into the watched inbox only exists in" \
  "docker/tailscale/entrypoint.sh (the Docker Compose sidecar) - src/ingest/" \
  "taildropDrain.ts just moves files between two local directories, it never calls" \
  "tailscale itself. For a non-Docker run, drop files directly into INGEST_WATCH_DIR" \
  "instead of relying on Taildrop, or run 'watch -n5 tailscale file get \$TAILDROP_STAGING_DIR'" \
  "yourself to replicate the sidecar's loop."

# --- 2. Python venv for markitdown + weasyprint + FinTS banking ----------------------------
log_step "Setting up Python venv for markitdown, weasyprint, and FinTS banking"

if [ ! -x "$REPO_ROOT/.venv/bin/python" ]; then
  run_logged python3 -m venv "$REPO_ROOT/.venv"
else
  log ".venv already exists, skipping venv creation"
fi
run_logged "$REPO_ROOT/.venv/bin/pip" install --quiet --upgrade pip
run_logged "$REPO_ROOT/.venv/bin/pip" install --quiet markitdown weasyprint fints mt-940 sepaxml requests
log "Python tools installed at .venv/bin/ (markitdown, weasyprint, fints)"

# --- 3. Node dependencies ------------------------------------------------------------------
log_step "Installing npm dependencies"
run_logged npm install

# --- 4. Claude Code CLI (for `claude login` - Claude Agent SDK subscription auth) ---------
log_step "Installing the Claude Code CLI"

if command -v claude >/dev/null 2>&1; then
  log "claude CLI already installed ($(command -v claude)), skipping"
else
  # Global installs write into npm's system prefix (e.g. /usr/lib/node_modules when Node
  # came from a system package manager) - needs the same root/sudo handling as apt-get/dnf
  # above, or it fails with EACCES for a non-root user.
  run_logged "${SUDO[@]}" npm install -g @anthropic-ai/claude-code
fi

# --- 5. agy (Antigravity) CLI (Gemini primary solver path) --------------------------------
log_step "Installing the agy (Antigravity) CLI"

if command -v agy >/dev/null 2>&1; then
  log "agy CLI already installed ($(command -v agy)), skipping"
else
  run_logged bash -c 'curl -fsSL https://antigravity.google/cli/install.sh | bash'
  if [ -x "$HOME/.local/bin/agy" ] && ! command -v agy >/dev/null 2>&1; then
    # The installer already appends this PATH export to ~/.bashrc and ~/.profile itself -
    # it just hasn't taken effect in *this* shell yet. Export it here too so the rest of
    # this script (and anything you run right after, in this same shell) sees `agy`
    # without a manual copy-paste step; new shells pick it up automatically already.
    export PATH="$HOME/.local/bin:$PATH"
    log "agy installed to $HOME/.local/bin - added to PATH for the rest of this script." \
      "The installer already added it to ~/.bashrc/~/.profile too, so new shells pick it" \
      "up on their own; this shell will see it after 'source ~/.bashrc' or a new login."
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
log "     npm run dev:web      # in a third for dashboard"
log "Full log written to $LOG_FILE"
