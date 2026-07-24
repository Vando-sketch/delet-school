### Task 3: Install hunspell dictionaries in the Docker image

**Files:**
- Modify: `docker/Dockerfile`

**Interfaces:**
- Consumes: nothing new.
- Produces: `/usr/share/hunspell/de_DE.dic` and `/usr/share/hunspell/en_US.dic` inside the runtime image, matching `config.dictionary.deDicPath`/`.enDicPath`'s defaults from Task 1.

- [ ] **Step 1: Add the apt packages**

In `docker/Dockerfile`, in the runtime stage's `apt-get install` list, add `hunspell-de-de` and `hunspell-en-us` after `tesseract-ocr-eng`:

```dockerfile
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
```

- [ ] **Step 2: Build the image**

Run: `docker build -f docker/Dockerfile -t delet-school-hunspell-test .`
Expected: build succeeds (exit code 0). This installs the full toolchain (poppler, ocrmypdf, tesseract, pandoc, the Python venv for markitdown/weasyprint) so it can take a few minutes on a cold Docker build cache.

- [ ] **Step 3: Verify the dictionary files exist in the built image**

Run: `docker run --rm delet-school-hunspell-test ls /usr/share/hunspell/de_DE.dic /usr/share/hunspell/en_US.dic`
Expected: both paths printed, exit code 0 (no ENTRYPOINT/CMD is set in this Dockerfile, so the image accepts `ls ...` directly as its run command).

- [ ] **Step 4: Commit**

```bash
git add docker/Dockerfile
git commit -m "feat: install hunspell DE/EN dictionaries in the runtime image"
```

---

