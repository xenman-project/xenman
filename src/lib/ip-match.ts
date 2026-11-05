// IP addresses and networks, written as "10.0.0.5", "10.0.1.0/24",
// "2001:db8::1" or "2001:db8::/48" -- checked and matched without Node's net
// module, so the browser can say before saving whether an address would be
// allowed.

const IPV4 = /^(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(\.(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3}$/;

function isIPv6(s: string): boolean {
  if (!s.includes(":") || !/^[0-9A-Fa-f:.]+$/.test(s)) return false;
  try {
    new URL(`http://[${s}]/`);
    return true;
  } catch {
    return false;
  }
}

export interface IpEntry {
  family: 4 | 6;
  ip: string;
  prefix: number;
}

/** One address or network; null if it is neither. */
export function parseIpEntry(s: string): IpEntry | null {
  const m = /^([^/\s]+)(?:\/(\d{1,3}))?$/.exec(s.trim());
  if (!m) return null;
  const family = IPV4.test(m[1]) ? 4 : isIPv6(m[1]) ? 6 : 0;
  if (!family) return null;
  const prefix = m[2] === undefined ? (family === 4 ? 32 : 128) : Number(m[2]);
  if (prefix < 0 || prefix > (family === 4 ? 32 : 128)) return null;
  return { family, ip: m[1], prefix };
}

function bits(s: string, family: 4 | 6): bigint {
  if (family === 4) return s.split(".").reduce((n, o) => (n << BigInt(8)) + BigInt(Number(o)), BigInt(0));
  // An IPv4 tail ("::ffff:10.0.0.1") as its two groups.
  const v4 = /(\d+\.\d+\.\d+\.\d+)$/.exec(s);
  if (v4) {
    const n = Number(bits(v4[1], 4));
    s = s.slice(0, -v4[1].length) + `${(n >>> 16).toString(16)}:${(n & 0xffff).toString(16)}`;
  }
  const [head, tail] = s.split("::");
  const h = head ? head.split(":") : [];
  const t = tail ? tail.split(":") : [];
  const groups = tail === undefined ? h : [...h, ...Array(Math.max(0, 8 - h.length - t.length)).fill("0"), ...t];
  return groups.reduce((n, g) => (n << BigInt(16)) + BigInt(parseInt(g || "0", 16)), BigInt(0));
}

/** Whether an address falls under one of the entries. An IPv4 address in IPv6 dress counts as IPv4. */
export function ipAllowedBy(address: string, entries: string[]): boolean {
  const ip = address.trim().replace(/^::ffff:(?=\d+\.\d+\.\d+\.\d+$)/i, "");
  const family = IPV4.test(ip) ? 4 : isIPv6(ip) ? 6 : 0;
  if (!family) return false;
  const value = bits(ip, family);
  return entries.some((e) => {
    const x = parseIpEntry(e);
    if (!x || x.family !== family) return false;
    const shift = BigInt((family === 4 ? 32 : 128) - x.prefix);
    return value >> shift === bits(x.ip, x.family) >> shift;
  });
}
