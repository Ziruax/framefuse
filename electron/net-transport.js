// electron/net-transport.js — unified HTTPS transport for provider APIs.
//
// WHY THIS EXISTS (v1.31). Provider requests from the Electron main process
// used Node's raw `https` module. Two hard, real-world failure modes come
// with that choice:
//
//   1. NON-BROWSER TLS FINGERPRINT. api.groq.com sits behind Cloudflare's
//      bot management. Node's ClientHello differs from a browser's, and
//      Cloudflare can refuse the request outright with the bare
//      403 {"error":{"message":"Forbidden"}} JSON (live-verified: that
//      exact body comes back for EVERY path/method/key combination when
//      the origin is flagged — it is an EDGE block, not an auth verdict).
//      Meanwhile the user's BROWSER opens console.groq.com fine, which is
//      exactly the "my key is accurate but Groq rejects it" confusion:
//      the key was never checked, and auth-rejected/edge-blocked requests
//      never appear in the console's request logs.
//
//   2. SYSTEM PROXY IS IGNORED. Node's https module does not consult the
//      OS proxy/PAC configuration. On machines whose working route to a
//      provider is a system-wide VPN or proxy (very common where providers
//      geo-block), the browser succeeds while raw Node dies — "failed to
//      fetch" class errors.
//
// Electron's `net` module fixes both at once: it IS Chromium's network
// stack — the same TLS fingerprint class as the user's browser, and it
// honors the system proxy + PAC automatically. Inside the Electron main
// process we therefore route every provider request through `net`;
// in plain Node (smoke tests, `node -e …`) we fall back to https.request
// so the modules stay zero-dependency and testable.
//
// The public surface is the SUBSET of http.ClientRequest our provider
// clients use, so call sites written for https.request keep working:
//
//   const req = createRequest({ method, host, path, headers }, (res) => {
//     res.statusCode, res.headers, res.on("data"), res.on("end")
//   });
//   req.write(chunk, cb?) / req.end(data?, cb?) / req.destroy(err?)
//   req.on("error", fn) / req.once("drain", fn) / req.setTimeout(ms, fn)
//
// This module stays a PLAIN Node module: the electron require is guarded
// and only succeeds inside the Electron main process.

"use strict";

const https = require("https");

/** Detect the Electron net module (Chromium network stack). Returns the net
 *  API object when running inside the Electron main process, else null. */
function detectElectronNet() {
  try {
    if (!process.versions || !process.versions.electron) return null;
    // In the MAIN process require("electron") returns the full API bundle.
    // In plain Node it resolves to a path string (no .net), and inside a
    // renderer/utility process this file is not loaded at all.
    const electron = require("electron");
    const net = electron && typeof electron === "object" ? electron.net : null;
    return net && typeof net.request === "function" ? net : null;
  } catch (_) {
    return null;
  }
}

const electronNet = detectElectronNet();

/** Which transport is live? (surfaced for logging/diagnostics). */
function transportName() {
  return electronNet ? "electron-net (Chromium network stack, system proxy)" : "node-https";
}

/** Build the normalized response for a call site. Both transports expose
 *  { statusCode, headers, on("data"), on("end") } — identical shape. */
function passThroughResponse(res) {
  return res;
}

/**
 * Create one HTTPS request through the best available transport.
 *
 * @param {object} opts
 * @param {string} opts.method            GET/POST
 * @param {string} opts.host             e.g. "api.groq.com"
 * @param {string} opts.path             e.g. "/openai/v1/models"
 * @param {object} [opts.headers]        header → string value
 * @param {number} [opts.port=443]
 * @param {(res:import("http").IncomingMessage)=>void} onResponse
 *        Fired once when response HEADERS arrive (the https.request
 *        callback contract).
 * @returns {object} adapter with write/end/destroy/on/once/setTimeout +
 *          a `destroyed` flag (the surface groq-whisper/groq-chat/gemini-chat use).
 */
