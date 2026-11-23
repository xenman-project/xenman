// Opens XenMan's console proxy like the browser does and says what happened:
//   "data <first bytes>" when the host's RFB greeting came through,
//   "close <code> <reason>" when the proxy closed it.
//   node vnc-client.js <ws url> <auth cookie>
"use strict";
const WebSocket = require(process.env.BUILD + "/node_modules/ws");
const [url, cookie] = process.argv.slice(2);
const ws = new WebSocket(url, ["binary"], { headers: { Cookie: `xenman-auth=${cookie}` } });
const done = (s) => {
  console.log(s);
  process.exit(0);
};
ws.on("message", (d) => done(`data ${Buffer.from(d).toString().trim()}`));
ws.on("close", (code, reason) => done(`close ${code} ${reason}`));
ws.on("error", (e) => done(`error ${e.message}`));
setTimeout(() => done("timeout"), 8000);
