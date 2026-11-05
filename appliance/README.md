# XenMan Appliance

Builds a ready-to-import XenServer VM: Debian 13 with XenMan running under
systemd, delivered as a single `.xva` file.

The build needs **no XenServer host**. The `.xva` is assembled directly from a
disk image, so the whole thing runs on any Debian or Ubuntu machine with root.

```
appliance/
├── build-appliance.sh   the build: disk image → Debian → XenMan → .xva
├── build-update.sh      a signed update package (.xenup) from HEAD
├── assemble-system.sh   the system files both builds ship
├── node-version         the Node.js release both builds ship, with its pinned digest
├── fetch-node.sh        gets that tarball and checks it against the digest
├── check-node.sh        warns when node-version is behind its line, loudly for security releases
├── rootfs/              units and apt policy, laid out as on the appliance
├── xenman-updater       installs update packages on the appliance (root)
├── xenman-os-update     installs Debian security updates and logs them (root)
├── xenup.js             builds, signs and verifies packages
├── audit-append.js      writes audit entries for the root services
├── xva-pack.js          raw disk image → .xva (also verifies one)
└── README.md
```

## Prerequisites

A Debian or Ubuntu build machine (a VM is fine), root, ~25 GB free disk, and:

```sh
apt-get install debootstrap fdisk util-linux e2fsprogs curl tar xz-utils grub2-common grub-pc-bin git
```

Node.js is *not* required on the build host — the script downloads the Node
tarball for the appliance and reuses it to run the packer.

Windows is not a build platform: `debootstrap`, loop devices and `chroot` are
Linux-only. WSL works if it is installed.

## Building

```sh
sudo ./appliance/build-appliance.sh
```

Roughly 10–20 minutes, most of it `debootstrap` and `npm run build`. The result
lands in `dist/xenman-appliance-<tag>.xva`, about 1.5 GB.

The appliance is built from **HEAD**, not from the working tree (`git archive`),
so commit before building. The script warns if the tree is dirty.

Knobs live in the configuration block at the top of the script: Debian suite,
disk size, RAM, vCPUs, hostname, and the initial root password. The Node.js
release is in `node-version`, shared with the update packages.

## Building behind a proxy

The build fetches two things from the internet: the Node tarball and the npm
packages. Debian packages travel over plain HTTP and usually pass a proxy
untouched; the other two are HTTPS, and a proxy that demands authentication
will answer them with `407` — npm included, since it brings its own HTTP stack
rather than using the system's credentials.

Two variables let you supply both from disk instead:

```sh
NODE_TARBALL_DIR=/path/with/node-v24.22.2-linux-x64.tar.xz NPM_CACHE_DIR=/path/to/_cacache/parent   ./appliance/build-appliance.sh
```

`NPM_CACHE_DIR` is a directory holding a `_cacache` folder — the layout npm
uses under `~/.npm`. Populate it on a machine that *can* reach the registry:

```sh
npm ci --cache /path/to/cache --os=linux --cpu=x64 --ignore-scripts
```

`--os=linux --cpu=x64` matters: Next.js ships its compiler as per-platform
binaries, and a cache filled on Windows or macOS would carry the wrong ones.

If a few packages are missing from an existing cache, fetch those tarballs by
whatever means the network allows and add them individually — npm finds them
again by content hash:

```sh
npm cache add ./some-package-1.2.3.tgz
```

## Importing

```sh
xe vm-import filename=xenman-appliance-<tag>.xva
```

Or in XenCenter: *File → Import*. Xen Orchestra imports the same file.

On import xapi mints a fresh MAC address, so the file can be imported repeatedly
into the same pool.

## What you get

| | |
|---|---|
| OS | Debian 13 (trixie), minimal |
| Console login | `root` / `xenman` — a password change is forced at first login |
| Web login | `admin` / `admin` — nothing else opens until it is changed |
| SSH | off; switched on and off in the console menu only (root, with its own password) |
| Network | DHCP on `eth0` until set otherwise; the console shows the address it got |
| Web | `https://<address>/` (port 443, plus plain HTTP on 80) |
| Service | `xenman.service`, logs via `journalctl -u xenman` |
| Data | `/var/lib/xenman` — users, JWT secret, generated TLS certificate |
| Install | `/opt/xenman`, Node in `/usr/local` |
| Guest tools | XenServer VM Tools for Linux (`xe-guest-utilities`), agent `xe-linux-distribution.service` |

