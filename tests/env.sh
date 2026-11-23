# Sourced by every suite: where things are. Each can be set from outside;
# without it the suites run against the clone they sit in (as in CI).
#   TESTS     this directory (fakes and helpers)
#   REPO      the source tree (appliance/, server.js, src/)
#   BUILD     the tree with the Next.js build (.next/), by default REPO
#   NODE_BIN  node; the suites call it as $NODE
#   NODE_DIST a local copy of nodejs.org/dist, optional (node-check)
TESTS=${TESTS:-$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)}
REPO=${REPO:-$(cd "$TESTS/.." && pwd)}
BUILD=${BUILD:-$REPO}
NODE_BIN=${NODE_BIN:-$(command -v node)}
NODE_DIST=${NODE_DIST:-$REPO/../node-dist}
export TESTS REPO BUILD NODE_BIN NODE_DIST
