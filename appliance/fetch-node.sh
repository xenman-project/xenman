#!/usr/bin/env bash
set -euo pipefail

# Puts the Node.js tarball named in node-version into a directory and checks
# it against the digest pinned there:
#
#     fetch-node.sh <dir>        prints the tarball's path
#
# Taken from NODE_TARBALL_DIR when it holds the file (for build hosts behind a
# proxy that wants a login; see README, "Building behind a proxy"), downloaded
# from nodejs.org otherwise. Either way it has to match the pinned digest.

DEST="${1:?usage: fetch-node.sh <dir>}"
HERE="$(cd "$(dirname "$0")" && pwd)"
# shellcheck source=node-version
. "${HERE}/node-version"

TARBALL="node-v${NODE_VERSION}-linux-x64.tar.xz"
mkdir -p "${DEST}"
if [ -n "${NODE_TARBALL_DIR:-}" ] && [ -f "${NODE_TARBALL_DIR}/${TARBALL}" ]; then
  cp "${NODE_TARBALL_DIR}/${TARBALL}" "${DEST}/${TARBALL}"
else
  curl -sSfL -o "${DEST}/${TARBALL}" "https://nodejs.org/dist/v${NODE_VERSION}/${TARBALL}"
fi

GOT=$(sha256sum "${DEST}/${TARBALL}" | cut -d' ' -f1)
if [ "${GOT}" != "${NODE_SHA256}" ]; then
  echo "fetch-node: ${TARBALL} does not match the digest in node-version (got ${GOT})" >&2
  rm -f "${DEST}/${TARBALL}"
  exit 1
fi
echo "${DEST}/${TARBALL}"
