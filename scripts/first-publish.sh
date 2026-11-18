#!/usr/bin/env bash
# Publishes the locked dashboard to GitHub Pages from a data file you already have,
# and saves the page password as the repository's PAGE_PASSWORD secret for the automatic refresh.
#
#   scripts/first-publish.sh path/to/snapshot.json
#
# The password is typed here, hidden, and goes only into the lock and the GitHub secret.
set -euo pipefail

DATA="${1:?Give the data file: scripts/first-publish.sh path/to/snapshot.json}"
GH="${GH:-gh}"
cd "$(dirname "$0")/.."
REPO="$("$GH" repo view --json nameWithOwner -q .nameWithOwner)"

echo "Publishing the Openhouse Meta Ads dashboard to $REPO"
read -rsp "Choose the page password (10 or more characters): " PW; echo
read -rsp "Type it again: " PW2; echo
if [ "$PW" != "$PW2" ]; then echo "The two passwords differ. Nothing was published."; exit 1; fi
if [ "${#PW}" -lt 10 ]; then echo "Use 10 or more characters. Nothing was published."; exit 1; fi

PAGE_PASSWORD="$PW" node scripts/build.mjs --data "$DATA" --out out
printf '%s' "$PW" | "$GH" secret set PAGE_PASSWORD --repo "$REPO"
unset PW PW2

# The gh-pages branch only ever holds the latest locked page.
(
  cd out
  rm -rf .git
  git init -q -b gh-pages
  git add -A
  git -c user.name="Openhouse dashboard" -c user.email="dashboard@users.noreply.github.com" commit -qm "Dashboard numbers"
  git -c credential.helper= -c "credential.helper=!\"$GH\" auth git-credential" push -qf "https://github.com/$REPO.git" gh-pages
)

# Pushing gh-pages usually switches Pages on by itself; otherwise switch it on here.
"$GH" api "repos/$REPO/pages" >/dev/null 2>&1 \
  || "$GH" api -X POST "repos/$REPO/pages" -f "source[branch]=gh-pages" -f "source[path]=/" >/dev/null 2>&1 \
  || true
"$GH" api -X POST "repos/$REPO/pages/builds" >/dev/null 2>&1 || true
echo
echo "Published. It can take a minute or two to appear at:"
echo "  $("$GH" api "repos/$REPO/pages" -q .html_url)"