### Network settings

Under **Settings > Appliance > Network**: DHCP or a static IPv4 address, gateway, up to
three DNS servers, search domains and the host name. A change is applied on
probation: if the appliance moves to another address, the page shows a link to
the new one, and unless it is opened within 90 seconds the previous settings
return on their own — so a typo cannot lock anyone out. A change that keeps the
address is confirmed by the page itself.

On the VM console, logging in as root opens a menu that does the same without
a browser — for the first setup in a network without DHCP, or after a wrong
address:

```
    1) Show network               5) Restart XenMan
    2) Configure network          6) Restart the appliance
    3) Test connectivity          7) Shut down the appliance
    4) Reset an administrator's password
                                  8) SSH access (off)
    0) Exit to the shell
```

SSH is off on a new appliance, and appliances updated from an older release
switch it off once (`xenman-ssh-default`): root's factory password is no secret.
Item 8 switches it on or off; the web interface only shows the state. Both
changes appear in the audit log.

It works with digits and plain words, whatever the console's keyboard layout,
and opens again with `xenman-setup`. "Reset an administrator's password"
clears the password and shows a link, valid for 30 minutes, to choose a new
one in the browser. On the command line, `xenman-network show|set|test` does
the same as the menu.

XenMan writes only `/etc/systemd/network/05-xenman.network` and
`/etc/xenman/network.json`; without them the image's plain DHCP applies again.

With the guest tools, XenServer shows the appliance's IP address and operating
system, and can shut it down or restart it cleanly. They come with the
appliance's own updates (the package is in `appliance/vendor/`), not from a
Debian repository; an update that carries a newer release installs it, and a
newer one installed by hand is never replaced by an older one.

XenMan generates its own self-signed certificate on first start, so the browser
will warn once. Under **Settings > Appliance > HTTPS Certificate** a certificate from your
own CA replaces it — PEM files (certificate, key, optional intermediates, an
encrypted key with its passphrase) or a PFX. The key is checked against the
certificate before anything changes, and XenMan switches over without a
restart. From 30 days before expiry, admins see a notice on every page.

Under **Settings > Appliance > Date & Time**: the time zone (for the console and system
logs; the maintenance window keeps its own) and up to five NTP servers —
needed where public NTP is blocked. The card shows whether the clock is
synchronised and warns when it differs from the browser's.

The **Appliance** card shows uptime, load, memory and disk use. From 85 %
disk use admins see a notice on every page, red from 95 %.

Anything that has to be unique per copy — SSH host keys, machine ID, JWT secret,
TLS certificate — is created on first boot, not baked into the image.

## Updating

Three things update on their own schedule, and they are deliberately separate.

### Debian security updates — in a maintenance window

`unattended-upgrades` installs from `trixie-security` only, at a time you set:
by default Sunday 02:00 Europe/Berlin, without an automatic restart. Packages
are downloaded ahead on apt's own daily schedule, so the window does not depend
on the mirror answering at that hour.

```sh
xenman-os-policy show                              # what is set, and the next run
xenman-os-policy set --days Sat,Sun --time 03:30   # when
xenman-os-policy set --days daily                  # every day
xenman-os-policy set --timezone Europe/Vienna      # the zone the time is in
xenman-os-policy set --reboot yes                  # restart in the window when needed
xenman-os-policy set --mode manual                 # only when asked
xenman-os-update                                   # install now, whatever the mode
```

The same settings are in the web interface under **Settings > Appliance > Security
Updates**, together with the list of pending packages and buttons to check
for new updates, install now or restart. The appliance also checks once a day
on its own. While "Install now" runs, the card shows the installation's output
as it happens; the log of the last run, scheduled or not, stays available under
"Last run" (on the console: `/var/log/xenman/os-install.log`). "Restart now"
shows a restart page with a one-minute countdown that follows the appliance
going down and coming back, and reloads once XenMan answers again. XenMan does not run apt or systemctl for this itself: it drops
a request, and `xenman-os-request`, running as root, checks and carries it out
-- the same split as for application updates. Every change is audited under
the name of whoever asked.

