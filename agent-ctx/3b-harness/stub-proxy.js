/**
 * Task 3-b (v1.25 QWERTY script writer) UI verification: dev-server proxy on
 * :3101 that injects a STUBBED window.electronAPI into the HTML before Next
 * hydration, so the Electron-gated "AI Script Writer" section renders in a
 * normal browser. (Same pattern as 6d-harness on :3100 / worklog Task 3-b/57-f:
 * the HMR websocket MUST be proxied with host+origin rewrite or dev hydration
 * never completes.)
 */
"use strict";
const http = require("http");
const net = require("net");
const fs = require("fs");
const path = require("path");

const TARGET = { host: "127.0.0.1", port: 3000 };
const STUB = fs.readFileSync(path.join(__dirname, "electron-stub.js"), "utf8");

const server = http.createServer((req, res) => {
  const headers = { ...req.headers, host: "localhost:3000" };
  headers["accept-encoding"] = "identity"; // keep HTML plain for injection
  const opts = {
    host: TARGET.host,
    port: TARGET.port,
    method: req.method,
    path: req.url,
    headers,
  };
  const up = http.request(opts, (down) => {
    const outHeaders = { ...down.headers };
    const isHtml = (outHeaders["content-type"] || "").includes("text/html");
    if (isHtml) {
      let body = "";
      down.setEncoding("utf8");
      down.on("data", (c) => (body += c));
      down.on("end", () => {
        const injected = body.replace(/(<head[^>]*>)/, `$1<script>${STUB}</script>`);
        delete outHeaders["content-length"];
        res.writeHead(down.statusCode, outHeaders);
        res.end(injected);
      });
    } else {
      res.writeHead(down.statusCode, outHeaders);
      down.pipe(res);
    }
  });
  up.on("error", (e) => {
    res.writeHead(502, { "content-type": "text/plain" });
    res.end(`proxy error: ${e.message}`);
  });
  req.pipe(up);
});

// HMR websocket passthrough (host + origin rewritten to :3000).
server.on("upgrade", (req, socket, head) => {
  const target = net.connect(TARGET.port, TARGET.host, () => {
    const lines = [`${req.method} ${req.url} HTTP/1.1`];
    for (const k of Object.keys(req.headers)) {
      let v = req.headers[k];
      if (k === "host") v = "localhost:3000";
      if (k === "origin") v = "http://localhost:3000";
      if (Array.isArray(v)) v = v.join(", ");
      lines.push(`${k}: ${v}`);
    }
    target.write(lines.join("\r\n") + "\r\n\r\n");
    if (head && head.length) target.write(head);
    socket.pipe(target);
    target.pipe(socket);
  });
  target.on("error", () => socket.destroy());
  socket.on("error", () => target.destroy());
});

server.listen(3101, "127.0.0.1", () => console.log("stub proxy on http://127.0.0.1:3101"));