function createRequest(opts, onResponse) {
  const headers = opts.headers || {};
  let raw = null;
  let usingElectron = false;

  if (electronNet) {
    try {
      raw = electronNet.request({
        method: opts.method || "GET",
        url: `https://${opts.host}${opts.path}`,
      });
      for (const name of Object.keys(headers)) {
        // LIVE-VERIFIED (Electron 33): setHeader("Content-Length") makes the
        // whole request fail with net::ERR_INVALID_ARGUMENT — Chromium owns
        // that header. Omit it; Chromium then uses chunked transfer encoding
        // for streamed bodies (valid HTTP that Groq/Gemini accept), and adds
        // framing itself for single-buffer bodies.
        if (/^content-length$/i.test(name)) continue;
        try {
          raw.setHeader(name, headers[name]);
        } catch (_) {
          // Restricted header on this Electron build — skip it rather than
          // lose the whole request.
        }
      }
      raw.on("response", (res) => {
        onResponse(passThroughResponse(res));
      });
      usingElectron = true;
    } catch (_) {
      raw = null; // fall back to the Node transport below
    }
  }

  if (!raw) {
    raw = https.request(
      {
        host: opts.host,
        port: opts.port || 443,
        path: opts.path,
        method: opts.method || "GET",
        headers,
      },
      (res) => {
        onResponse(passThroughResponse(res));
      },
    );
  }

  // ---- adapter (the stable surface call sites code against) ----
  const adapter = {
    _raw: raw,
    _destroyed: false,
    get destroyed() {
      return this._destroyed || !!raw.destroyed;
    },
    write(chunk, cb) {
      if (this._destroyed) return false;
      try {
        return raw.write(chunk, cb);
      } catch (err) {
        // A write on a torn-down request surfaces through 'error'.
        try { raw.destroy(err); } catch (_) { /* already gone */ }
        return false;
      }
    },
    end(data, cb) {
      if (this._destroyed) return;
      try {
        if (data === undefined && cb === undefined) raw.end();
        else if (cb === undefined) raw.end(data);
        else raw.end(data, cb);
      } catch (err) {
        try { raw.destroy(err); } catch (_) { /* already gone */ }
      }
    },
    destroy(err) {
      if (this._destroyed) return;
      this._destroyed = true;
      try { raw.destroy(err ? err : undefined); } catch (_) { /* already gone */ }
      // Node's https.destroy(err) re-emits 'error' with that err; Electron's
      // does not reliably do so — emit it on the adapter ourselves so the
      // cancellation sentinels ("Transcription cancelled") reach the caller
      // on BOTH transports. The internal no-op listener below keeps an
      // empty-listener 'error' emit from throwing.
      if (err) {
        try { adapterEmitter.emit("error", err); } catch (_) { /* no listeners */ }
      }
    },
    on(evt, fn) {
      adapterEmitter.on(evt, fn);
      // Forward raw events the call sites listen to. 'response' is already
      // routed through the constructor callback; 'error' and 'drain' go
      // through the adapter emitter.
      if (!forwarded.has(evt)) {
        forwarded.add(evt);
        if (evt === "error" || evt === "drain") {
          try {
            raw.on(evt, (...args) => adapterEmitter.emit(evt, ...args));
          } catch (_) { /* raw already gone */ }
        }
      }
      return this;
    },
    once(evt, fn) {
      adapterEmitter.once(evt, fn);
      if (!forwarded.has(evt)) {
        forwarded.add(evt);
        if (evt === "error" || evt === "drain") {
          try {
            raw.on(evt, (...args) => adapterEmitter.emit(evt, ...args));
          } catch (_) { /* raw already gone */ }
          // 'once' on the adapter side is handled by the emitter; the raw
          // relay above stays attached but extra emits are harmless.
        }
      }
      return this;
    },
    setTimeout(ms, cb) {
      if (!Number.isFinite(ms) || ms <= 0) return this;
      // Node's req.setTimeout is socket-inactivity-based; Electron's
      // ClientRequest has no setTimeout at all. A plain timer that fires
      // cb once covers both (call sites destroy the request in cb).
      const timer = setTimeout(() => {
        if (this._destroyed) return;
        try { cb && cb(); } catch (_) { /* caller throws on its own req */ }
      }, ms);
      const teardown = () => clearTimeout(timer);
      adapterEmitter.once("error", teardown);
      adapterEmitter.once("adapter-finished", teardown);
      try {
        raw.once("close", teardown);
        raw.once("finish", teardown);
      } catch (_) { /* best effort */ }
      return this;
    },
  };

  // Internal emitter backing the adapter's on/once. A permanently-attached
  // no-op 'error' listener prevents "Unhandled 'error' event" crashes when
  // destroy(err) fires with no external listener yet.
  const adapterEmitter = new (require("events").EventEmitter)();
  adapterEmitter.on("error", () => { /* swallow for safety */ });

  const forwarded = new Set();

  // Route raw 'error' into the adapter even if the call site attaches its
  // handler AFTER createRequest returns (the normal pattern).
  try {
    raw.on("error", (err) => adapterEmitter.emit("error", err));
    forwarded.add("error");
  } catch (_) { /* raw gone */ }

  // Tell the timeout layer when the request body fully flushed.
  try {
    raw.once("finish", () => adapterEmitter.emit("adapter-finished"));
  } catch (_) { /* best effort */ }

  adapter._usingElectron = usingElectron;
  return adapter;
}

module.exports = {
  createRequest,
  transportName,
  isElectronNet: () => !!electronNet,
};
