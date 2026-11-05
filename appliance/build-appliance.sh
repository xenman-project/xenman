#!/usr/bin/env bash
set -euo pipefail

# Builds the XenMan appliance: a Debian VM running XenMan under systemd, packed
# into an .xva that XenCenter or Xen Orchestra imports directly.
#
# Runs on any Debian/Ubuntu machine with root — no XenServer host involved.
# See README.md for prerequisites.

# ─── Configuration ───────────────────────────────────────────────────────────
DEBIAN_SUITE="trixie"
DEBIAN_MIRROR="http://deb.debian.org/debian"
DISK_SIZE_GB=20
VM_NAME="XenMan"
VM_DESCRIPTION="XenMan — XenServer management appliance"
VM_MEMORY_MB=2048
VM_VCPUS=2
APPLIANCE_HOSTNAME="xenman"
ROOT_PASSWORD="xenman"        # a change is forced at first login (chage -d 0)
DISK_LABEL="xenman-root"

# Optional, for build hosts that cannot reach the network directly (a proxy
# demanding authentication, say). Point these at a pre-fetched Node tarball and
# a populated npm cache; see README, "Building behind a proxy".
NODE_TARBALL_DIR="${NODE_TARBALL_DIR:-}"
NPM_CACHE_DIR="${NPM_CACHE_DIR:-}"

# Public half of the release signing key (appliance/xenup.js keygen). Without
# it the appliance still builds, but refuses every update: there would be
# nothing to check a package against.
RELEASE_KEY_PUB="${RELEASE_KEY_PUB:-}"

REPO_ROOT="$(git -C "$(dirname "$0")" rev-parse --show-toplevel)"
OUT_DIR="${REPO_ROOT}/dist"

# The Node.js release, with its pinned digest -- shared with update packages.
# shellcheck source=node-version
. "${REPO_ROOT}/appliance/node-version"

GIT_TAG=$(git -C "${REPO_ROOT}" describe --tags --exact-match 2>/dev/null || true)
if [ -z "${GIT_TAG}" ]; then
  GIT_TAG=$(git -C "${REPO_ROOT}" rev-parse --short HEAD)
fi
XVA_FILE="${OUT_DIR}/xenman-appliance-${GIT_TAG}.xva"

echo "=== XenMan Appliance Build (${GIT_TAG}) ==="
echo ""

# ─── Step 1: Preflight ───────────────────────────────────────────────────────
echo "[1/9] Checking prerequisites..."

if [ "$(id -u)" -ne 0 ]; then
  echo "Error: must run as root (loop devices, mounts, chroot)." >&2
  exit 1
fi

missing=()
for tool in debootstrap sfdisk losetup mkfs.ext4 chroot curl tar xz grub-install; do
  command -v "${tool}" >/dev/null 2>&1 || missing+=("${tool}")
