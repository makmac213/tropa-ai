#!/bin/bash
# Cut a release:  scripts/release.sh 0.2.0
# Bumps VERSION, commits, tags v<version>, pushes, and creates a GitHub release
# (if the gh CLI is installed). install.sh installs the latest release.
set -e
cd "$(dirname "$0")/.."
V="$1"; [ -n "$V" ] || { echo "usage: scripts/release.sh X.Y.Z"; exit 1; }
[ -z "$(git status --porcelain)" ] || { echo "❌ commit or stash your changes first"; exit 1; }
echo "$V" > VERSION
git add VERSION && git commit -m "Release v$V"
git tag "v$V"
git push && git push origin "v$V"
if command -v gh >/dev/null; then gh release create "v$V" --title "v$V" --generate-notes; fi
echo "✅ Released v$V"
