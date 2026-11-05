#!/usr/bin/env node
//
// Pack a raw disk image into a XenServer .xva, without touching a host.
//
// An XVA is a plain (uncompressed) tar archive holding:
//
//     ova.xml                                   the XAPI object model
//     Ref:<vdi>/00000000000000000000            disk data, 1 MiB per file
//     Ref:<vdi>/00000000000000000000.checksum   SHA-1 of that chunk, hex
//
// Chunks that are entirely zero are left out; the import fills the gaps with
// zeroes. That is what keeps a 20 GiB appliance down to a ~1 GiB file.
//
// The field set below was taken from a known-importable appliance rather than
// from documentation, so it matches what xapi actually accepts: a vendor-built
// appliance XVA (export_vsn 2, XenServer 7.1.2).
//
// Usage:
//   node xva-pack.js pack   --disk disk.raw --out xenman.xva [options]
//   node xva-pack.js verify --xva xenman.xva

"use strict";

const fs = require("fs");
const os = require("os");
const crypto = require("crypto");

const CHUNK_SIZE = 1024 * 1024;
const BLOCK_SIZE = 512;
const ZERO_CHUNK = Buffer.alloc(CHUNK_SIZE);

// ─── XML-RPC serialisation ───────────────────────────────────────────────────
//
// xapi reads ova.xml as XML-RPC. Everything is a bare <value>string</value>
// except booleans and doubles, which need their own tags — including the
// 64-bit numbers (memory, virtual_size), which travel as strings.

const bool = (value) => ({ __type: "boolean", value });
const double = (value) => ({ __type: "double", value });

