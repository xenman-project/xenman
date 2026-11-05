#!/usr/bin/env bash
set -euo pipefail

# Populates an empty directory with the system files an appliance carries
# outside /opt/xenman -- exactly the set an update package may replace.
#
#     assemble-system.sh <empty-dir> [node tarball]
#
# Given the Node.js tarball (fetch-node.sh), the tree carries its node binary
# as usr/local/bin/node too: apt does not know this Node.js, so an update
# package is the only way a security fix for it reaches an appliance.
#
# Both the .xva build and the .xenup build call this, so a freshly built
# appliance and an updated one cannot end up with different system files.
#
# What is NOT in here is deliberate: hostname, network, fstab, bootloader and
# SSH settings belong to whoever runs the appliance. An update must never reset
# a static IP someone configured.

DEST="${1:?usage: assemble-system.sh <empty-dir>}"
HERE="$(cd "$(dirname "$0")" && pwd)"

mkdir -p "${DEST}"
# Modes are forced below, so this must never be pointed at a live root.
if [ -n "$(ls -A "${DEST}")" ]; then
  echo "assemble-system: ${DEST} is not empty" >&2
  exit 1
fi

cp -r "${HERE}/rootfs/." "${DEST}/"

install -D -m 0755 "${HERE}/xenman-updater"   "${DEST}/usr/local/sbin/xenman-updater"
install -D -m 0755 "${HERE}/xenman-os-update" "${DEST}/usr/local/sbin/xenman-os-update"
install -D -m 0755 "${HERE}/xenman-os-policy" "${DEST}/usr/local/sbin/xenman-os-policy"
install -D -m 0755 "${HERE}/xenman-os-request" "${DEST}/usr/local/sbin/xenman-os-request"
install -D -m 0644 "${HERE}/xenup.js"         "${DEST}/usr/local/lib/xenman/xenup.js"
install -D -m 0644 "${HERE}/audit-append.js"  "${DEST}/usr/local/lib/xenman/audit-append.js"
install -D -m 0644 "${HERE}/data-write.js"    "${DEST}/usr/local/lib/xenman/data-write.js"
install -D -m 0644 "${HERE}/os-policy.js"     "${DEST}/usr/local/lib/xenman/os-policy.js"
install -D -m 0644 "${HERE}/os-request.js"    "${DEST}/usr/local/lib/xenman/os-request.js"
install -D -m 0755 "${HERE}/xenman-guest-tools" "${DEST}/usr/local/sbin/xenman-guest-tools"
install -D -m 0755 "${HERE}/xenman-network"  "${DEST}/usr/local/sbin/xenman-network"
install -D -m 0755 "${HERE}/xenman-setup"    "${DEST}/usr/local/sbin/xenman-setup"
install -D -m 0755 "${HERE}/xenman-ssh-default" "${DEST}/usr/local/sbin/xenman-ssh-default"
install -D -m 0755 "${HERE}/xenman-credential" "${DEST}/usr/local/sbin/xenman-credential"
install -D -m 0755 "${HERE}/xenman-firewall" "${DEST}/usr/local/sbin/xenman-firewall"
install -D -m 0644 "${HERE}/firewall.js"     "${DEST}/usr/local/lib/xenman/firewall.js"
install -D -m 0644 "${HERE}/network.js"      "${DEST}/usr/local/lib/xenman/network.js"
install -D -m 0644 "${HERE}/reset-admin.js"  "${DEST}/usr/local/lib/xenman/reset-admin.js"
install -D -m 0644 "${HERE}/console-profile.sh" "${DEST}/usr/local/lib/xenman/console-profile.sh"

# The XenServer guest tools, under a fixed name so an update replaces the
# package rather than adding a second one beside it. Exactly one must be there.
guest_tools=("${HERE}"/vendor/xe-guest-utilities_*_amd64.deb)
if [ "${#guest_tools[@]}" -ne 1 ] || [ ! -f "${guest_tools[0]}" ]; then
  echo "assemble-system: expected exactly one vendor/xe-guest-utilities_*_amd64.deb" >&2
  exit 1
fi
install -D -m 0644 "${guest_tools[0]}" "${DEST}/usr/local/lib/xenman/guest-tools/xe-guest-utilities.deb"

# Git on Windows records no executable bit, so modes come from here, not from
# the checkout: everything readable, only the sbin entries executable.
find "${DEST}" -type d -exec chmod 0755 {} +
find "${DEST}" -type f -exec chmod 0644 {} +
find "${DEST}/usr/local/sbin" -type f -exec chmod 0755 {} +

# Only the binary: npm and the headers are needed to build, not to run, and
# stay what the .xva put there.
NODE_TARBALL="${2:-}"
if [ -n "${NODE_TARBALL}" ]; then
  mkdir -p "${DEST}/usr/local/bin"
  tar -xJf "${NODE_TARBALL}" -C "${DEST}/usr/local/bin" --strip-components=2 --wildcards '*/bin/node'
  chmod 0755 "${DEST}/usr/local/bin/node"
fi
