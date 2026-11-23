// Minimal SMTP server for tests: every message lands in DIR as N.eml.
const net = require("net");
const fs = require("fs");
const [port, dir] = process.argv.slice(2);
let n = fs.readdirSync(dir).filter((f) => f.endsWith(".eml")).length;
net
  .createServer((s) => {
    s.write("220 sink\r\n");
    let buf = "", data = false, msg = "", rcpt = [];
    s.on("data", (d) => {
      buf += d;
      let i;
      while ((i = buf.indexOf("\r\n")) >= 0) {
        const line = buf.slice(0, i);
        buf = buf.slice(i + 2);
        if (data) {
          if (line === ".") {
            data = false;
            fs.writeFileSync(`${dir}/${++n}.eml`, `X-Rcpt: ${rcpt.join(",")}\n${msg}`);
            msg = ""; rcpt = [];
            s.write("250 ok\r\n");
          } else msg += line + "\n";
          continue;
        }
        const c = line.slice(0, 4).toUpperCase();
        if (c === "EHLO" || c === "HELO") s.write("250 sink\r\n");
        else if (c === "RCPT") { rcpt.push(line.replace(/^RCPT TO:\s*/i, "")); s.write("250 ok\r\n"); }
        else if (c === "DATA") { data = true; s.write("354 go\r\n"); }
        else if (c === "QUIT") { s.write("221 bye\r\n"); s.end(); }
        else s.write("250 ok\r\n");
      }
    });
    s.on("error", () => {});
  })
  .listen(Number(port), "127.0.0.1");
