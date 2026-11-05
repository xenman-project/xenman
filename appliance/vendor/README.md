# Vendored packages

## xe-guest-utilities_10.0.0-1_amd64.deb

The XenServer guest tools for Linux, taken unchanged from
`LinuxGuestTools-10.0.0-1.tar.gz` (the "XenServer VM Tools for Linux"
download). With them XenServer sees the appliance's IP address and operating
system, and can shut it down or restart it cleanly.

Kept in the repository rather than downloaded at build time, so the appliance
also builds behind a proxy that blocks downloads. BSD licensed; see
`xe-guest-utilities.LICENSE`.

SHA-256: `62fa81534a6a0e762ffe40e91fe1e2f3f4850a4270304928eb4aff647a914b13`

To move to a newer release, replace the .deb (keep it the only
`xe-guest-utilities_*_amd64.deb` here) and update the checksum. Appliances pick
it up with the next update: `xenman-guest-tools` installs it when its version
differs from the installed one, and never downgrades.
