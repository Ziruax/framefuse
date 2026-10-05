// electron/groq-fetch-adapter.js — the bridge between the official groq-sdk
// and this app's net-transport (v1.31/v1.32 transport layer).
//
// WHY THIS EXISTS (v1.33, user brief "Use the official groq-sdk"):
// the SDK's default engine is Node's global fetch (undici) — which IGNORES
// the OS proxy and has a non-browser TLS fingerprint. v1.31/v1.32 proved
// both matter on real machines (proxy/VPN/AV-routed users could not reach
// Groq while their browser could). The SDK accepts a custom `fetch` — this
// adapter IS that fetch: it converts the SDK's WHATWG Request pieces
// (Headers instance, FormData/String/Buffer body) into a createRequest()
// call on the app transport, preserving:
//   • Chromium net inside Electron (browser TLS + OS proxy/PAC honored)
//   • plain Node https otherwise (and on demand: mode "node" = the DIRECT
//     proxy-bypassing retry path from v1.32's transport failover)
//   • upload progress callbacks (sliced writes with drain handling)
//   • AbortSignal support (SDK cancellation → req.destroy)
//
// The SDK's error taxonomy (APIError subclasses with .status and parsed
// .error bodies) flows back untouched, so the app's classifier keeps
// working — now fed by the SDK's structured errors instead of raw sockets.
//
// This module is a PLAIN Node CJS module (electron require is guarded in
// net-transport.js).

const { createRequest, isElectronNet } = require("./net-transport.js");

/** Read headers from a Headers instance OR a plain object → {name:value}. */
function flattenHeaders(h) {
  const out = {};
  if (!h) return out;
  if (typeof h.entries === "function") {
    for (const [k, v] of h.entries()) out[k.toLowerCase()] = v;
    return out;
  }
  if (typeof h.forEach === "function" && typeof h.get !== "function") {
    // plain-object-ish Headers polyfill
    h.forEach((v, k) => {
      out[String(k).toLowerCase()] = v;
    });
    return out;
  }
  for (const k of Object.keys(h)) out[k.toLowerCase()] = h[k];
  return out;
}

/**
 * Convert the SDK's fetch body into { buffer, contentType }.
 * FormData is re-serialized through the WHATWG Response constructor — the
 * content-type from THAT Response carries the boundary that matches the
 * serialized bytes (using the SDK's header with a different boundary would
 * corrupt the multipart stream). Other bodies (String/Buffer/Uint8Array/
 * Blob) pass through with no content-type substitution.
 */
async function bodyToBuffer(body) {
  if (body == null) return { buffer: null, contentType: null };
  if (typeof body === "string") return { buffer: Buffer.from(body, "utf8"), contentType: null };
  if (Buffer.isBuffer(body)) return { buffer: body, contentType: null };
  if (body instanceof Uint8Array) return { buffer: Buffer.from(body), contentType: null };
  if (typeof body.arrayBuffer === "function" && typeof body.stream !== "function") {
    // Blob-like
    const buf = Buffer.from(await body.arrayBuffer());
    return { buffer: buf, contentType: body.type || null };
  }
  if (typeof body === "object" && typeof body.append === "function") {
    // FormData — the boundary-correct serialization
    const r = new Response(body);
    const buf = Buffer.from(await r.arrayBuffer());
    return { buffer: buf, contentType: r.headers.get("content-type") };
  }
  if (typeof (body && body.stream) === "function") {
    // ReadableStream — drain it
    const reader = body.getReader();
    const parts = [];
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      parts.push(Buffer.from(value));
    }
    return { buffer: Buffer.concat(parts), contentType: null };
  }
  return { buffer: Buffer.from(String(body)), contentType: null };
}

/**
 * Build a fetch implementation for the Groq SDK.
 * @param {"auto"|"node"} transportMode "auto" → electron-net when available
 *        (OS-proxy-honoring); "node" → always plain Node https (DIRECT,
 *        proxy-bypassing — the v1.32 failover retry path).
 * @param {{onUploadProgress?: ({uploaded:number,total:number})=>void,
 *          label?: string}} [opts] progress sink (multipart uploads)
 */
