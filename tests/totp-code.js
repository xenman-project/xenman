// The code an authenticator app shows for a secret, as RFC 6238 computes it --
// written here on its own, not taken from XenMan, so the test checks XenMan
// against the standard rather than against itself.
//   node totp-code.js <base32 secret> [steps from now]
"use strict";
const crypto = require("crypto");
const [secret, offset = "0"] = process.argv.slice(2);
const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
let bits = "";
for (const ch of secret.toUpperCase().replace(/[^A-Z2-7]/g, "")) bits += alphabet.indexOf(ch).toString(2).padStart(5, "0");
const key = Buffer.from(bits.match(/.{8}/g).map((b) => parseInt(b, 2)));
const step = Math.floor(Date.now() / 30000) + Number(offset);
const counter = Buffer.alloc(8);
counter.writeBigUInt64BE(BigInt(step));
const mac = crypto.createHmac("sha1", key).update(counter).digest();
const o = mac[19] & 15;
console.log(String((mac.readUInt32BE(o) & 0x7fffffff) % 1000000).padStart(6, "0"));
