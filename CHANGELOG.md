# Changelog

All notable changes to XenMan. Each release on GitHub takes its notes from the
section of its version here; a release candidate (`v1.2.3-rc.1`) from the
section of the version it leads to.

## [1.0.5] - Unreleased

### Added
- **Sign in with Microsoft Entra ID.** Under Settings > Security an administrator enters the app registration (tenant ID, client ID, client secret) and XenMan's address; the sign-in page then offers **Sign in with Microsoft**. The role comes from the app roles `XenMan.Admin`, `XenMan.Operator` and `XenMan.Viewer` at every sign-in; someone without one does not get in. XenMan creates the account at the first sign-in; pool access is still given in XenMan. MFA is left to Entra ID, so XenMan's two-factor code is not asked of these accounts. Password sign-in can be left to administrators only, as the way in when Entra ID is down. XenMan checks the ID token itself (signature against the tenant's keys, issuer, audience, tenant, nonce, PKCE), with no new dependency. The client secret is stored encrypted. See the README for setting up the app registration.
- **Updates: tasks for full effectiveness and live patches.** XenServer sorts the tasks after an update into mandatory, recommended and full effectiveness; the last are needed only for specific hardware or features. XenMan showed none of these, so a host restart XenCenter lists under "Update tasks for full effectiveness" did not appear. The Updates tab now shows them per host and per update ("Full effectiveness: Restart host"), the components with live patches ("Live patch: Xen, Kernel") and tasks still pending from an earlier update, recommended and full effectiveness included. The Install Updates dialog offers **Also perform tasks for full effectiveness** (off by default, with automatic restarts only) and says per host what is not performed.
- **Recent Tasks**, docked at the bottom of every view -- resizable at its top edge and collapsible -- for the selected VM, host or pool, or every pool on the dashboard; on a phone a card in the overview of a pool or host. It lists what is running and what ended in the last 24 hours, with progress, the latest steps of an update and Cancel where XenServer allows it. XenMan's own actions and jobs show who started them; tasks of other clients, such as XenCenter or xe, are listed too (XenServer does not record their user). Operators may cancel a VM's task, administrators any.
- **Configure Updates**, as in XenCenter: per pool, the update channel (Normal or Early Access), automatic synchronization (daily, or weekly on a chosen day) and a proxy server for the update channel, with XenCenter's calls. After a new channel, synchronizing is offered. The proxy password is kept by XenServer and never sent to the browser. The Updates tab now names the channel as XenCenter does ("Normal" instead of `normal_repo`). Administrators only.
- **Snapshot schedules**, as in XenCenter: per pool, schedules that take snapshots of their VMs hourly, daily or weekly (disk only, or disk and memory where the licence allows) and keep the last 1 to 10. A Snapshot Schedules tab lists them with their VMs, the next run in the pool's time and in yours, and the result of their last runs from XenServer's alerts; schedules can be created, edited, enabled or disabled, run at once and deleted. A VM's Snapshots tab shows the schedule it is in, lets it be changed and leads to the schedules. Administrators and operators.
- **Several VMs at once**, as in XenCenter: in the VMs tab of a pool or a host, VMs can be ticked (or all of them) and started, shut down (optionally forced) or rebooted together; each counts as an action of its own in Recent Tasks and the audit log. Administrators and operators.
- **Updates on a pool of one host with VMs running**: the Install Updates dialog offers to shut the VMs down before the update and start them again afterwards, as there is no other host to move them to. VMs that do not shut down within 10 minutes are forced off.

### Fixed
- **Updates on a pool of one host were refused** with "no other host is available for running VMs" although every VM was shut down (#8). The update is now refused only while VMs run or are paused on the host, and names them; with none, the host is not evacuated at all.
- **Updates: a failed live patch went unnoticed.** XenServer then asks for a host restart as a recommended task, which XenMan did not read, so the host kept running without the fix. With automatic restarts the host is now evacuated and restarted; without them, the update says so.

### Security
Fixes from a security review of XenMan.
- **Every user's browser held the pool's XenServer session**, viewers included. That session is opened with the pool's stored account, as a rule root, so whoever could reach the pool directly could use it past XenMan's roles, and it stayed valid after the XenMan account was signed out or removed. The browser now only gets a random handle that works through XenMan alone; the XenServer session never leaves XenMan. Signing out, being signed out everywhere, losing a pool or the account's removal now also end the XenServer session at the pool.
- **Operators could restart or shut down a XenServer host** through the API, although the Power menu is shown to administrators only. Both are now for administrators only, as disabling a host already was.
- **Operators could set any key in a host's `other_config`** through two API actions the interface never used. They are removed.
- **An operator's SSH export could write anywhere on the host as root**, for example filling the control domain's file system. Operators now export below `/mnt`, `/media` or an SR's mount point, and only into a mounted file system; administrators as before. An export's status is only shown to whoever started it and to administrators.
- **A console that was open stayed open** after signing out, losing the pool, being made an operator (for a host's own console) or being deleted, and such a user could open a console again from an earlier session. Consoles are now checked when they open and every half minute while open.
- **Requests from other sites (CSRF).** Beyond the SameSite cookie, XenMan now refuses any request that changes something unless it comes from its own pages (`Sec-Fetch-Site`, else `Origin`). This also covers the sign-in itself and requests from another subdomain or port of the same host.
- **A WebSocket upgrade to any other path was never answered.** Enough such connections, without signing in, filled XenMan's connection limit until it restarted. They are now answered and closed.
- **The appliance's updater followed a symbolic link at its trigger file** and named what it read in its error message, which XenMan could read. The trigger and the uploaded package now have to be plain files, the trigger has to name the uploaded package, and nothing from it is repeated back.
- **The user list sent administrators the links of password resets** other users had asked for. It no longer does.
- nodemailer 10.3.1 and ws 8.22.1, which fix known issues in both.

### Changed
- The Updates tab, the Install Updates dialog and the update progress use shorter, XenCenter-style wording (for example "Install Updates", "Evacuate host", "Exit maintenance mode").

## [1.0.4] - 2026-11-16

### Added
- **Pools at other sites: hosts behind NAT.** A pool reached only through NAT, such as a firewall's virtual IP, could be managed, but its consoles, performance graphs, imports and SSH exports failed: XenServer hands those out at the hosts' own management addresses, as XenCenter finds too. A pool can now be told where each of its hosts is reached: an address of its own, or one address with a port per host (`1.2.3.4:4431`). Switched on as **Hosts are behind NAT** when adding a pool or when editing it; off by default. The hosts' certificates are checked as before.
- **PVS-Accelerator**, as in XenCenter: a PVS tab per pool lists the VMs with their PVS site and read caching status, switches read caching on and off for selected VMs, and configures each PVS site's cache per server (memory or a storage repository, and its size), adds and removes sites and shows a site's PVS servers. A running VM's overview shows its PVS-Accelerator status. Needs the PVS-Accelerator licence; switching on and off is for operators and administrators, configuring for administrators. Unlike XenCenter, XenMan names the VMs it skips (no network interface 0, or already on), and setting a server to "Not configured" only removes its cache instead of putting one in memory.
- **iSCSI: scan the target**, as XenCenter's New Storage wizard does (#4): **Scan Target Host** lists the target's IQNs, and choosing one lists its LUNs, so neither has to be typed. Before anything is written, XenMan looks at what is on the LUN and asks, as XenCenter: **Reattach** the SR found there (a known detached SR gets its connections back; one from elsewhere is introduced to the pool), or **Format** the LUN for a new SR. A LUN an SR of the pool already uses is refused. The description is made from target, IQN and LUN unless switched off.
- **Two-factor sign-in** with an authenticator app (#5): under Settings > Account each user can turn on a code from Microsoft or Google Authenticator, 1Password and the like (TOTP), set up with a QR code drawn by XenMan itself. Ten recovery codes, each good once, cover a lost phone. Under Settings > Security an administrator can require it for administrators or for everyone; whoever it covers and has not set it up is asked to at the next sign-in, and can do nothing else until then. An administrator can reset a user's two-factor sign-in (Users), and on the appliance the console menu can turn it off for an administrator. Wrong codes count like wrong passwords; a code is good once; the key is stored encrypted, the recovery codes only as hashes. A password reset by mail leaves it on.
- **A new pool coordinator.** Putting the coordinator into maintenance mode now offers a new one, as XenCenter does: the other servers that are enabled and running, the first one chosen. Once the coordinator is empty, the chosen server takes over. Unlike XenCenter, **Keep as coordinator** can be chosen too, which leaves things as before. **Make Pool Coordinator** in a member server's menu makes it the coordinator straight away, with no VMs moved. A change is refused, in XenCenter's words, while a pool secret rotation is pending or HA is being switched on or off. XenMan connects to the pool again on its own afterwards. Administrators only.

### Fixed
- **Updates: an evacuation XenServer does not finish.** XenServer's host evacuation can hang with the host already empty (seen at 97 % for an hour after one migration failed). XenMan no longer waits out the full hour: once the host has been empty for 5 minutes, it cancels the evacuation and goes on.
- **Updates: a host XenServer keeps blocked.** When XenServer does not let go of a cancelled evacuation, it keeps the host marked as being evacuated and refuses every VM migration to it, even across the host's restart. XenMan now notices this instead of trying each VM four times: the update pauses, administrators get a mail ("attention needed"), and the update offers **Restart the coordinator's toolstack and continue**, which clears it. VMs keep running; tools connected to the pool lose their connection for about a minute.

### Changed
- A new iSCSI SR keeps its CHAP password as a XenServer secret, as XenCenter does, instead of in plain text in the SR's settings.
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
