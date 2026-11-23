// Talks RFB through XenMan's console proxy the way noVNC does, against the
// fake host's RFB server (fake-xapi.js):
//   node vnc-rfb-client.js <ws url> <auth cookie> <what> [args]
//     rate <secs> <delay ms>  next request <delay> after each picture (a long
//                             round trip); prints "pictures <n>"
//     cut <bytes>             clipboard text in four pieces while pictures
//                             flow; prints "md5 <hash>"
//     garbage                 a message type nobody knows; prints "sent 8"
//     stall <secs>            stops reading after the first request
//     ping <secs>             prints "pings <n>"
//     deaf <secs>             stops reading, so no pongs either
"use strict";
const crypto = require("crypto");
const WebSocket = require(process.env.BUILD + "/node_modules/ws");
const [url, cookie, what, a1, a2] = process.argv.slice(2);
const ws = new WebSocket(url, ["binary"], { headers: { Cookie: `xenman-auth=${cookie}` } });
const done = (s) => {
  if (s) console.log(s);
  process.exit(0);
};
ws.on("close", (code, reason) => done(`close ${code} ${reason}`));
ws.on("error", (e) => done(`error ${e.message}`));

const request = (incremental) => Buffer.from([3, incremental, 0, 0, 0, 0, 2, 128, 1, 224]);
const pointer = () => Buffer.from([5, 0, 0, 10, 0, 20]);
const encodings = [0, 1, 7, -316, -223];

let phase = "version";
let buf = Buffer.alloc(0);
let pictures = 0;
let onPicture = () => {};
let pings = 0;
// Set while sending something of its own: noVNC never puts a message inside another.
let quiet = false;
ws.on("ping", () => pings++);

ws.on("message", (d) => {
  buf = Buffer.concat([buf, Buffer.from(d)]);
  for (;;) {
    if (phase === "version") {
      if (buf.length < 12) return;
      buf = buf.subarray(12);
      ws.send(Buffer.from("RFB 003.008\n"));
      phase = "types";
    } else if (phase === "types") {
      if (buf.length < 2) return;
      buf = buf.subarray(2);
      ws.send(Buffer.from([1]));
      phase = "result";
    } else if (phase === "result") {
      if (buf.length < 4) return;
      buf = buf.subarray(4);
      ws.send(Buffer.from([1]));
      phase = "init";
    } else if (phase === "init") {
      if (buf.length < 28) return;
      buf = buf.subarray(28);
      const enc = Buffer.alloc(4 + 4 * encodings.length);
      enc[0] = 2;
      enc.writeUInt16BE(encodings.length, 2);
      encodings.forEach((e, i) => enc.writeInt32BE(e, 4 + 4 * i));
      ws.send(enc);
      ws.send(request(0));
      phase = "pictures";
      start();
    } else {
      // A picture: header, one rectangle of w*h*4 bytes.
      if (buf.length < 16) return;
      const len = 16 + buf.readUInt16BE(8) * buf.readUInt16BE(10) * 4;
      if (buf.length < len) return;
      buf = buf.subarray(len);
      pictures++;
      onPicture();
    }
  }
});

// The next request after a picture, <delay> ms later, as over a long round trip.
function answer(delay) {
  onPicture = () =>
    setTimeout(() => {
      if (ws.readyState !== ws.OPEN || quiet) return;
      ws.send(pointer());
      ws.send(request(1));
    }, delay);
}

function start() {
  if (what === "rate") {
    answer(Number(a2));
    setTimeout(() => done(`pictures ${pictures}`), Number(a1) * 1000);
  } else if (what === "cut") {
    answer(20);
    const text = crypto.randomBytes(Number(a1));
    const msg = Buffer.alloc(8 + text.length);
    msg[0] = 6;
    msg.writeInt32BE(text.length, 4);
    text.copy(msg, 8);
    const q = Math.ceil(msg.length / 4);
    setTimeout(() => (quiet = true), 290);
    [0, 1, 2, 3].forEach((i) => setTimeout(() => ws.send(msg.subarray(i * q, (i + 1) * q)), 300 + i * 80));
    setTimeout(() => done(`md5 ${crypto.createHash("md5").update(text).digest("hex")}`), 1200);
  } else if (what === "garbage") {
    answer(20);
    setTimeout(() => {
      quiet = true;
      ws.send(Buffer.from([99, 1, 2, 3, 4, 5, 6, 7]));
      setTimeout(() => done("sent 8"), 800);
    }, 300);
  } else if (what === "stall") {
    ws.send(request(1));
    setTimeout(() => ws._socket.pause(), 50);
    setTimeout(() => done(), Number(a1) * 1000);
  } else if (what === "ping") {
    answer(20);
    setTimeout(() => done(`pings ${pings}`), Number(a1) * 1000);
  } else if (what === "deaf") {
    ws._socket.pause();
    setTimeout(() => done("still open"), Number(a1) * 1000);
  }
}
setTimeout(() => done("timeout"), 30000);