done
if [ ${#missing[@]} -gt 0 ]; then
  echo "Error: missing tools: ${missing[*]}" >&2
  echo "  apt-get install debootstrap fdisk util-linux e2fsprogs curl tar xz-utils grub2-common grub-pc-bin" >&2
  exit 1
fi

# grub-install runs on the build host, so the host needs the BIOS modules it
# copies into the image.
if [ ! -d /usr/lib/grub/i386-pc ]; then
  echo "Error: /usr/lib/grub/i386-pc is missing — apt-get install grub-pc-bin" >&2
  exit 1
fi

# git archive exports the last commit, not the working tree; uncommitted work
# would silently not reach the appliance.
if ! git -C "${REPO_ROOT}" diff-index --quiet HEAD -- 2>/dev/null; then
  echo "  Warning: working tree has uncommitted changes; building from HEAD (${GIT_TAG})."
fi

mkdir -p "${OUT_DIR}"

# /tmp is tmpfs on many systems (WSL among them) and far too small to hold a
# 20 GiB image; /var/tmp is disk-backed. TMPDIR overrides it.
WORK_DIR=$(mktemp -d --tmpdir="${TMPDIR:-/var/tmp}" xenman-appliance.XXXXXXXX)
MNT="${WORK_DIR}/root"
DISK_IMAGE="${WORK_DIR}/disk.raw"
LOOP_DEV=""

cleanup() {
  set +e
  if [ -n "${LOOP_DEV}" ]; then
    umount -R "${MNT}" 2>/dev/null
    losetup -d "${LOOP_DEV}" 2>/dev/null
  fi
  rm -rf "${WORK_DIR}"
}
trap cleanup EXIT

# ─── Step 2: Disk image ──────────────────────────────────────────────────────
echo "[2/9] Creating ${DISK_SIZE_GB} GiB disk image..."

# Sparse to begin with, and zero-filled again before packing, so the .xva only
# carries chunks that hold real data.
truncate -s "${DISK_SIZE_GB}G" "${DISK_IMAGE}"

# MBR rather than GPT: the VM boots through HVM_boot_policy "BIOS order".
sfdisk --quiet "${DISK_IMAGE}" <<'PARTITIONS'
label: dos
start=2048, type=83, bootable
PARTITIONS

LOOP_DEV=$(losetup -P -f --show "${DISK_IMAGE}")
ROOT_PART="${LOOP_DEV}p1"
[ -b "${ROOT_PART}" ] || { echo "Error: ${ROOT_PART} did not appear." >&2; exit 1; }

mkfs.ext4 -q -L "${DISK_LABEL}" "${ROOT_PART}"
mkdir -p "${MNT}"
mount "${ROOT_PART}" "${MNT}"

# ─── Step 3: Base system ─────────────────────────────────────────────────────
echo "[3/9] Bootstrapping Debian ${DEBIAN_SUITE}..."

# Deliberately minimal: the kernel and the rest arrive through apt below, where
# DEBIAN_FRONTEND=noninteractive is in effect. Pulling grub-pc in here instead
# would stall on its "which device to install to" debconf prompt.
debootstrap \
  --arch=amd64 \
  --variant=minbase \
  --include=systemd-sysv,ca-certificates \
  "${DEBIAN_SUITE}" "${MNT}" "${DEBIAN_MIRROR}"

mount --bind /dev "${MNT}/dev"
mount --bind /dev/pts "${MNT}/dev/pts"
mount -t proc proc "${MNT}/proc"
mount -t sysfs sys "${MNT}/sys"

# The host's resolver, only for the duration of the build; replaced by the
# systemd-resolved stub before packing.
cp /etc/resolv.conf "${MNT}/etc/resolv.conf"

# Keep the chroot from starting daemons during package installation.
cat > "${MNT}/usr/sbin/policy-rc.d" <<'EOF'
#!/bin/sh
exit 101
EOF
chmod +x "${MNT}/usr/sbin/policy-rc.d"

in_chroot() {
  chroot "${MNT}" /usr/bin/env \
    DEBIAN_FRONTEND=noninteractive \
    PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin \
    "$@"
}

cat > "${MNT}/etc/apt/sources.list" <<EOF
deb ${DEBIAN_MIRROR} ${DEBIAN_SUITE} main
deb ${DEBIAN_MIRROR} ${DEBIAN_SUITE}-updates main
deb http://security.debian.org/debian-security ${DEBIAN_SUITE}-security main
EOF

in_chroot apt-get update -qq
# wireless-regdb: the kernel loads cfg80211 and looks for the wireless
# regulatory database at boot. There is no radio in a VM, but without the
# package the console opens with a firmware load error that reads alarming.
in_chroot apt-get install -y -qq --no-install-recommends \
  linux-image-amd64 \
  systemd-timesyncd \
  systemd-resolved \
  openssl \
  openssh-server \
  wireless-regdb \
  unattended-upgrades \
  sudo curl less nano iproute2 dbus nftables

# ─── Step 4: System configuration ────────────────────────────────────────────
echo "[4/9] Configuring the system..."

echo "${APPLIANCE_HOSTNAME}" > "${MNT}/etc/hostname"
cat > "${MNT}/etc/hosts" <<EOF
127.0.0.1	localhost
127.0.1.1	${APPLIANCE_HOSTNAME}
::1		localhost ip6-localhost ip6-loopback
EOF

cat > "${MNT}/etc/fstab" <<EOF
LABEL=${DISK_LABEL}	/	ext4	errors=remount-ro	0	1
EOF

# DHCP on eth0. net.ifnames=0 on the kernel command line keeps that name stable,
# which matters because /etc/issue prints the address of that interface.
mkdir -p "${MNT}/etc/systemd/network"
cat > "${MNT}/etc/systemd/network/10-dhcp.network" <<'EOF'
[Match]
Name=eth0 en*

[Network]
DHCP=yes
EOF
in_chroot systemctl enable systemd-networkd systemd-resolved >/dev/null 2>&1

in_chroot sh -c "echo 'root:${ROOT_PASSWORD}' | chpasswd"
in_chroot chage -d 0 root

# SSH ships switched off: root's factory password is in this very script. The
# console menu switches it on -- from the VM console, where root has already
# had to choose a password of its own. When on, root logs in with that password.
sed -i 's/^#\?PermitRootLogin.*/PermitRootLogin yes/' "${MNT}/etc/ssh/sshd_config"
in_chroot systemctl disable ssh.service ssh.socket >/dev/null 2>&1 || true
# Already as xenman-ssh-default would leave it, so that never touches it here.
mkdir -p "${MNT}/etc/xenman"
date -Is > "${MNT}/etc/xenman/ssh-default-done"

# ─── Step 5: Bootloader ──────────────────────────────────────────────────────
echo "[5/9] Installing the bootloader..."

# grub-install runs on the host, not in the chroot: grub-probe resolves the root
# device through /proc/self/mountinfo, which inside the chroot still describes
# the build directory rather than "/", and picks the wrong device.
grub-install \
  --target=i386-pc \
  --boot-directory="${MNT}/boot" \
  --modules="part_msdos ext2" \
  --no-floppy \
  --recheck \
  "${LOOP_DEV}"

# Written by hand instead of by update-grub, for the same reason. Debian keeps
# /vmlinuz and /initrd.img pointed at the current kernel, so this survives
# kernel upgrades inside the appliance.
mkdir -p "${MNT}/boot/grub"
cat > "${MNT}/boot/grub/grub.cfg" <<EOF
set timeout=2
set default=0

menuentry "XenMan Appliance" {
  search --no-floppy --label --set=root ${DISK_LABEL}
  linux /vmlinuz root=LABEL=${DISK_LABEL} ro console=tty0 console=hvc0 net.ifnames=0
  initrd /initrd.img
}
EOF

# ─── Step 6: Node.js and XenMan ──────────────────────────────────────────────
echo "[6/9] Installing Node.js ${NODE_VERSION} and building XenMan..."

NODE_TARBALL_PATH=$(NODE_TARBALL_DIR="${NODE_TARBALL_DIR}" bash "${REPO_ROOT}/appliance/fetch-node.sh" "${WORK_DIR}/node")
tar -xJf "${NODE_TARBALL_PATH}" -C "${MNT}/usr/local" --strip-components=1

# The same tarball also drives the packer in step 9, so the build host needs no
# Node installation of its own.
NODE_HOST_DIR="${WORK_DIR}/node-host"
mkdir -p "${NODE_HOST_DIR}"
tar -xJf "${NODE_TARBALL_PATH}" -C "${NODE_HOST_DIR}" --strip-components=1
NODE_BIN="${NODE_HOST_DIR}/bin/node"

mkdir -p "${MNT}/usr/src/xenman"
git -C "${REPO_ROOT}" archive --format=tar HEAD | tar -x -C "${MNT}/usr/src/xenman"

NPM_OFFLINE=""
if [ -n "${NPM_CACHE_DIR}" ]; then
  echo "  seeding the npm cache from ${NPM_CACHE_DIR}"
  mkdir -p "${MNT}/root/.npm"
  cp -r "${NPM_CACHE_DIR}/." "${MNT}/root/.npm/"
  # --ignore-scripts as well: some postinstall hooks fetch their own binaries
  # at install time (napi-postinstall does) instead of declaring them in the
  # lockfile, and no cache can satisfy that. Only ESLint plugins rely on those
  # hooks here — the production build does not.
  NPM_OFFLINE="--offline --ignore-scripts"
fi
in_chroot sh -c "cd /usr/src/xenman && npm ci --no-audit --no-fund ${NPM_OFFLINE}"
in_chroot sh -c "cd /usr/src/xenman && NEXT_PUBLIC_GIT_COMMIT='${GIT_TAG}' npm run build"

# Assemble /opt/xenman the way the Dockerfile assembles its runtime image.
in_chroot sh -c '
  set -e
  src=/usr/src/xenman
  dst=/opt/xenman
  rm -rf "$dst"
  mkdir -p "$dst"
  cp -r "$src/.next/standalone/." "$dst/"
  cp -r "$src/.next/static" "$dst/.next/static"
  cp -r "$src/public" "$dst/public"
  mv "$dst/server.js" "$dst/standalone-server.js"
  cp "$src/server.js" "$dst/server.js"
  cp "$src/vnc-proxy.js" "$dst/vnc-proxy.js"
  mkdir -p "$dst/node_modules" "$dst/.next/cache"
  cp -r "$src/node_modules/ws" "$dst/node_modules/ws"
  rm -rf "$dst/data" "$dst/src" "$dst/appliance" "$dst/Dockerfile" \
         "$dst/docker-compose.yml" "$dst/README.md" "$dst/docs"
'

# Sources plus the npm cache would add roughly a gigabyte to the .xva.
in_chroot rm -rf /usr/src/xenman /root/.npm

in_chroot useradd --system --home-dir /var/lib/xenman --create-home \
  --shell /usr/sbin/nologin xenman
in_chroot chown -R xenman:xenman /var/lib/xenman /opt/xenman

# ─── Step 7: Services ────────────────────────────────────────────────────────
echo "[7/9] Installing services..."

# Everything XenMan owns outside /opt/xenman -- units, the updater, the apt
# policy -- comes from appliance/rootfs and the scripts beside it, assembled
# exactly as an update package assembles them. The reasoning behind each file
# lives in the file.
#
# Taken from HEAD like the application, not from the working tree: an
# uncommitted edit to a unit must not slip into an image no commit describes.
APPLIANCE_SRC="${WORK_DIR}/appliance-src"
mkdir -p "${APPLIANCE_SRC}"
git -C "${REPO_ROOT}" archive --format=tar HEAD appliance | tar -x -C "${APPLIANCE_SRC}"
SYSTEM_TREE="${WORK_DIR}/system"
bash "${APPLIANCE_SRC}/appliance/assemble-system.sh" "${SYSTEM_TREE}" "${NODE_TARBALL_PATH}"
cp -r "${SYSTEM_TREE}/." "${MNT}/"

# The default maintenance window, written as the operator's policy and timer:
# neither ships in a package, so no update can reset what someone sets later.
# No daemon-reload -- nothing runs systemd inside the chroot.
in_chroot /usr/local/sbin/xenman-os-policy apply --no-reload --quiet

# The XenServer guest tools, installed now rather than at first boot, so the
# very first start already reports its address to XenServer. policy-rc.d keeps
# the package's own start attempt from running inside the chroot.
in_chroot /usr/local/sbin/xenman-guest-tools --no-start

# The console menu after root logs in on the VM console; xenman-console.service
# makes the same link on appliances that get the menu by update.
ln -sfn /usr/local/lib/xenman/console-profile.sh "${MNT}/etc/profile.d/xenman-setup.sh"

touch "${MNT}/var/lib/xenman-firstboot"
echo "${GIT_TAG}" > "${MNT}/opt/xenman/.version"

mkdir -p "${MNT}/etc/xenman"

# The floor for downgrade protection: without it, the first update on a fresh
# appliance could install any older signed release. Same record the updater
# writes after each successful update.
printf '{\n  "version": "%s",\n  "commit": "%s",\n  "builtAt": "%s",\n  "installedAt": "%s"\n}\n' \
  "${GIT_TAG}" "$(git -C "${REPO_ROOT}" rev-parse --short HEAD)" \
  "$(date -u +%Y-%m-%dT%H:%M:%S.000Z)" "$(date -u +%Y-%m-%dT%H:%M:%S.000Z)" \
  > "${MNT}/etc/xenman/installed-release"
chmod 0644 "${MNT}/etc/xenman/installed-release"

if [ -n "${RELEASE_KEY_PUB}" ] && [ -f "${RELEASE_KEY_PUB}" ]; then
  cp "${RELEASE_KEY_PUB}" "${MNT}/etc/xenman/release-key.pub"
  chmod 0644 "${MNT}/etc/xenman/release-key.pub"
  echo "  update channel enabled with $(basename "${RELEASE_KEY_PUB}")"
else
  echo "  Note: RELEASE_KEY_PUB not set -- the appliance will refuse updates."
  echo "        Create a key with: node appliance/xenup.js keygen --out <dir>"
fi

# The web interface writes the package and the trigger here, so it must own the
# directory -- this runs after the chown in step 6, hence a second one.
mkdir -p "${MNT}/var/lib/xenman/updates"
in_chroot chown xenman:xenman /var/lib/xenman/updates
in_chroot chown xenman:xenman /opt/xenman/.version

in_chroot systemctl enable xenman.service xenman-firstboot.service \
  xenman-updater.path xenman-os-request.path apt-daily.timer apt-daily-upgrade.timer \
  xe-linux-distribution.service xenman-guest-tools.timer xenman-console.service   xenman-credential.service xenman-firewall.service >/dev/null 2>&1

# agetty expands \4{eth0} to that interface's current address, so the console
# shows where to point a browser.
cat > "${MNT}/etc/issue" <<'EOF'

XenMan Appliance

  Web interface:  https://\4{eth0}/
  Console login:  root  (password change required at first login)
                  then a menu for network settings, password resets
                  and SSH access (off until switched on there)

EOF

# ─── Step 8: Clean up the image ──────────────────────────────────────────────
echo "[8/9] Cleaning up and zeroing free space..."

in_chroot apt-get clean
rm -f "${MNT}/usr/sbin/policy-rc.d"
rm -rf "${MNT}/var/lib/apt/lists/"*
rm -f "${MNT}/etc/ssh/ssh_host_"*
rm -f "${MNT}/var/log/"*.log "${MNT}/var/log/"*/*.log 2>/dev/null || true
: > "${MNT}/etc/machine-id"
rm -f "${MNT}/var/lib/systemd/random-seed"

# Hand DNS back to systemd-resolved instead of shipping the build host's
# nameservers inside the appliance.
rm -f "${MNT}/etc/resolv.conf"
ln -s ../run/systemd/resolve/stub-resolv.conf "${MNT}/etc/resolv.conf"

umount -R "${MNT}/dev" "${MNT}/proc" "${MNT}/sys" 2>/dev/null || true

# Deleted files still hold their old bytes, and the packer only skips chunks
# that are entirely zero. Without this the .xva carries every byte ever written
# to the disk, including the discarded npm cache and package archives.
#
# fstrim punches holes in the backing file and costs seconds. Writing a file of
# zeroes costs as many gigabytes as the disk has free space, so it is only the
# fallback for a kernel or filesystem that refuses to discard.
if fstrim "${MNT}" >/dev/null 2>&1; then
  echo "  freed unused blocks with fstrim"
else
  echo "  fstrim unavailable — zeroing free space the slow way"
  dd if=/dev/zero of="${MNT}/ZEROFILL" bs=1M status=none 2>/dev/null || true
  rm -f "${MNT}/ZEROFILL"
fi
sync

umount -R "${MNT}"
losetup -d "${LOOP_DEV}"
LOOP_DEV=""

# ─── Step 9: Pack ────────────────────────────────────────────────────────────
echo "[9/9] Packing the .xva..."

"${NODE_BIN}" "${REPO_ROOT}/appliance/xva-pack.js" pack \
  --disk "${DISK_IMAGE}" \
  --out "${XVA_FILE}" \
  --name "${VM_NAME}" \
  --description "${VM_DESCRIPTION} (${GIT_TAG})" \
  --memory-mb "${VM_MEMORY_MB}" \
  --vcpus "${VM_VCPUS}"

"${NODE_BIN}" "${REPO_ROOT}/appliance/xva-pack.js" verify --xva "${XVA_FILE}"

echo ""
echo "=== Build complete ==="
echo "Appliance: ${XVA_FILE}"
echo ""
echo "Import with:  xe vm-import filename=$(basename "${XVA_FILE}")"
echo "or in XenCenter: File > Import."