The window has its own time zone, so 02:00 stays 02:00 across daylight saving
time while the appliance itself runs on UTC. A run may start up to two hours
after the window opens. A window missed because the appliance was off is
skipped rather than caught up at the next boot -- that would install outside
it -- and the next window installs what is pending.

The timer only starts a run; the policy decides whether it installs. Every
scheduled run checks the window itself, so a timer firing at the wrong moment
cannot install outside it. In manual mode the daily run still happens but
installs nothing. Without `--reboot yes`, a kernel or library update records
the need in `/var/run/reboot-required` and leaves the restart to you.

The policy lives in `/etc/xenman/os-update-policy.json`, and the timer is
generated from it. No update package ships either, so no update resets the
window you chose.

Optionally, updates left waiting get harder to overlook. With **Show reminders
for overdue security updates** switched on under Settings > Appliance > Security Updates
(off by default), admins see a notice on every page of XenMan after 7 days;
after 14 days it turns red and can no longer be dismissed. A failed
installation shows a notice at once. With **Send email notifications to administrators** switched on
as well, every admin with an email address gets a mail when the notice appears,
another when it turns red, and then one a week while it stays red. This needs
the mail server set up under Settings. Viewers and operators see none of it.

Every run that changes something lands in the XenMan audit log as
`os_security_update`, with each package and its old and new version. Days with
nothing pending are not logged there -- one entry a day saying nothing happened
would bury the ones that matter -- but every run is recorded in
`/var/lib/xenman/updates/os-status.json`.

```sh
xenman-os-update --dry-run               # what it would install
journalctl -u apt-daily-upgrade          # what each run did, or why it skipped
```

This works by replacing apt's own install step: a drop-in points
`apt-daily-upgrade.service` at `xenman-os-update`, so there is one path by which
the operating system changes, and it is the logged one.

If the appliance can only reach the Debian mirrors through a proxy, set it
under **Settings > Appliance > Security Updates > Proxy**, with a login if the proxy needs
one. It is used for Debian updates only; connections to your hosts do not go
through it. After saving, the appliance checks the connection straight away.
**Check now** tells you at any time whether the mirrors can be reached.

### XenMan — signed update packages

Create a signing key **once**, on a machine that is not the appliance:

```sh
node appliance/xenup.js keygen --out ~/.xenman-keys
```

The private half signs releases and must not leave that machine. The public
half is baked into every appliance you build:

```sh
RELEASE_KEY_PUB=~/.xenman-keys/release-key.pub sudo -E ./appliance/build-appliance.sh
```

An appliance built without it refuses every update, because there would be
nothing to check a package against.

Build a package from the current HEAD:

```sh
RELEASE_KEY=~/.xenman-keys/release-key ./appliance/build-update.sh
```

Install it in the web interface under **Settings > Appliance > XenMan Updates**: upload the
`.xenup`, check the version it reports, and confirm. The page keeps polling
while XenMan restarts under it and reconnects on its own.

The same package installs from the console, which is the way in before an
appliance has the update UI at all:

```sh
xenman-updater /path/to/xenman-v1.9.0.xenup
```

The installer checks the signature before touching anything, keeps the previous
version in `/opt/xenman.bak`, copies `/var/lib/xenman` aside, and waits for
XenMan to answer after the restart. If it does not answer within 60 seconds,
the previous version is put back automatically. Progress is written to
`/var/lib/xenman/updates/status.json`, and the result lands in the audit log.

Packages older than the installed version are refused, compared by the build
time in the signed manifest. An older release is still genuinely signed, but it
may carry a vulnerability a later one fixed -- installing one is the classic
attack on signed updates. Reinstalling the same commit is allowed. Going back
on purpose takes a root shell; the web interface cannot ask for it:

```sh
xenman-updater --allow-downgrade /path/to/older.xenup
```

What is installed is recorded in `/etc/xenman/installed-release`: root-owned,
so XenMan cannot backdate it, and updated only once an update has passed its
health check, so a rolled-back one does not move it.

