# Task 3 Report: Install hunspell dictionaries in the Docker image

## Summary
Added `hunspell-de-de` and `hunspell-en-us` packages to the runtime stage of `docker/Dockerfile` to ensure German and English hunspell dictionaries (`/usr/share/hunspell/de_DE.dic` and `/usr/share/hunspell/en_US.dic`) are installed in the container environment.

## Changes Made
- **File**: `docker/Dockerfile`
- **Modification**: Added `hunspell-de-de` and `hunspell-en-us` to the runtime stage `apt-get install` list directly after `tesseract-ocr-eng` and before `pandoc`.

## Step Execution Summary
1. **Step 1 (Add apt packages)**: Completed. Added `hunspell-de-de` and `hunspell-en-us` in the exact position specified in the task brief.
2. **Step 2 (Build image)**: **Skipped**. Docker command is not available in this execution environment.
3. **Step 3 (Verify dictionary files in image)**: **Skipped**. Docker command is not available in this execution environment.
4. **Step 4 (Commit)**: Completed on branch `feat/ocr-quality-and-subfolder-ingest-task-3`.

> **Note on Docker Build/Run Verification**: Steps 2 and 3 were skipped because `docker` is not installed in this execution environment. These verification steps (`docker build` and `docker run --rm ... ls /usr/share/hunspell/de_DE.dic /usr/share/hunspell/en_US.dic`) should be performed in an environment with Docker available prior to merging/deploying to production.

## Git Details
- **Branch**: `feat/ocr-quality-and-subfolder-ingest-task-3`
- **Commit SHA**: `20408b6`
- **Commit Message**: `feat: install hunspell DE/EN dictionaries in the runtime image`
- **Commit Body**: `Note: docker build and run verification skipped because Docker is unavailable in this execution environment.`

## Self-Review Verification
- [x] Correct package names (`hunspell-de-de` and `hunspell-en-us`) added.
- [x] Positioned in the apt list after `tesseract-ocr-eng` and before `pandoc`.
- [x] No unrelated changes made to `docker/Dockerfile`.
