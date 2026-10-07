/**
 * v1.33.9 PARSE-ERROR harness: drives the REAL app (dev server) with a stubbed
 * electronAPI whose exportNative RECORDS the exact IPC payload, so the user's
 * "10-min audio + 1 image held to timeline end" scenario is reproduced
 * end-to-end through the REAL renderer payload builder.
 */
"use strict";
const http = require("http");
const net = require("net");
const fs = require("fs");
const path = require("path");

const TARGET = { host: "127.0.0.1", port: 3000 };
const PORT = 3103;

const STUB = `
(function () {
  var unsub = function () { return function () {}; };
  function winPath(f) {
    var n = (f && f.name) || "file";
    return "C:\\\\Users\\\\TestUser\\\\Videos\\\\" + n;
  }
  window.__exportPayload = null;
  window.electronAPI = {
    getFilePath: function (f) { return winPath(f); },
    chooseOutput: function () { return "C:\\\\Users\\\\TestUser\\\\Videos\\\\export.mp4"; },
    exportNative: function (payload) {
      try { window.__exportPayload = JSON.parse(JSON.stringify(payload)); } catch (e) { window.__exportPayload = { captureError: String(e) }; }
      return Promise.resolve({
        path: "C:\\\\Users\\\\TestUser\\\\Videos\\\\export.mp4",
        size: 12345, method: "stub", engine: "rust-native", encoder: "stub",
        framesEncoded: 10, elapsedSec: 1, poolWorkers: 1, cpus: 4,
      });
    },
    saveTempImage: function (p) { return Promise.resolve("C:\\\\Users\\\\TestUser\\\\AppData\\\\Local\\\\Temp\\\\" + (p && p.name) || "t.png"); },
    saveTempVideo: function (p) { return Promise.resolve("C:\\\\Users\\\\TestUser\\\\AppData\\\\Local\\\\Temp\\\\" + (p && p.name) || "t.mp4"); },
    saveTempAudio: function (p) { return Promise.resolve("C:\\\\Users\\\\TestUser\\\\AppData\\\\Local\\\\Temp\\\\" + (p && p.name) || "t.mp3"); },
    onExportProgress: unsub, onMenu: unsub, onDubProgress: unsub, onTtsProgress: unsub,
    engineStatus: function () {
      return Promise.resolve({ loaded: true, binaryPath: "C:\\\\engine.node", version: "0.4.1" });
    },
    ffmpegStatus: function () {
      return Promise.resolve({ path: "C:\\\\ffmpeg.exe", ok: true });
    },
    ffmpegDiagnostics: function () { return null; },
    projectSave: function () { return Promise.resolve(null); },
  };
})();
`;

const server = http.createServer((req, res) => {
  const headers = { ...req.headers, host: "localhost:3000" };
  headers["accept-encoding"] = "identity";
  const opts = { host: TARGET.host, port: TARGET.port, method: req.method, path: req.url, headers };
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

server.on("upgrade", (req, socket, head) => {
  const target = net.connect(TARGET.port, TARGET.host, () => {
    const lines = [`${req.method} ${req.url} HTTP/1.1`];
    for (const k of Object.keys(req.headers)) {
      let v = req.headers[k];
      if (k === "host") v = "localhost:3000";
      if (k === "origin") v = "http://localhost:3000";
      lines.push(`${k}: ${v}`);
    }
    target.write(lines.join("\r\n") + "\r\n\r\n");
    target.write(head);
    socket.pipe(target);
    target.pipe(socket);
  });
  target.on("error", () => socket.destroy());
});

server.listen(PORT, () => console.log(`v1.33.9 parse harness proxy on :${PORT} (dev :3000)`));
