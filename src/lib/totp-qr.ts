// The QR code an authenticator app scans to set up two-factor sign-in, drawn
// here as SVG: the secret in it never goes to a service elsewhere.

import qrcode from "qrcode-generator";

export function qrSvg(text: string): string {
  const qr = qrcode(0, "M");
  qr.addData(text);
  qr.make();
  return qr.createSvgTag({ cellSize: 4, margin: 4, scalable: true });
}
