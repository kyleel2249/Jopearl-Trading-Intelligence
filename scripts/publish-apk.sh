#!/usr/bin/env bash
# Publishes a built APK into android/app/downloads/ on main.
# Usage: scripts/publish-apk.sh <path-to-apk> <published-file-name>
# Safe against concurrent workflows: it always rebuilds its commit on top of the
# latest origin/main and retries, so two Android jobs never clobber each other.
set -euo pipefail

APK_SOURCE="${1:?path to built APK required}"
APK_NAME="${2:?published APK file name required}"
DEST_DIR="android/app/downloads"

test -s "$APK_SOURCE" || { echo "APK not found or empty: $APK_SOURCE" >&2; exit 1; }

STAGE="$(mktemp -d)"
cp "$APK_SOURCE" "$STAGE/$APK_NAME"
( cd "$STAGE" && sha256sum "$APK_NAME" > "$APK_NAME.sha256" )

git config user.name "github-actions[bot]"
git config user.email "41898282+github-actions[bot]@users.noreply.github.com"

for attempt in 1 2 3 4 5; do
  if ! FETCH_OUTPUT="$(git fetch origin main 2>&1)"; then
    echo "::error title=APK publish fetch failed::$(printf '%s' "$FETCH_OUTPUT" | tr '\n' ' ' | cut -c1-600)" >&2
    exit 1
  fi
  git reset --quiet --hard origin/main
  mkdir -p "$DEST_DIR"
  cp "$STAGE/$APK_NAME" "$STAGE/$APK_NAME.sha256" "$DEST_DIR/"
  git add -f "$DEST_DIR/$APK_NAME" "$DEST_DIR/$APK_NAME.sha256"
  if git diff --cached --quiet; then
    echo "APK already published and unchanged."
    exit 0
  fi
  git commit --quiet -m "chore(android): publish $APK_NAME from ${GITHUB_SHA:-local} [skip ci]"
  if PUSH_OUTPUT="$(git push origin HEAD:main 2>&1)"; then
    echo "Published $DEST_DIR/$APK_NAME (attempt $attempt)."
    exit 0
  fi
  # Surface the real reason as a workflow annotation (secrets are masked by Actions).
  echo "::error title=APK publish push failed (attempt $attempt)::$(printf '%s' "$PUSH_OUTPUT" | tr '\n' ' ' | cut -c1-600)" >&2
  echo "Push rejected on attempt $attempt; retrying on the latest main." >&2
  sleep $((attempt * 3))
done
echo "Could not publish the APK after 5 attempts." >&2
exit 1
