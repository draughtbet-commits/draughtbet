#!/usr/bin/env bash
# Scans the tracked source tree for leaked secrets, mirroring the CI gitleaks
# job. A temp mirror of `git ls-files` is scanned so local .env files (which
# carry dev keys) are never part of the input.
set -euo pipefail

cd "$(dirname "$0")/../.."
REPO_ROOT="$(pwd)"

MIRROR="$(mktemp -d)"
trap 'rm -rf "$MIRROR"' EXIT

echo "[scan-secrets] Mirroring tracked files to $MIRROR"
while IFS= read -r -d '' f; do
  mkdir -p "$MIRROR/$(dirname "$f")"
  cp "$f" "$MIRROR/$f"
done < <(git ls-files -z)

echo "[scan-secrets] Running gitleaks"
GITLEAKS_CACHE="$HOME/.cache/gitleaks/gitleaks"
if command -v gitleaks >/dev/null 2>&1; then
  GITLEAKS="gitleaks"
elif [ -x "$GITLEAKS_CACHE" ]; then
  GITLEAKS="$GITLEAKS_CACHE"
elif command -v curl >/dev/null 2>&1; then
  echo "[scan-secrets] Fetching gitleaks into $GITLEAKS_CACHE"
  mkdir -p "$(dirname "$GITLEAKS_CACHE")"
  TEMP_TAR="$(mktemp)"
  curl -sL -o "$TEMP_TAR" \
    https://github.com/gitleaks/gitleaks/releases/download/v8.30.1/gitleaks_8.30.1_linux_x64.tar.gz
  tar -xzf "$TEMP_TAR" -C "$(dirname "$GITLEAKS_CACHE")"
  rm -f "$TEMP_TAR"
  GITLEAKS="$GITLEAKS_CACHE"
elif command -v docker >/dev/null 2>&1; then
  docker run --rm -v "$MIRROR:/scan" -v /tmp:/out gitleaks/gitleaks:latest \
    detect --source /scan --no-git --report-format json --report-path /out/gitleaks-report.json --exit-code 1
  echo "[scan-secrets] Clean."
  exit 0
else
  echo "[scan-secrets] No gitleaks, curl, or docker available; aborting" >&2
  exit 1
fi

"$GITLEAKS" detect --source "$MIRROR" --no-git --config "$REPO_ROOT/.gitleaks.toml" \
  --report-format json --report-path /tmp/gitleaks-report.json --exit-code 1

echo "[scan-secrets] Clean."