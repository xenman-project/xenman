// A stand-in SSH server for the export over SSH: takes root/secret, runs
// nothing, says exit 0. Every password that arrives is logged -- the test
// checks that none does once the host key changed.
//   node fake-ssh.js <port> <host key file> <log file>
"use strict";
const fs = require("fs");
const { Server } = require(process.env.BUILD + "/node_modules/ssh2");
const [port, keyFile, logFile] = process.argv.slice(2);
const log = (s) => fs.appendFileSync(logFile, s + "\n");

new Server({ hostKeys: [fs.readFileSync(keyFile)] }, (client) => {
  client.on("authentication", (ctx) => {
    if (ctx.method === "password") {
      log(`password for ${ctx.username}`);
      return ctx.username === "root" && ctx.password === "secret" ? ctx.accept() : ctx.reject();
    }
    ctx.reject(["password"]);
  });
  client.on("ready", () => {
    client.on("session", (accept) => {
      const session = accept();
      session.on("exec", (acc, _rej, info) => {
        log(`exec ${info.command}`);
        const stream = acc();
        stream.write("ok\n");
        stream.exit(0);
        stream.end();
      });
    });
  });
  client.on("error", () => {});
}).listen(Number(port), "127.0.0.1", () => log("listening"));