Rolling back by hand needs no package and no network:

```sh
systemctl stop xenman
rm -rf /opt/xenman && mv /opt/xenman.bak /opt/xenman
systemctl start xenman
```

Why the signature: the update is triggered from the web interface, and the
installer runs as root. Without it, anyone reaching an admin session could run
code as root on the machine that holds the credentials to your pools. XenMan
runs as an unprivileged user that cannot write `/opt/xenman` at all -- it only
drops a package and a trigger file, and the updater decides against the release
key whether any of it gets installed.

A package replaces `/opt/xenman` and the system files XenMan ships --
everything under `appliance/rootfs`, plus the updater and its helpers. It never
touches the network configuration, hostname, SSH settings or bootloader: those
belong to whoever runs the appliance, and an update must not reset a static IP.
A unit that is new with a package is enabled, as a fresh `.xva` would have it;
one that existed before keeps its state, so a unit you disabled on purpose stays
disabled.
To change a shipped unit, use `systemctl edit`, whose override survives
updates; apt settings of your own go in a separate file in
`/etc/apt/apt.conf.d/`. A failed or interrupted update rolls the system files
back together with the application.

Appliances built before system files could be updated refuse these packages
outright rather than install half of one. Move them across once by importing a
freshly built `.xva`; from then on, packages carry the rest.

**Node.js** comes along the same way. apt does not know the Node.js in
`/usr/local` -- it comes from nodejs.org -- so a security release of Node.js
reaches an appliance only through a package: raise `node-version` (release and
the tarball's line from `SHASUMS256.txt`), build, install. The package carries
`/usr/local/bin/node` alone; npm and the headers are only needed to build. The
updater runs the new binary once before installing anything and refuses the
package if it does not start, keeps the old one for the rollback, and names the
change in the audit log. *Settings > Updates* shows the Node.js running.

An updater from before this refuses a package carrying Node.js (*reaches
outside the paths XenMan owns: usr/local/bin/node*). Cross over once with a
bridge built without it, `WITH_NODE=0 ./appliance/build-update.sh`
(`xenman-<tag>-bridge.xenup`): it brings the updater that accepts Node.js, and
the full package installs after it.

`build-update.sh` checks on every build whether `node-version` is still the
newest release of its line (`check-node.sh`, against nodejs.org's
`dist/index.json`) and warns -- with `!!` when a security release was missed.
It never stops a build; behind a proxy that wants a login, fetch the list
elsewhere and point `NODE_INDEX_FILE` at it. A newer major line is only
mentioned.

### Debian or Node major versions — a new appliance

Point releases of Debian and Node major versions are not delivered as packages
(Node.js releases within a major are, see above).
Build a fresh `.xva`, import it, stop the old appliance and copy
`/var/lib/xenman` across with both services stopped. Rebuilding every few
months also keeps *new* deployments from starting out months behind on patches.

## The .xva format

An XVA is an uncompressed tar archive:

```
ova.xml                                   the XAPI object model
Ref:VDI-1-root/00000000000000000000       disk data, exactly 1 MiB per file
Ref:VDI-1-root/00000000000000000000.checksum   SHA-1 of that chunk, hex
```

Chunks that are entirely zero are omitted and filled in with zeroes on import —
that is what keeps a 20 GiB disk down to a ~1.5 GB file, and why the build zeroes
free space before packing.

`ova.xml` is XML-RPC. Every value is a bare string, including 64-bit numbers,
except booleans and doubles, which carry their own tags. It declares six
objects: `VM`, `VBD`, `VIF`, `network`, `VDI`, `SR`.

The field set in `xva-pack.js` was taken from a known-importable appliance —
a vendor-built appliance XVA, `export_vsn 2`, XenServer 7.1.2 — rather
than from documentation, and matches it field for field, in the same order, with
the same types.

To check a file the packer produced:

```sh
node appliance/xva-pack.js verify --xva dist/xenman-appliance-<tag>.xva
```

That re-reads every chunk and compares it against its stored checksum. It
confirms the archive is internally consistent; whether *xapi* accepts it is only
proven by an actual import.