function makeGroqFetch(transportMode, opts) {
  const onUploadProgress = opts && typeof opts.onUploadProgress === "function" ? opts.onUploadProgress : null;
  const label = (opts && opts.label) || "groq-sdk";

  return async function groqSdkFetch(url, init) {
    const u = new URL(String(url));
    const flat = flattenHeaders(init && init.headers);
    const { buffer, contentType } = await bodyToBuffer(init && init.body);
    if (contentType) flat["content-type"] = contentType;

    // Content-Length is handled by the transport layer; Electron net
    // rejects manual Content-Length (net::ERR_INVALID_ARGUMENT, v1.31).
    delete flat["content-length"];

    return await new Promise((resolve, reject) => {
      const req = createRequest(
        {
          host: u.hostname,
          path: u.pathname + u.search,
          method: (init && init.method) || "GET",
          port: u.port ? parseInt(u.port, 10) : 443,
          transport: transportMode === "node" ? "node" : undefined,
          headers: flat,
        },
        (res) => {
          const chunks = [];
          res.on("data", (d) => chunks.push(d));
          res.on("end", () => {
            const bodyBuf = Buffer.concat(chunks);
            const status = res.statusCode || 502;
            const headers = {};
            for (const k of Object.keys(res.headers || {})) {
              const v = res.headers[k];
              headers[k.toLowerCase()] = Array.isArray(v) ? v.join(", ") : String(v);
            }
            // 204/304 responses MUST NOT carry a body (Response ctor throws)
            if (status === 204 || status === 304) {
              resolve(new Response(null, { status, headers }));
            } else {
              resolve(new Response(bodyBuf, { status, headers }));
            }
          });
          res.on("error", (e) => reject(e));
        },
      );

      const fail = (e) => {
        if (!e) e = new Error(`${label}: connection failed`);
        try { e.__groqTransport = transportMode; } catch (_) { /* frozen */ }
        reject(e);
      };
      req.on("error", fail);

      // AbortSignal → destroy the request
      const signal = init && init.signal;
      if (signal && typeof signal.addEventListener === "function") {
        const onAbort = () => {
          const e = new Error(`${label}: request aborted`);
          e.name = "AbortError";
          try { req.destroy(e); } catch (_) { /* gone */ }
        };
        signal.addEventListener("abort", onAbort, { once: true });
        req.once("close", () => signal.removeEventListener("abort", onAbort));
      }

      if (buffer) {
        // Sliced writes with drain handling → progress + backpressure.
        const total = buffer.length;
        const CHUNK = 256 * 1024;
        let off = 0;
        const writeNext = () => {
          while (off < total) {
            const slice = buffer.slice(off, off + CHUNK);
            off += slice.length;
            const ok = req.write(slice);
            if (onUploadProgress) {
              try { onUploadProgress({ uploaded: off, total }); } catch (_) { /* sink */ }
            }
            if (!ok) { rescheduleDrain(); return; }
          }
          req.end();
        };
        const rescheduleDrain = () => {
          req.once("drain", () => writeNext());
        };
        writeNext();
      } else {
        req.end();
      }
    });
  };
}

/**
 * Per-API-key SDK client cache — one client per (key, transport) pair.
 * The SDK client is stateless besides its options; caching avoids
 * rebuilding the adapter per call. mode "auto" → electron-net fetch,
 * "node" → direct Node https fetch (failover path).
 */
const clientCache = new Map();

/** v1.33 VENDOR LOADER: the packaged app packs ZERO node_modules (build
 *  config `!node_modules`) — the SDK ships as a self-contained bundle at
 *  electron/vendor/groq-sdk.cjs (scripts/bundle-vendor-libs.js). The dev
 *  layout prefers the real package; MODULE_NOT_FOUND falls to the vendor.
 *  Bundling order matters: vendor last so dev always exercises the fresh
 *  package while the ASAR gets the deterministic bundle. */
function loadGroqSdk() {
  try {
    const m = require("groq-sdk");
    return (m && m.default) || m;
  } catch (_) {
    return require("./vendor/groq-sdk.cjs");
  }
}

/** @returns {import("groq-sdk").default} */
function sdkClient(apiKey, transportMode, opts) {
  const mode = transportMode === "node" ? "node" : "auto";
  const cacheKey = `${apiKey}|${mode}`;
  let entry = clientCache.get(cacheKey);
  if (entry) return entry;
  const Groq = loadGroqSdk();
  const client = new Groq({
    apiKey,
    maxRetries: 0, // the app owns retry policy (classification-aware)
    timeout: (opts && opts.timeoutMs) || 120000,
    fetch: makeGroqFetch(mode, opts),
  });
  entry = { client };
  clientCache.set(cacheKey, entry);
  return entry;
}

/** Are the "auto" and "node" transports actually different right now?
 *  (In plain Node both are Node https — failover retries are pointless.) */
function transportsDiffer() {
  return !!isElectronNet();
}

/** Clear the client cache (config/test hygiene). */
function resetSdkClients() {
  clientCache.clear();
}

module.exports = {
  makeGroqFetch,
  sdkClient,
  transportsDiffer,
  resetSdkClients,
  flattenHeaders,
  bodyToBuffer,
};
