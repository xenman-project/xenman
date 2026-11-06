> **Beta.** XenMan is beta software: it is in daily use, but expect rough edges. Try it on a test pool before you rely on it, and please report problems as issues.

## Appliance

`xenman-appliance-{{TAG}}.xva` is a ready-to-import XenServer VM: Debian 13 with XenMan running under systemd (2 vCPUs, 2 GiB RAM, 20 GiB disk).

1. Import it: `xe vm-import filename=xenman-appliance-{{TAG}}.xva`, or in XenCenter under *File → Import*.
2. Start the VM. The console shows the address it got by DHCP.
3. Open `https://<address>/` and sign in with `admin` / `admin`. A new password is required first.

On the console, `root` / `xenman` signs in (a password change is forced) and opens a menu for network, SSH, restarts and resetting an administrator's password.

## Updating an appliance

`xenman-{{TAG}}.xenup` is this release as a signed update package for appliances already running: upload it under Settings → Appliance. Appliances accept only packages signed with the project's release key ([appliance/release-key.pub](https://github.com/xenman-project/xenman/blob/main/appliance/release-key.pub)).

## Docker

```bash
docker run -d --name xenman -p 3000:3000 -p 3001:3001 -v xen-data:/app/data {{IMAGE}}
```

## Checksums (SHA-256)

| File | SHA-256 |
|---|---|
| `xenman-appliance-{{TAG}}.xva` | `{{XVA_SHA256}}` |
| `xenman-{{TAG}}.xenup` | `{{XENUP_SHA256}}` |

Built by GitHub Actions from the tag {{TAG}}.
