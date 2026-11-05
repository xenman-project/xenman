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

"${NODE_BIN}" - "${INDEX}" "${NODE_VERSION}" <<'JS' || echo "  Node.js ${NODE_VERSION}: could not read the release list"
const fs = require("fs");
const [file, pinned] = process.argv.slice(2);
const parse = (v) => v.replace(/^v/, "").split(".").map(Number);
const newer = (a, b) => {
  const [x, y] = [parse(a), parse(b)];
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] > y[i];
  return false;
};
const list = JSON.parse(fs.readFileSync(file, "utf8"));
const major = parse(pinned)[0];
const ahead = list.filter((r) => parse(r.version)[0] === major && newer(r.version, pinned));
if (!ahead.length) {
  console.log(`  Node.js ${pinned}: the newest ${major}.x`);
} else {
  const newest = ahead.reduce((a, b) => (newer(b.version, a.version) ? b : a));
  const security = ahead.filter((r) => r.security).map((r) => r.version);
  if (security.length) {
    console.log("");
    console.log(`  !! Node.js ${newest.version.slice(1)} is out, and ${pinned} misses security releases: ${security.join(", ")}`);
    console.log("  !! Raise appliance/node-version: the release, and the tarball's line from its SHASUMS256.txt.");
    console.log("");
  } else {
    console.log(`  Node.js ${newest.version.slice(1)} is out (no security fixes over ${pinned})`);
  }
}
const lts = list
  .filter((r) => r.lts && parse(r.version)[0] > major)
  .map((r) => parse(r.version)[0]);
if (lts.length) {
  console.log(`  Node.js ${Math.max(...lts)} is an LTS line too -- moving to it is a decision of its own`);
}
JS
exit 0
