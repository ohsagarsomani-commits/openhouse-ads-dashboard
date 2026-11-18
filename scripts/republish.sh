#!/usr/bin/env bash
# Publishes a new version of the locked dashboard with the password viewers already use.
# The password is typed once, hidden, and checked against the page published now before anything changes.
#
#   scripts/republish.sh path/to/snapshot.json
set -euo pipefail

DATA="${1:?Give the data file: scripts/republish.sh path/to/snapshot.json}"
GH="${GH:-gh}"
cd "$(dirname "$0")/.."
REPO="$("$GH" repo view --json nameWithOwner -q .nameWithOwner)"
URL="$("$GH" api "repos/$REPO/pages" -q .html_url)"

echo "Republishing the Openhouse Meta Ads dashboard at $URL"
read -rsp "Page password (the one viewers already use): " PW; echo
PAGE_PASSWORD="$PW" node scripts/build.mjs --data "$DATA" --out out --same-as "$URL"
unset PW

(
  cd out
  rm -rf .git
  git init -q -b gh-pages
  git add -A
  git -c user.name="Openhouse dashboard" -c user.email="dashboard@users.noreply.github.com" commit -qm "Dashboard numbers"
  git -c credential.helper= -c "credential.helper=!\"$GH\" auth git-credential" push -qf "https://github.com/$REPO.git" gh-pages
)
"$GH" api -X POST "repos/$REPO/pages/builds" >/dev/null 2>&1 || true
echo
echo "Published. The new version appears at $URL within a minute or two."