function esc(text) {
  return String(text)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function toXml(value, indent = 0) {
  const pad = "  ".repeat(indent);

  if (value && value.__type === "boolean") {
    return `${pad}<value><boolean>${value.value ? 1 : 0}</boolean></value>`;
  }
  if (value && value.__type === "double") {
    return `${pad}<value><double>${value.value}</double></value>`;
  }
  if (Array.isArray(value)) {
    if (value.length === 0) return `${pad}<value><array><data/></array></value>`;
    const items = value.map((item) => toXml(item, indent + 3));
    return [
      `${pad}<value>`,
      `${pad}  <array>`,
      `${pad}    <data>`,
      ...items,
      `${pad}    </data>`,
      `${pad}  </array>`,
      `${pad}</value>`,
    ].join("\n");
  }
  if (value !== null && typeof value === "object") {
    const keys = Object.keys(value);
    if (keys.length === 0) return `${pad}<value><struct/></value>`;
    const members = keys.flatMap((key) => [
      `${pad}    <member>`,
      `${pad}      <name>${esc(key)}</name>`,
      toXml(value[key], indent + 3),
      `${pad}    </member>`,
    ]);
    return [
      `${pad}<value>`,
      `${pad}  <struct>`,
      ...members,
      `${pad}  </struct>`,
      `${pad}</value>`,
    ].join("\n");
  }
  if (value === "") return `${pad}<value/>`;
  return `${pad}<value>${esc(value)}</value>`;
}

// ─── The object model ────────────────────────────────────────────────────────

function buildOvaXml(opts, diskBytes) {
  const vdiRef = `Ref:VDI-1-${opts.diskLabel}`;
  const vbdRef = `Ref:VBD-1-${opts.diskLabel}`;
  const memory = String(opts.memoryMb * 1024 * 1024);

  const vm = {
    uuid: "unused",
    allowed_operations: [],
    current_operations: {},
    power_state: "Halted",
    name_label: opts.name,
    name_description: opts.description,
    user_version: "0",
    is_a_template: bool(false),
    suspend_VDI: "OpaqueRef:NULL",
    resident_on: "OpaqueRef:NULL",
    affinity: "OpaqueRef:NULL",
    memory_target: "0",
    memory_static_max: memory,
    memory_dynamic_max: memory,
    memory_dynamic_min: memory,
    memory_static_min: memory,
    VCPUs_params: {},
    VCPUs_max: String(opts.vcpus),
    VCPUs_at_startup: String(opts.vcpus),
    actions_after_shutdown: "destroy",
    actions_after_reboot: "restart",
    actions_after_crash: "restart",
    consoles: [],
    VIFs: ["Ref:VIF"],
    VBDs: [vbdRef],
    crash_dumps: [],
    VTPMs: [],
    // HVM_boot_policy decides the boot path; the PV_* fields stay present but
    // unused, exactly as a real export leaves them.
    PV_bootloader: "pygrub",
    PV_kernel: "",
    PV_ramdisk: "",
    PV_args: "",
    PV_bootloader_args: "",
    PV_legacy_args: "",
    HVM_boot_policy: "BIOS order",
    HVM_boot_params: { order: "c" },
    HVM_shadow_multiplier: double(1),
    platform: {
      timeoffset: "0",
      acpi: "true",
      apic: "true",
      nx: "true",
      pae: "true",
      viridian: "false",
    },
    PCI_bus: "",
    other_config: {},
    domid: "-1",
    domarch: "",
    last_boot_CPU_flags: {},
    is_control_domain: bool(false),
    metrics: "OpaqueRef:NULL",
    guest_metrics: "OpaqueRef:NULL",
    last_booted_record: "",
    recommendations: "",
    ha_always_run: bool(false),
    ha_restart_priority: "",
    is_a_snapshot: bool(false),
    snapshot_of: "OpaqueRef:NULL",
    snapshots: [],
    tags: [],
    children: [],
    bios_strings: {
      "bios-vendor": "Xen",
      "bios-version": "",
      "system-manufacturer": "Xen",
      "system-product-name": "HVM domU",
      "system-version": "",
      "system-serial-number": "",
      "hp-rombios": "",
      "oem-1": "Xen",
      "oem-2": "MS_VM_CERT/SHA1/bdbeb6e0a816d43fa6d3fe8aaef04c2bad9d3e3d",
    },
    protection_policy: "OpaqueRef:NULL",
    appliance: "OpaqueRef:NULL",
    start_delay: "0",
    shutdown_delay: "0",
    order: "0",
    VGPUs: [],
    attached_PCIs: [],
    suspend_SR: "OpaqueRef:NULL",
    version: "0",
    generation_id: "",
    hardware_platform_version: "0",
    has_vendor_device: bool(false),
    requires_reboot: bool(false),
    reference_label: "",
  };

  const vbd = {
    uuid: "unused",
    VM: "Ref:VM",
    VDI: vdiRef,
    device: "xvda",
    userdevice: "0",
    bootable: bool(true),
    mode: "RW",
    type: "Disk",
    unpluggable: bool(false),
    storage_lock: bool(false),
    empty: bool(false),
    other_config: { owner: "" },
    currently_attached: bool(false),
    status_code: "0",
    status_detail: "",
    runtime_properties: {},
    qos_algorithm_type: "",
    qos_algorithm_params: {},
    qos_supported_algorithms: [],
    metrics: "OpaqueRef:NULL",
  };

  const vif = {
    uuid: "unused",
    allowed_operations: ["attach"],
    current_operations: {},
    device: "0",
    network: "Ref:Net",
    VM: "Ref:VM",
    // All-zero plus MAC_autogenerated tells xapi to mint a fresh MAC on import,
    // so two imports of the same file do not collide on the network.
    MAC: "00:00:00:00:00:00",
    MTU: "0",
    other_config: {},
    currently_attached: bool(false),
    status_code: "0",
    status_detail: "",
    runtime_properties: {},
    qos_algorithm_type: "",
    qos_algorithm_params: {},
    qos_supported_algorithms: [],
    metrics: "OpaqueRef:NULL",
    MAC_autogenerated: bool(true),
  };

  const network = {
    uuid: "unused",
    name_label: "Pool-wide network associated with eth0",
    name_description: "",
    allowed_operations: [],
    current_operations: {},
    VIFs: ["Ref:VIF"],
    PIFs: [],
    other_config: {},
    bridge: "xenbr0",
    blobs: {},
    tags: [],
  };

  const vdi = {
    uuid: "unused",
    name_label: opts.diskLabel,
    name_description: "",
    SR: "Ref:SR",
    VBDs: [vbdRef],
    crash_dumps: [],
    virtual_size: String(diskBytes),
    physical_utilisation: "0",
    type: "system",
    sharable: bool(false),
    read_only: bool(false),
    other_config: {},
    storage_lock: bool(false),
    managed: bool(true),
    missing: bool(false),
    parent: "OpaqueRef:NULL",
    tags: [],
    allow_caching: bool(false),
    on_boot: "persist",
  };

  const sr = {
    uuid: "unused",
    VDIs: [vdiRef],
    PBDs: [],
    virtual_allocation: "0",
    physical_utilisation: "0",
    physical_size: "0",
    type: "unused",
    content_type: "unused",
    shared: bool(false),
    other_config: {},
  };

  const document = {
    version: {
      hostname: opts.buildHost,
      date: new Date().toISOString().slice(0, 10),
      product_version: "7.1.2",
      product_brand: "XenServer",
      build_number: "xenman-appliance",
      xapi_major: "1",
      xapi_minor: "9",
      export_vsn: "2",
    },
    objects: [
      { class: "VM", id: "Ref:VM", snapshot: vm },
      { class: "VBD", id: vbdRef, snapshot: vbd },
      { class: "VIF", id: "Ref:VIF", snapshot: vif },
      { class: "network", id: "Ref:Net", snapshot: network },
      { class: "VDI", id: vdiRef, snapshot: vdi },
      { class: "SR", id: "Ref:SR", snapshot: sr },
    ],
  };

  return toXml(document) + "\n";
}

// ─── tar writing ─────────────────────────────────────────────────────────────
//
// Hand-rolled ustar so the packer stays dependency-free: it has to run from the
// Node tarball the build script already downloads, before any npm install.

function octal(value, width) {
  return value.toString(8).padStart(width - 1, "0") + "\0";
}

function tarHeader(name, size, mtime) {
  if (Buffer.byteLength(name) > 100) {
    throw new Error(`name too long for ustar: ${name}`);
  }
  const header = Buffer.alloc(BLOCK_SIZE);
  header.write(name, 0, 100, "utf8");
  header.write(octal(0o644, 8), 100, 8, "ascii"); // mode
  header.write(octal(0, 8), 108, 8, "ascii"); // uid
  header.write(octal(0, 8), 116, 8, "ascii"); // gid
  header.write(octal(size, 12), 124, 12, "ascii");
  header.write(octal(mtime, 12), 136, 12, "ascii");
  header.write("        ", 148, 8, "ascii"); // checksum placeholder
  header.write("0", 156, 1, "ascii"); // typeflag: regular file
  header.write("ustar\0", 257, 6, "ascii");
  header.write("00", 263, 2, "ascii");
  header.write("root", 265, 32, "ascii");
  header.write("root", 297, 32, "ascii");

  let sum = 0;
  for (const byte of header) sum += byte;
  // The checksum field is six octal digits, NUL, then a space.
  header.write(octal(sum, 7) + " ", 148, 8, "ascii");
  return header;
}

function padding(size) {
  const remainder = size % BLOCK_SIZE;
  return remainder === 0 ? Buffer.alloc(0) : Buffer.alloc(BLOCK_SIZE - remainder);
}

class TarWriter {
  constructor(path) {
    this.fd = fs.openSync(path, "w");
  }

  add(name, payload, mtime) {
    fs.writeSync(this.fd, tarHeader(name, payload.length, mtime));
    fs.writeSync(this.fd, payload);
    const pad = padding(payload.length);
    if (pad.length) fs.writeSync(this.fd, pad);
  }

  close() {
    // Two zero blocks end the archive; tar implementations expect both.
    fs.writeSync(this.fd, Buffer.alloc(BLOCK_SIZE * 2));
    fs.closeSync(this.fd);
  }
}

// ─── Packing ─────────────────────────────────────────────────────────────────

function human(size) {
  const units = ["B", "KiB", "MiB", "GiB"];
  let index = 0;
  while (size >= 1024 && index < units.length - 1) {
    size /= 1024;
    index++;
  }
  return `${size.toFixed(1)} ${units[index]}`;
}

function pack(opts) {
  const diskBytes = fs.statSync(opts.disk).size;
  if (diskBytes % CHUNK_SIZE !== 0) {
    throw new Error(
      `disk size ${diskBytes} is not a multiple of 1 MiB — xapi expects whole chunks`,
    );
  }
  const totalChunks = diskBytes / CHUNK_SIZE;
  const mtime = Number(process.env.SOURCE_DATE_EPOCH || Math.floor(Date.now() / 1000));
  const ref = `Ref:VDI-1-${opts.diskLabel}`;

  process.stdout.write(`Packing ${opts.disk} (${human(diskBytes)}) -> ${opts.out}\n`);

  const tar = new TarWriter(opts.out);
  tar.add("ova.xml", Buffer.from(buildOvaXml(opts, diskBytes), "utf8"), mtime);

  const disk = fs.openSync(opts.disk, "r");
  const buffer = Buffer.alloc(CHUNK_SIZE);
  let written = 0;
  let skipped = 0;

  try {
    for (let index = 0; index < totalChunks; index++) {
      const read = fs.readSync(disk, buffer, 0, CHUNK_SIZE, index * CHUNK_SIZE);
      if (read < CHUNK_SIZE) buffer.fill(0, read);

      // The last chunk is always written, even when it is all zeroes: it marks
      // where the disk ends. Without it the archive stops short of the
      // virtual_size declared in ova.xml and xapi rejects the import. A real
      // export does the same — leave gaps anywhere, but never at the end.
      const isLast = index === totalChunks - 1;
      if (buffer.equals(ZERO_CHUNK) && !isLast) {
        skipped++;
      } else {
        const name = `${ref}/${String(index).padStart(20, "0")}`;
        tar.add(name, buffer, mtime);
        const sha1 = crypto.createHash("sha1").update(buffer).digest("hex");
        tar.add(`${name}.checksum`, Buffer.from(sha1, "ascii"), mtime);
        written++;
      }

      if (index % 512 === 0 && process.stdout.isTTY) {
        const done = Math.floor(((index + 1) * 100) / totalChunks);
        process.stdout.write(
          `  ${String(done).padStart(3)}%  ${written} chunks written, ${skipped} zero chunks skipped\r`,
        );
      }
    }
  } finally {
    fs.closeSync(disk);
    tar.close();
  }

  const outBytes = fs.statSync(opts.out).size;
  if (process.stdout.isTTY) process.stdout.write(`${" ".repeat(72)}\r`);
  process.stdout.write(
    `  ${written} chunks written, ${skipped} zero chunks skipped\n` +
      `  ${opts.out} — ${human(outBytes)} ` +
      `(${Math.round((outBytes * 100) / diskBytes)}% of the virtual size)\n`,
  );
}

// ─── Verifying ───────────────────────────────────────────────────────────────

function* readTar(path) {
  const fd = fs.openSync(path, "r");
  const header = Buffer.alloc(BLOCK_SIZE);
  let offset = 0;
  try {
    for (;;) {
      if (fs.readSync(fd, header, 0, BLOCK_SIZE, offset) < BLOCK_SIZE) return;
      offset += BLOCK_SIZE;
      const name = header.subarray(0, 100).toString("ascii").replace(/\0.*$/, "");
      if (name === "") return; // end-of-archive block
      const size = parseInt(
        header.subarray(124, 136).toString("ascii").replace(/\0.*$/, "").trim(),
        8,
      );
      const payload = Buffer.alloc(size);
      fs.readSync(fd, payload, 0, size, offset);
      offset += size + padding(size).length;
      yield { name, payload };
    }
  } finally {
    fs.closeSync(fd);
  }
}

function verify(opts) {
  const pending = new Map();
  let chunks = 0;
  let problems = 0;
  let first = true;
  let sawOva = false;
  let virtualSize = null;
  let highestIndex = null;

  for (const { name, payload } of readTar(opts.xva)) {
    if (first) {
      sawOva = name === "ova.xml";
      first = false;
      if (sawOva) {
        const m = payload.toString("utf8").match(
          /<name>virtual_size<\/name>\s*<value>(\d+)<\/value>/,
        );
        if (m) virtualSize = Number(m[1]);
        continue;
      }
    }
    if (name === "ova.xml") continue;

    const indexMatch = name.match(/\/(\d+)$/);
    if (indexMatch) {
      const index = Number(indexMatch[1]);
      if (highestIndex === null || index > highestIndex) highestIndex = index;
    }

    if (name.endsWith(".checksum")) {
      const base = name.slice(0, -".checksum".length);
      const expected = payload.toString("ascii").trim();
      const actual = pending.get(base);
      pending.delete(base);
      if (actual === undefined) {
        console.log(`  checksum without data: ${name}`);
        problems++;
      } else if (actual !== expected) {
        console.log(`  checksum mismatch: ${base}`);
        problems++;
      }
    } else {
      pending.set(name, crypto.createHash("sha1").update(payload).digest("hex"));
      chunks++;
      if (payload.length !== CHUNK_SIZE) {
        console.log(`  wrong chunk size (${payload.length}): ${name}`);
        problems++;
      }
    }
  }

  for (const name of pending.keys()) {
    console.log(`  data without checksum: ${name}`);
    problems++;
  }

  // A chunk may be missing anywhere except at the end — see pack().
  if (virtualSize !== null && highestIndex !== null) {
    const expected = Math.ceil(virtualSize / CHUNK_SIZE) - 1;
    if (highestIndex !== expected) {
      console.log(
        `  archive ends at chunk ${highestIndex}, but ova.xml declares ` +
          `${virtualSize} bytes (last chunk should be ${expected})`,
      );
      problems++;
    }
  }
  if (!sawOva) {
    console.log("  ova.xml is missing or is not the first entry");
    problems++;
  }

  console.log(`${chunks} chunks checked, ${problems} problems`);
  return problems === 0 ? 0 : 1;
}

// ─── CLI ─────────────────────────────────────────────────────────────────────

function parseArgs(argv) {
  const opts = {
    name: "XenMan",
    description: "XenMan — XenServer management appliance",
    memoryMb: 2048,
    vcpus: 2,
    diskLabel: "root",
    buildHost: os.hostname(),
  };
  const map = {
    "--disk": "disk",
    "--out": "out",
    "--xva": "xva",
    "--name": "name",
    "--description": "description",
    "--memory-mb": "memoryMb",
    "--vcpus": "vcpus",
    "--disk-label": "diskLabel",
    "--build-host": "buildHost",
  };
  for (let i = 0; i < argv.length; i += 2) {
    const key = map[argv[i]];
    if (!key) throw new Error(`unknown option: ${argv[i]}`);
    if (argv[i + 1] === undefined) throw new Error(`missing value for ${argv[i]}`);
    opts[key] = key === "memoryMb" || key === "vcpus" ? Number(argv[i + 1]) : argv[i + 1];
  }
  return opts;
}

function main() {
  const [command, ...rest] = process.argv.slice(2);
  const opts = parseArgs(rest);

  if (command === "pack") {
    if (!opts.disk || !opts.out) throw new Error("pack needs --disk and --out");
    pack(opts);
    return 0;
  }
  if (command === "verify") {
    if (!opts.xva) throw new Error("verify needs --xva");
    return verify(opts);
  }
  console.error("usage: xva-pack.js pack --disk <raw> --out <xva> | verify --xva <xva>");
  return 2;
}

try {
  process.exit(main());
} catch (err) {
  console.error(`xva-pack: ${err.message}`);
  process.exit(1);
}
