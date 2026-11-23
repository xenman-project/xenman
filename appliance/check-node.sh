#!/usr/bin/env bash
set -uo pipefail

# Says whether the Node.js in node-version is behind the newest release of its
# major line -- loudly when that means a missed security release:
#
#     check-node.sh
#
# Never stops a build: an offline build host is not an error, and the release
# list is a convenience. The list is https://nodejs.org/dist/index.json, or
# NODE_INDEX_FILE when given -- fetched elsewhere, for build hosts behind a
# proxy that wants a login (see README, "Building behind a proxy").
#
# A newer major line is only mentioned: moving to it is a decision of its own,
# with its own testing, not something a build should nudge into node-version.

HERE="$(cd "$(dirname "$0")" && pwd)"
# shellcheck source=node-version
. "${HERE}/node-version"
NODE_BIN="${NODE:-node}"

INDEX="${NODE_INDEX_FILE:-}"
if [ -z "${INDEX}" ]; then
  INDEX=$(mktemp)
  trap 'rm -f "${INDEX}"' EXIT
  if ! curl -sSf -m 15 -o "${INDEX}" https://nodejs.org/dist/index.json 2>/dev/null; then
    echo "  Node.js ${NODE_VERSION}: could not check for newer releases (nodejs.org not reachable)"
    exit 0
  fi
fi

"${NODE_BIN}" "${HERE}/node-newer.js" --text "${INDEX}" "${NODE_VERSION}" || echo "  Node.js ${NODE_VERSION}: could not read the release list"
exit 0
