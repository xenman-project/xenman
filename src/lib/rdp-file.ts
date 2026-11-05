// A Remote Desktop connection to a VM, as XenCenter's "Switch to Remote
// Desktop" offers it: a .rdp file with the VM's address, which Windows opens
// in its own client (mstsc). Nothing goes through XenMan -- the browser's
// machine has to reach the VM on port 3389 itself.

/** The address the VM's tools report first, IPv4 before IPv6. */
export function rdpAddress(ipAddresses: string[]): string | null {
  return ipAddresses.find((ip) => /^\d+\.\d+\.\d+\.\d+$/.test(ip)) ?? ipAddresses[0] ?? null;
}

/** The .rdp file's text; the client asks for the credentials itself. */
export function rdpFileText(address: string): string {
  const host = address.includes(":") ? `[${address}]` : address;
  return [
    `full address:s:${host}`,
    "prompt for credentials:i:1",
    "screen mode id:i:2",
    "use multimon:i:0",
    "redirectclipboard:i:1",
    "autoreconnection enabled:i:1",
    "authentication level:i:2",
    "",
  ].join("\r\n");
}

/** Hands the browser a <vm name>.rdp to open. */
export function downloadRdpFile(vmName: string, address: string): void {
  const blob = new Blob([rdpFileText(address)], { type: "application/x-rdp" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `${vmName.replace(/[^\w.-]+/g, "_") || "vm"}.rdp`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10000);
}
