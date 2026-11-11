# Changelog

All notable changes to XenMan. Each release on GitHub takes its notes from the
section of its version here; a release candidate (`v1.2.3-rc.1`) from the
section of the version it leads to.

## [1.0.4] - Unreleased

### Added
- **Pools at other sites: hosts behind NAT.** A pool reached only through NAT, such as a firewall's virtual IP, could be managed, but its consoles, performance graphs, imports and SSH exports failed: XenServer hands those out at the hosts' own management addresses, as XenCenter finds too. A pool can now be told where each of its hosts is reached: an address of its own, or one address with a port per host (`1.2.3.4:4431`). Switched on as **Hosts are behind NAT** when adding a pool or when editing it; off by default. The hosts' certificates are checked as before.

### Fixed
- **Updates: an evacuation XenServer does not finish.** XenServer's host evacuation can hang with the host already empty (seen at 97 % for an hour after one migration failed). XenMan no longer waits out the full hour: once the host has been empty for 5 minutes, it cancels the evacuation and goes on.
- **Updates: a host XenServer keeps blocked.** When XenServer does not let go of a cancelled evacuation, it keeps the host marked as being evacuated and refuses every VM migration to it, even across the host's restart. XenMan now notices this instead of trying each VM four times: the update pauses, administrators get a mail ("attention needed"), and the update offers **Restart the coordinator's toolstack and continue**, which clears it. VMs keep running; tools connected to the pool lose their connection for about a minute.

### Changed
- When XenServer refuses something because an object is busy, XenMan now says which one and with what (for example "host "xs-01" is busy (evacuate)") instead of "Another operation is running on the pool".
- The audit log now also records a changed backup address and SSH port of a pool.

## [1.0.3] - 2026-11-11

### Security
- Node.js 24.22.3, a security release of Node.js (10 November 2026). XenMan 1.0.2 otherwise unchanged.

## [1.0.2] - 2026-11-11

### Added
- **Copy VM**: fast clone or full copy onto another storage repository of the pool, with XenCenter's checks for which SRs can take the copy.
- **Convert to Template**, and **Save as Template** for snapshots.
- **Import** of a VM from an XVA file, uploaded from the browser: home server, storage and network mapping as in XenCenter's import wizard; optionally started afterwards.
- **Virtual GPUs of a VM**: a GPU tab per VM to add and remove vGPUs or pass a whole GPU through, with XenCenter's rules for which types may share a VM and its notes on drivers, Remote Desktop and HA.
- **Storage repository commands** in the Storage tab: Repair, Detach, Forget, Destroy, Set as Default and Reclaim freed space, with XenCenter's checks and questions; Destroy also asks for the SR's name. Broken, detached and default SRs are marked.

### Changed
- Menu entries and buttons no longer end in "...".
- **Everyone signs in once more after this update**: sessions from before it are no longer accepted (see Security).

### Fixed
- Entering maintenance mode left VMs on the host when XenServer's evacuation found no plan (HOST_NOT_ENOUGH_FREE_MEMORY although memory was free). It now works as in XenCenter: WLB's evacuation recommendations are followed when WLB is on, and VMs WLB has no host for are migrated live one by one; without WLB, VMs are migrated live one by one when the evacuation fails; and the host leaves maintenance mode again if anything cannot be moved. The control domain memory dialog waits until the host is empty.
- Memory tab: no white band above the names of the VMs on wider screens.
- After a pool update (or anything else that restarts XenServer's toolstack) the browser kept the pool's old session: the pool still showed as connected but no longer updated, and tabs such as WLB showed SESSION_INVALID until the page was reloaded. XenMan now connects to the pool again by itself, with auto refresh on or off; the bell is no longer emptied meanwhile.
- A VM with a long name: the name is cut short (the full name on hover), and the buttons above the VM stay together in one row instead of the delete button dropping onto a line of its own.

### Security
- SSH export of VMs and disks: the export directory and UUID are validated and quoted before they reach the shell on the host. Previously a user allowed to export could run arbitrary commands there.
- **HTTPS only**: plain HTTP is redirected to HTTPS (on the appliance, port 80 to 443; in Docker, 3000 to 3001), HTTPS responses carry HSTS, and the session cookie is always Secure, HttpOnly and SameSite=Lax. Requests from the machine itself, and from a trusted proxy that received them over HTTPS (`XENMAN_TRUST_PROXY=1`, `X-Forwarded-Proto: https`), are left alone.
- **Consoles**: viewers can no longer open a console (it takes keyboard and mouse), checked in the API and in the console proxy; a host's control domain is only reachable as the host console, which is for administrators. The console proxy connects only to a console XenMan handed out on that session, instead of any address the browser names.
- **Sign-ins**: a session ends when it signs out, and all of an account's sessions when its password is changed or set by an administrator, a reset link is used, or the account is removed; a changed role counts at once. Administrators can sign a user out everywhere. Reset and invitation links sent before a new password no longer work.
- **Passwords**: at least 12 characters with a lowercase letter, an uppercase letter and a number; not containing the user name, and not one of the most common passwords. Existing passwords keep working until they are changed.
- Next.js 16.4.5 and sharp 0.35.5 fix their published advisories (WebSocket upgrade SSRF, image optimization).
- The generated TLS key and a PFX file are readable by XenMan alone.
- Invitation and password reset mails no longer take markup in a user name as HTML.
- No XenMan page can be put in a frame on another site, where a signed-in administrator could be made to click on it unseen; responses also carry `X-Content-Type-Options: nosniff` and `Referrer-Policy: same-origin`. Each server takes at most 1000 open connections (`XENMAN_MAX_CONNECTIONS`).

## [1.0.1] - 2026-11-06

### Added
- Releases are built by GitHub Actions: the appliance, the signed update package and a Docker image on `ghcr.io/xenman-project/xenman`.
- The public release key in `appliance/release-key.pub`, to verify update packages.

### Changed
- `docker-compose.yml` runs the published image instead of building it.
- README: screenshots, a shorter feature list, what is not included yet, and a note on how XenMan is built.

## [1.0.0] - 2026-11-05

First public release.

- Pools and hosts: several pools at once, maintenance mode, adding and removing servers, control domain memory, certificate pinning.
- VMs: create, start/stop, migrate, edit CPU, memory, disks, network and boot settings; browser console and RDP file.
- Memory, storage, networking (bonds, VLANs, management interface) and GPU tabs, following XenCenter.
- Host updates with mail notification, License Manager, Workload Balancing.
- Performance graphs, alerts, events and an audit log; Admin, Operator and Viewer roles.
- Appliance for XenServer with signed update packages.
