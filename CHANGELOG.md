# Changelog

All notable changes to XenMan. Each release on GitHub takes its notes from the
section of its version here; a release candidate (`v1.2.3-rc.1`) from the
section of the version it leads to.

## [1.0.2] - Unreleased

### Added
- **Copy VM**: fast clone or full copy onto another storage repository of the pool, with XenCenter's checks for which SRs can take the copy.
- **Convert to Template**, and **Save as Template** for snapshots.
- **Import** of a VM from an XVA file, uploaded from the browser: home server, storage and network mapping as in XenCenter's import wizard; optionally started afterwards.

### Changed
- Menu entries and buttons no longer end in "...".

### Security
- SSH export of VMs and disks: the export directory and UUID are validated and quoted before they reach the shell on the host. Previously a user allowed to export could run arbitrary commands there.

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
