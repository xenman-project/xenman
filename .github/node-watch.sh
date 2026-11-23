#!/bin/bash
# The steps of .github/workflows/node-watch.yml, which keeps the Node.js the
# appliance ships (appliance/node-version) on its line's security releases.
#
#   node-watch.sh plan      what to do, as outputs (GITHUB_OUTPUT):
#                           mode    none, release or main
#                           base    what the fix goes onto
#                           pinned, newest, security, version, branch
#   node-watch.sh prepare   the branch: from base, node-version raised to
#                           newest with its digest, for a release the next
#                           patch version, a CHANGELOG entry; pushed
#
# release: the newest tag is a final release (v1.2.3). The fix goes onto that
#   tag -- not onto main, whose unreleased changes are not to ship with a
#   security fix -- and becomes 1.2.4.
# main: a release candidate series is open (v1.2.4-rc.1 after v1.2.3): there
#   is no version between the two, so the fix goes onto main and ships with
#   the next candidate or the final release.
#
# Environment: PRETEND_PINNED (test: act as if this were pinned), DRY_RUN
# (true: the branch gets "-dry-run" appended), NODE_INDEX_FILE (a release list
# instead of nodejs.org's), NO_PUSH=1 (prepare: the branch stays local).
set -euo pipefail
# Run in the clone; the script itself may be a copy elsewhere.
cd "$(git rev-parse --show-toplevel)"
out() { echo "$1=$2" >> "${GITHUB_OUTPUT:-/dev/stdout}"; }
note() { echo "$*"; [ -z "${GITHUB_STEP_SUMMARY:-}" ] || echo "$*" >> "$GITHUB_STEP_SUMMARY"; }

plan() {
  git fetch -q --tags origin
  # The newest final release, and whether a candidate series is open after it.
  read -r last_final open_rc < <(git tag -l 'v*' | node -e '
    const tags = require("fs").readFileSync(0, "utf8").split("\n").filter((t) => /^v\d+\.\d+\.\d+(-rc\.\d+)?$/.test(t));
    const key = (t) => { const [a, b, c] = t.slice(1).split("-")[0].split(".").map(Number); return a * 1e6 + b * 1e3 + c; };
    const finals = tags.filter((t) => !t.includes("-"));
    const last = finals.sort((x, y) => key(y) - key(x))[0] || "";
    const open = tags.some((t) => t.includes("-") && (!last || key(t) > key(last)));
    console.log(last || "-", open);
  ')
  if [ "$last_final" = "-" ] || [ "$open_rc" = true ]; then mode=main base=origin/main; else mode=release base=$last_final; fi

  pinned=${PRETEND_PINNED:-$(git show "$base:appliance/node-version" | sed -n 's/^NODE_VERSION=//p' | tr -d '\r')}
  index=${NODE_INDEX_FILE:-}
  if [ -z "$index" ]; then
    index=$(mktemp)
    curl -sSf -m 30 -o "$index" https://nodejs.org/dist/index.json
  fi
  json=$(node appliance/node-newer.js "$index" "$pinned")
  newest=$(node -pe 'JSON.parse(process.argv[1]).newest || ""' "$json")
  security=$(node -pe 'JSON.parse(process.argv[1]).security.join(", ")' "$json")
  out pinned "$pinned"
  if [ -z "$security" ]; then
    note "Node.js $pinned (on $base): no security release missed${newest:+ -- $newest is out, without security fixes}."
    out mode none
    return
  fi
  branch="node-$newest"; [ "${DRY_RUN:-false}" = true ] && branch="$branch-dry-run"
  if git ls-remote --exit-code --heads origin "$branch" >/dev/null; then
    note "Node.js $pinned misses $security; branch $branch is there already -- nothing done twice."
    out mode none
    return
  fi
  version=""
  if [ "$mode" = release ]; then
    IFS=. read -r a b c <<< "${last_final#v}"
    version="$a.$b.$((c + 1))"
    if git rev-parse -q --verify "refs/tags/v$version" >/dev/null; then
      note "Node.js $pinned misses $security, but v$version is taken -- nothing done."
      out mode none
      return
    fi
  fi
  note "Node.js $pinned (on $base) misses the security releases $security: raising it to $newest on $branch${version:+ as $version}."
  out mode "$mode"; out base "$base"; out newest "$newest"; out security "$security"; out version "$version"; out branch "$branch"
}

prepare() {
  : "${MODE:?}" "${BASE:?}" "${NEWEST:?}" "${SECURITY:?}" "${BRANCH:?}"
  git checkout -q -b "$BRANCH" "$BASE"
  local file="node-v$NEWEST-linux-x64.tar.xz" sha old entry today
  sha=$(curl -sSf -m 30 "https://nodejs.org/dist/v$NEWEST/SHASUMS256.txt" | awk -v f="$file" '$2 == f { print $1 }')
  if ! [[ "$sha" =~ ^[0-9a-f]{64}$ ]]; then echo "no SHA-256 for $file in SHASUMS256.txt" >&2; exit 1; fi
  old=$(sed -n 's/^NODE_VERSION=//p' appliance/node-version | tr -d '\r')
  sed -i -e "s/^NODE_VERSION=.*/NODE_VERSION=$NEWEST/" -e "s/^NODE_SHA256=.*/NODE_SHA256=$sha/" appliance/node-version
  entry="- **Node.js $NEWEST.** The Node.js the appliance runs goes from $old to $NEWEST, for the security releases $SECURITY (see https://nodejs.org/en/blog/vulnerability). The update package replaces it on the appliance."
  today=$(date -u +%F)
  if [ "$MODE" = release ]; then
    : "${VERSION:?}"
    npm version "$VERSION" --no-git-tag-version --allow-same-version >/dev/null
    # A section of its own, above the newest one.
    ENTRY="$entry" HEAD="## [$VERSION] - $today" awk '
      !done && /^## \[/ { print ENVIRON["HEAD"]; print ""; print "### Security"; print ENVIRON["ENTRY"]; print ""; done = 1 }
      { print }' CHANGELOG.md > CHANGELOG.md.new
  else
    # Into the newest section, which the next candidate or release takes.
    ENTRY="$entry" awk '
      { print }
      !done && /^## \[/ { print ""; print "### Security"; print ENVIRON["ENTRY"]; done = 1 }' CHANGELOG.md > CHANGELOG.md.new
  fi
  mv CHANGELOG.md.new CHANGELOG.md
  git add appliance/node-version CHANGELOG.md package.json package-lock.json
  git -c user.name="XenMan authors" -c user.email="authors@xenman.invalid" \
    commit -q -m "Node.js $NEWEST: security releases $SECURITY${VERSION:+, version $VERSION}"
  [ "${NO_PUSH:-}" = 1 ] || git push -q origin "$BRANCH"
  git log -1 --stat --format='%h %s'
}

case "${1:-}" in
  plan) plan ;;
  prepare) prepare ;;
  *) echo "usage: node-watch.sh plan|prepare" >&2; exit 2 ;;
esac
