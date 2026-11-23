#!/usr/bin/env node
// How the Node.js in node-version stands within its major line, from
// nodejs.org's release list (https://nodejs.org/dist/index.json):
//
//     node-newer.js <index.json> <pinned version>          JSON
//     node-newer.js --text <index.json> <pinned version>   what check-node.sh says
//
// The JSON: { pinned, major, newest, security, lts } -- newest is the newest
// release of the line ahead of the pinned one ("24.23.0", null when there is
// none), security the releases between them that nodejs.org marks as
// security releases ("v24.22.4", ...), lts the highest newer LTS major line
// (null when there is none). Used by check-node.sh and the weekly
// node-watch workflow.
"use strict";
const fs = require("fs");

const args = process.argv.slice(2);
const text = args[0] === "--text";
if (text) args.shift();
const [file, pinned] = args;
if (!file || !pinned) {
  console.error("usage: node-newer.js [--text] <index.json> <pinned version>");
  process.exit(2);
}

const parse = (v) => v.replace(/^v/, "").split(".").map(Number);
const newer = (a, b) => {
  const [x, y] = [parse(a), parse(b)];
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] > y[i];
  return false;
};
const list = JSON.parse(fs.readFileSync(file, "utf8"));
const major = parse(pinned)[0];
const ahead = list.filter((r) => parse(r.version)[0] === major && newer(r.version, pinned));
const newest = ahead.length ? ahead.reduce((a, b) => (newer(b.version, a.version) ? b : a)).version.slice(1) : null;
const security = ahead.filter((r) => r.security).map((r) => r.version);
const ltsLines = list.filter((r) => r.lts && parse(r.version)[0] > major).map((r) => parse(r.version)[0]);
const lts = ltsLines.length ? Math.max(...ltsLines) : null;

if (!text) {
  console.log(JSON.stringify({ pinned, major, newest, security, lts }));
  process.exit(0);
}
if (!newest) {
  console.log(`  Node.js ${pinned}: the newest ${major}.x`);
} else if (security.length) {
  console.log("");
  console.log(`  !! Node.js ${newest} is out, and ${pinned} misses security releases: ${security.join(", ")}`);
  console.log("  !! Raise appliance/node-version: the release, and the tarball's line from its SHASUMS256.txt.");
  console.log("");
} else {
  console.log(`  Node.js ${newest} is out (no security fixes over ${pinned})`);
}
if (lts) console.log(`  Node.js ${lts} is an LTS line too -- moving to it is a decision of its own`);
