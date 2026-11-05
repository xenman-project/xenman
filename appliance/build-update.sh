#!/usr/bin/env bash
set -euo pipefail

# Builds a signed .xenup update package from the current HEAD: the same
# /opt/xenman tree the appliance build produces, without the operating system
# around it. Install it through the appliance web interface, or by hand with
#
#     xenman-updater /path/to/file.xenup
#
# Needs Node 24 and the private release key. See README.md, "Updating".

# ─── Configuration ───────────────────────────────────────────────────────────
RELEASE_KEY="${RELEASE_KEY:-}"          # private Ed25519 key (xenup.js keygen)
NPM_CACHE_DIR="${NPM_CACHE_DIR:-}"      # optional, for hosts without registry access
NODE_TARBALL_DIR="${NODE_TARBALL_DIR:-}" # optional, a pre-fetched Node.js tarball (see node-version)
# WITH_NODE=0 leaves Node.js out: the bridge for appliances whose updater
# predates Node.js in packages and refuses /usr/local/bin/node. Installed
# first, it brings the updater that accepts it; then the full package.
WITH_NODE="${WITH_NODE:-1}"

REPO_ROOT="$(git -C "$(dirname "$0")" rev-parse --show-toplevel)"
OUT_DIR="${REPO_ROOT}/dist"

GIT_TAG=$(git -C "${REPO_ROOT}" describe --tags --exact-match 2>/dev/null || true)
if [ -z "${GIT_TAG}" ]; then
  GIT_TAG=$(git -C "${REPO_ROOT}" rev-parse --short HEAD)
fi
GIT_COMMIT=$(git -C "${REPO_ROOT}" rev-parse --short HEAD)
XENUP_FILE="${OUT_DIR}/xenman-${GIT_TAG}.xenup"
[ "${WITH_NODE}" = "0" ] && XENUP_FILE="${OUT_DIR}/xenman-${GIT_TAG}-bridge.xenup"

echo "=== XenMan Update Package (${GIT_TAG}) ==="
echo ""

# ─── Step 1: Preflight ───────────────────────────────────────────────────────
echo "[1/4] Checking prerequisites..."

if [ -z "${RELEASE_KEY}" ]; then
  echo "Error: RELEASE_KEY is not set." >&2
  echo "  Create one once:  node appliance/xenup.js keygen --out ~/.xenman-keys" >&2
  echo "  Then:             RELEASE_KEY=~/.xenman-keys/release-key $0" >&2
  exit 1
fi
[ -f "${RELEASE_KEY}" ] || { echo "Error: no such key: ${RELEASE_KEY}" >&2; exit 1; }

# Whether the Node.js this package carries is still the newest of its line --
# a warning, never a stop. NODE_INDEX_FILE: a pre-fetched release list.
bash "${REPO_ROOT}/appliance/check-node.sh"

command -v node >/dev/null 2>&1 || { echo "Error: node is required." >&2; exit 1; }
NODE_MAJOR=$(node -p "process.versions.node.split('.')[0]")
if [ "${NODE_MAJOR}" -lt 24 ]; then
  echo "Error: Node 24 or newer required, found $(node --version)." >&2
  exit 1
fi

# The package is built from HEAD for the same reason the appliance is: so that
# what ships can be traced back to a commit.
if ! git -C "${REPO_ROOT}" diff-index --quiet HEAD -- 2>/dev/null; then
  echo "  Warning: working tree has uncommitted changes; building from HEAD (${GIT_TAG})."
fi

mkdir -p "${OUT_DIR}"
WORK_DIR=$(mktemp -d --tmpdir="${TMPDIR:-/var/tmp}" xenman-update.XXXXXXXX)
trap 'rm -rf "${WORK_DIR}"' EXIT

SRC="${WORK_DIR}/src"
PAYLOAD="${WORK_DIR}/payload"
mkdir -p "${SRC}" "${PAYLOAD}"

# ─── Step 2: Build ───────────────────────────────────────────────────────────
echo "[2/4] Building XenMan..."

git -C "${REPO_ROOT}" archive --format=tar HEAD | tar -x -C "${SRC}"

NPM_FLAGS=""
if [ -n "${NPM_CACHE_DIR}" ]; then
  echo "  using the npm cache in ${NPM_CACHE_DIR}"
  export npm_config_cache="${NPM_CACHE_DIR}"
  # --ignore-scripts for the same reason as the appliance build: some postinstall
  # hooks fetch binaries at install time, which no cache can satisfy.
  NPM_FLAGS="--offline --ignore-scripts"
fi

( cd "${SRC}" && npm ci --no-audit --no-fund ${NPM_FLAGS} >/dev/null )
( cd "${SRC}" && NEXT_PUBLIC_GIT_COMMIT="${GIT_TAG}" npm run build >/dev/null )

# ─── Step 3: Assemble the payload ────────────────────────────────────────────
echo "[3/4] Assembling the payload..."

# Identical to what build-appliance.sh installs, so an updated appliance and a
# freshly built one hold the same tree.
cp -r "${SRC}/.next/standalone/." "${PAYLOAD}/"
cp -r "${SRC}/.next/static" "${PAYLOAD}/.next/static"
cp -r "${SRC}/public" "${PAYLOAD}/public"
mv "${PAYLOAD}/server.js" "${PAYLOAD}/standalone-server.js"
cp "${SRC}/server.js" "${PAYLOAD}/server.js"
cp "${SRC}/vnc-proxy.js" "${PAYLOAD}/vnc-proxy.js"
mkdir -p "${PAYLOAD}/node_modules" "${PAYLOAD}/.next/cache"
cp -r "${SRC}/node_modules/ws" "${PAYLOAD}/node_modules/ws"
rm -rf "${PAYLOAD}/data" "${PAYLOAD}/src" "${PAYLOAD}/appliance" \
       "${PAYLOAD}/Dockerfile" "${PAYLOAD}/docker-compose.yml" \
       "${PAYLOAD}/README.md"

# The system files ride along, so an update can replace the updater, its units
# and the apt policy too. Taken from the archived HEAD like the application,
# not from the working tree, so the package matches a commit throughout.
# Node.js rides along as well: apt does not know it, so this is the only way
# a fix for it reaches an appliance (node-version pins release and digest).
SYSTEM="${WORK_DIR}/system"
NODE_TARBALL_PATH=""
if [ "${WITH_NODE}" != "0" ]; then
  NODE_TARBALL_PATH=$(NODE_TARBALL_DIR="${NODE_TARBALL_DIR}" bash "${SRC}/appliance/fetch-node.sh" "${WORK_DIR}/node")
fi
bash "${SRC}/appliance/assemble-system.sh" "${SYSTEM}" ${NODE_TARBALL_PATH:+"${NODE_TARBALL_PATH}"}

# ─── Step 4: Pack and sign ───────────────────────────────────────────────────
echo "[4/4] Packing and signing..."

node "${REPO_ROOT}/appliance/xenup.js" pack \
  --payload "${PAYLOAD}" \
  --system "${SYSTEM}" \
  --version "${GIT_TAG}" \
  --commit "${GIT_COMMIT}" \
  --key "${RELEASE_KEY}" \
  --out "${XENUP_FILE}"

echo ""
echo "=== Done ==="
echo "Upload this in the appliance web interface under Settings > Updates."
