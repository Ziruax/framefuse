// electron/edge-tts.js — Microsoft Edge neural TTS engine (the free
// "Read Aloud" service) for in-editor voiceovers and multi-language video
// dubbing (electron/dub-workflow.js consumes this module).
//
// v1.16 — FrameFuse needs neural voices without a cloud API key or a
// bundled TTS runtime. Edge's Read Aloud endpoint serves the same voices
// as the Edge browser's narrator over an undocumented protocol that was
// reverse-engineered by the community (see github.com/rany2/edge-tts).
// It is free and keyless, but uncontracted — it can change or throttle at
// any time, so every failure path degrades cleanly here (built-in
// FALLBACK_VOICES catalog, descriptive errors, one bounded retry).
//
// PROTOCOL SUMMARY
//   1. DRM token "Sec-MS-GEC" (required since Nov 2024):
//        ticks  = (Unix seconds + 11644473600) * 1e7   → 100-ns units since
//                 the Windows epoch 1601-01-01, rounded DOWN to a 5-minute
//                 window;
//        token  = UPPERCASE HEX( SHA-256( decimal(ticks) + CLIENT_TOKEN ) )
//      The value flips every 5 minutes — it is regenerated per connection
//      attempt, never cached.
//   2. Voice list: plain HTTPS GET
//        /consumer/speech/synthesize/readaloud/voices/list?trustedclienttoken=…
//      with Sec-MS-GEC + Sec-MS-GEC-Version + a real Edge User-Agent + the
//      Read Aloud extension Origin. The body is a JSON array of voice
//      descriptors. When the fetch fails (offline / 403 / timeout) the
//      built-in FALLBACK_VOICES catalog is served instead.
//   3. Synthesis: a WebSocket session (RFC 6455) to
//        wss://speech.platform.bing.com/consumer/speech/synthesize/
//             readaloud/edge/v1?TrustedClientToken=…&Sec-MS-GEC=…&
//             Sec-MS-GEC-Version=…&ConnectionId=<32-hex>
//      The packaged app runs Electron 33 (Node 20.18), which does NOT
//      expose a global WebSocket — so the client is implemented RAW on
//      tls.connect(): an HTTP/1.1 "Upgrade: websocket" handshake, then
//      manual RFC-6455 framing (masked client text frames out; unmasked
//      server text/binary frames in; minimal fragmentation + ping/pong).
//   4. After the 101, exactly two masked TEXT messages are sent:
//        Path:speech.config — output format + boundary metadata options
//        Path:ssml          — the utterance (XML-escaped, prosody-wrapped)
//   5. The server answers with binary frames of the shape
//        [uint16 BE header length][ASCII header\r\n][payload]
//      where Path:audio frames carry raw MP3 (audio-24khz-48kbitrate-
//      mono-mp3). Path:audio.metadata carries word-boundary JSON — it
//      arrives as TEXT frames on the live service (same header\r\n\r\nbody
//      layout as turn.end; binary metadata frames are also accepted) and
//      is parsed into per-word {text, offsetMs, durationMs} timings — the
//      Offset/Duration fields are 100-ns FILETIME ticks, /10,000 → ms.
//      TEXT frames
//      drive the session: Path:turn.end = done; Path:response may carry a
//      403-style service error; Path:notification / turn.start are noise.
//      The MP3 chunks are concatenated and returned (or written to
//      o.outFile).
//
// Robustness rules (see the task contract with dub-workflow.js):
//   • Overall timeout per attempt: 25 s + 20 ms per character of text (a
//     2800-char long-form chunk legitimately streams for tens of seconds;
//     short dub lines still die at the 25 s baseline); socket destroyed,
//     promise rejected. ONE full retry with a freshly generated Sec-MS-GEC
//     + ConnectionId on 403-ish failures or handshake stalls.
//   • 403 at the upgrade also teaches the module the server clock (from the
//     response Date header) — the token window is validated server-side, so
//     a wrong LOCAL clock otherwise means permanent 403s.
//   • The service VERSION-GATES the client: the User-Agent must claim a
//     current Edge build (see CHROMIUM_FULL_VERSION below — bumped from the
//     historical 131 after the live service started 403-ing it).
//   • Max 3000 characters of text per call (callers must chunk longer
//     scripts); max 3 concurrent syntheses — extra callers queue FIFO.
//   • synthesizeLong() splits scripts up to 1.5 M characters (~200 k
//     words) into ≤2800-char sentence chunks, synthesizes them through the
//     same 3-slot queue, and merges ONE MP3 + GLOBAL word timings (per-
//     chunk duration comes from the byte count — 48 kbps CBR ⇒ 6000 B/s);
//     a single abortRef cancels every chunk, in flight and queued.
//   • o.abortRef = { abort: null } is populated with a cancel function
//     (same pattern as groq-whisper.js) and works while queued, too.
//
// Zero npm dependencies (Node built-ins only), zero Electron imports —
// smoke-testable directly:
//   node -e "require('./electron/edge-tts').listVoices().then(v => …)"

"use strict";

const fs = require("fs");
const path = require("path");
const https = require("https");
const tls = require("tls");
const net = require("net");
const crypto = require("crypto");
const { isMp3Buffer } = require("./audio-format");

const SPEECH_HOST = "speech.platform.bing.com";
const TRUSTED_CLIENT_TOKEN = "6A5AA1D4EAFF4E9FB37E23D68491D6F4";
// GOTCHA (verified 2026-10): the service gates on the CLIENT EDGE VERSION —
// an Edg/131-era User-Agent gets HTTP 403 at the WSS upgrade even with a
// perfectly valid Sec-MS-GEC token, while Edg/143 is accepted. The original
// reverse-engineered pair ("1-131.0.2903.112" + Edg/131) has aged out.
// Both constants below therefore mirror the CURRENT reference client
// (github.com/rany2/edge-tts, Chromium 143.0.3650.75) and must be bumped
// TOGETHER if the service ever ratchets again.
const CHROMIUM_FULL_VERSION = "143.0.3650.75";
const CHROMIUM_MAJOR_VERSION = CHROMIUM_FULL_VERSION.split(".")[0];
const SEC_MS_GEC_VERSION = `1-${CHROMIUM_FULL_VERSION}`;
const EDGE_USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
  `(KHTML, like Gecko) Chrome/${CHROMIUM_MAJOR_VERSION}.0.0.0 Safari/537.36 ` +
  `Edg/${CHROMIUM_MAJOR_VERSION}.0.0.0`;
/** Origin of the Edge "Read Aloud" extension the service expects. */
const EXTENSION_ORIGIN = "chrome-extension://jdiccldimpdaibmpdkjnbmckianbfold";

const VOICES_PATH = "/consumer/speech/synthesize/readaloud/voices/list";
const WSS_PATH = "/consumer/speech/synthesize/readaloud/edge/v1";
const OUTPUT_FORMAT = "audio-24khz-48kbitrate-mono-mp3";

/** The service caps one synthesis request; longer scripts must be chunked
 *  by the caller (dub-workflow.js splits on sentence boundaries). */
const MAX_TEXT_LEN = 3000;
/** synthesizeLong() input cap — ~200,000 words ≈ 1.5 M characters. */
const MAX_LONG_TEXT_LEN = 1500000;
/** Chunk size for synthesizeLong() — under the per-request 3000 cap with
 *  headroom for the SSML/prosody wrapper. */
const LONG_CHUNK_LEN = 2800;
const VOICES_TIMEOUT_MS = 15000;
const SYNTH_TIMEOUT_MS = 25000;
// v1.32: 15 s (was 10) — the handshake window now also covers the system
// proxy CONNECT/SOCKS tunnel setup before TLS even starts.
const HANDSHAKE_TIMEOUT_MS = 15000;
/** In-flight cap — extra synthesize() callers wait in a FIFO queue. */
const MAX_CONCURRENT_SYNTH = 3;
/** Sanity guards for the raw frame parser (service frames are ~KB sized). */
const MAX_WS_FRAME_BYTES = 16 * 1024 * 1024;
const MAX_AUDIO_BYTES = 64 * 1024 * 1024;
/** After a failed network fetch, wait this long before trying again. */
const VOICE_FETCH_COOLDOWN_MS = 60000;

// Prosody sanity clamps (the service clamps server-side too — these just
// keep callers from shooting themselves in the foot silently far range).
const RATE_RANGE = [-95, 300]; // %
const PITCH_RANGE = [-200, 200]; // Hz
const VOLUME_RANGE = [-100, 100]; // %

// ---------------------------------------------------------------------------
// DRM token (Sec-MS-GEC)
// ---------------------------------------------------------------------------

const WIN_EPOCH_SECONDS = 11644473600n; // 1601-01-01 → 1970-01-01
const FIVE_MINUTES_IN_100NS = 300n * 10000000n;

// Clock skew learned from a 403 response's Date header. The token window is
// validated against the SERVER's clock — a wrong local system clock (dead
// CMOS battery, VM snapshot) is the classic all-403s failure mode.
let clockSkewMs = 0;

/** Parse an RFC-1123 "Date:" header from an HTTP response head and
 *  (re)learn the server-vs-local clock skew. Clamped to ±24 h sanity. */
function learnClockSkewFromResponseHead(responseHead) {
  const m = /^Date:\s*(.+)$/im.exec(responseHead);
  if (!m) return;
  const serverMs = Date.parse(m[1].trim());
  if (!Number.isFinite(serverMs)) return;
  const skew = serverMs - Date.now();
  if (Math.abs(skew) <= 24 * 3600 * 1000) clockSkewMs = skew;
}

/** Generate the Sec-MS-GEC DRM token for RIGHT NOW (rounded down to the
 *  5-minute window, so it stays stable for a few minutes, then flips).
 *  Regenerated on every connection attempt — never cached.
 *  @returns {string} 64 uppercase hex chars. */
function generateSecMsgEC() {
  const unixSeconds = BigInt(Math.floor((Date.now() + clockSkewMs) / 1000));
  let ticks = (unixSeconds + WIN_EPOCH_SECONDS) * 10000000n; // 100-ns units
  ticks -= ticks % FIVE_MINUTES_IN_100NS; // round DOWN to the window
  return crypto
    .createHash("sha256")
    .update(ticks.toString() + TRUSTED_CLIENT_TOKEN, "utf8")
    .digest("hex")
    .toUpperCase();
}

// ---------------------------------------------------------------------------
// v1.32 SYSTEM-PROXY TUNNEL — make the raw-TLS WSS path proxy-aware.
//
// WHY: Node's tls module IGNORES the OS proxy configuration. On machines
// whose only working internet route is a system proxy (VPN client, corporate
// PAC, antivirus "web protection"), every raw-Node connection dies while the
// browser — and Electron's Chromium net stack — works fine. That is the
// "TTS synthesis failed" family: the app is otherwise online but the WSS
// connection to speech.platform.bing.com can never be established directly.
//
// HOW: inside the Electron main process we ask Chromium which proxy it
// WOULD use for the target host (session.resolveProxy — PAC/system-config
// aware), then
//   • PROXY / HTTPS lines → an HTTP CONNECT tunnel, TLS over the tunnel
//   • SOCKS5 lines       → a minimal no-auth SOCKS5 client, TLS over it
//   • DIRECT             → the direct connection, exactly as before
// In plain Node (web routes, smoke tests) there is no session — we stay
// direct. Any tunnel failure falls back to DIRECT, so a broken proxy config
// can never behave worse than the pre-v1.32 code.
// ---------------------------------------------------------------------------

/** Electron session (main process) or false when unavailable. Cached. */
let electronSessionCache; // undefined = not probed yet
function electronSession() {
  if (electronSessionCache !== undefined) return electronSessionCache;
  try {
    if (process.versions && process.versions.electron) {
      const electron = require("electron");
      electronSessionCache =
        electron && typeof electron === "object" && electron.session &&
          typeof electron.session.resolveProxy === "function"
          ? electron.session
          : false;
    } else {
      electronSessionCache = false;
    }
  } catch (_) {
    electronSessionCache = false;
  }
  return electronSessionCache;
}

let proxyLineCache = { at: 0, host: "", line: "DIRECT" };

/** Chromium's proxy verdict for `host`, cached 30 s. "DIRECT" when we
 *  cannot ask (plain Node) or Chromium cannot decide. */
async function resolveProxyLine(host) {
  const session = electronSession();
  if (!session) return "DIRECT";
  const now = Date.now();
  if (proxyLineCache.host === host && now - proxyLineCache.at < 30000) {
    return proxyLineCache.line;
  }
  try {
    const line = await session.resolveProxy(`https://${host}/`);
    proxyLineCache = { at: now, host, line: line || "DIRECT" };
    return proxyLineCache.line;
  } catch (_) {
    return "DIRECT";
  }
}

/** "PROXY 10.0.0.1:8080; DIRECT" → { kind: "http"|"socks5", host, port }
 *  or null for DIRECT / unparseable / SOCKS4 (unsupported). */
function parseProxyLine(line) {
  const s = String(line || "").trim();
  if (!s || /^direct$/i.test(s)) return null;
  const first = s.split(";")[0].trim();
  const m = /^(PROXY|HTTPS|SOCKS4A|SOCKS4|SOCKS5|SOCKS)\s+(\[?[^\]\s]+\]?):(\d+)$/i.exec(first);
  if (!m) return null;
  const word = m[1].toUpperCase();
  if (word === "SOCKS5") return { kind: "socks5", host: m[2].replace(/^[\[\]]/g, ""), port: parseInt(m[3], 10) };
  if (word === "PROXY" || word === "HTTPS") {
    return { kind: "http", host: m[2].replace(/^[\[\]]/g, ""), port: parseInt(m[3], 10) };
  }
  return null; // SOCKS4 — unsupported, treat as direct
}

/** HTTP CONNECT tunnel through `proxy` → a plain socket wired to host:port. */
function connectThroughHttpProxy(proxy, host, port, timeoutMs = 8000) {
  return new Promise((resolve, reject) => {
    const sock = net.connect({ host: proxy.host, port: proxy.port });
    let buf = Buffer.alloc(0);
    let done = false;
    const finish = (err, socket) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      sock.removeAllListeners("data");
      sock.removeAllListeners("error");
      if (err) {
        try { sock.destroy(); } catch (_) { /* already gone */ }
        reject(err);
      } else {
        resolve(socket);
      }
    };
    const timer = setTimeout(
      () => finish(new Error(`the system proxy ${proxy.host}:${proxy.port} timed out during CONNECT`)),
      timeoutMs,
    );
    sock.on("error", (err) =>
      finish(new Error(`could not reach the system proxy ${proxy.host}:${proxy.port}: ${err.message}`)));
    sock.on("data", (d) => {
      buf = Buffer.concat([buf, d]);
      const sep = buf.indexOf("\r\n\r\n");
      if (sep === -1) {
        if (buf.length > 8192) finish(new Error("proxy CONNECT response too large"));
        return;
      }
      const head = buf.slice(0, sep).toString("latin1");
      const m = /^HTTP\/\d\.\d\s+(\d{3})/.exec(head);
      if (m && m[1] === "200") {
        finish(null, sock);
      } else {
        finish(
          new Error(`the system proxy refused CONNECT to ${host}:${port} (HTTP ${m ? m[1] : "unparseable"})`),
        );
      }
    });
    sock.write(`CONNECT ${host}:${port} HTTP/1.1\r\nHost: ${host}:${port}\r\n\r\n`);
  });
}

/** Minimal no-auth SOCKS5 client → a plain socket wired to host:port. */
function connectThroughSocks5(proxy, host, port, timeoutMs = 8000) {
  return new Promise((resolve, reject) => {
    const sock = net.connect({ host: proxy.host, port: proxy.port });
    let buf = Buffer.alloc(0);
    let sent = false;
    let done = false;
    const finish = (err, socket) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      sock.removeAllListeners("data");
      sock.removeAllListeners("error");
      if (err) {
        try { sock.destroy(); } catch (_) { /* already gone */ }
        reject(err);
      } else {
        resolve(socket);
      }
    };
    const timer = setTimeout(
      () => finish(new Error(`the SOCKS proxy ${proxy.host}:${proxy.port} timed out`)),
      timeoutMs,
    );
    sock.on("error", (err) =>
      finish(new Error(`could not reach the SOCKS proxy ${proxy.host}:${proxy.port}: ${err.message}`)));
    sock.on("data", (d) => {
      buf = Buffer.concat([buf, d]);
      if (!sent) {
        // --- greeting reply: VER=05 METHOD=00 (no auth) ---
        if (buf.length < 2) return;
        if (buf[0] !== 0x05) {
          finish(new Error("the SOCKS proxy is not speaking SOCKS5"));
          return;
        }
        if (buf[1] !== 0x00) {
          finish(new Error("the SOCKS proxy requires authentication (unsupported)"));
          return;
        }
        buf = buf.slice(2);
        sent = true;
        // --- CONNECT request: VER=5 CMD=1 RSV=0 ATYP=3 (domain) ---
        const hostBuf = Buffer.from(host, "utf8");
        const req = Buffer.alloc(7 + hostBuf.length);
        req[0] = 0x05;
        req[1] = 0x01;
        req[2] = 0x00;
        req[3] = 0x03;
        req[4] = hostBuf.length;
        hostBuf.copy(req, 5);
        req.writeUInt16BE(port, 5 + hostBuf.length);
        sock.write(req);
      }
      // --- connect reply (may arrive in the same chunk as the greeting) ---
      if (buf.length < 4) return;
      if (buf[1] !== 0x00) {
        finish(new Error(`the SOCKS proxy refused the connection (code 0x${buf[1].toString(16)})`));
        return;
      }
      const atyp = buf[3];
      let addrLen;
      if (atyp === 0x01) addrLen = 4;
      else if (atyp === 0x04) addrLen = 16;
      else if (atyp === 0x03) {
        if (buf.length < 5) return;
        addrLen = 1 + buf[4];
      } else {
        finish(new Error("SOCKS reply had an unknown address type"));
        return;
      }
      if (buf.length < 4 + addrLen + 2) return;
      finish(null, sock);
    });
    // greeting: VER=5, ONE method, NO-AUTH
    sock.write(Buffer.from([0x05, 0x01, 0x00]));
  });
}

/** v1.32: open the TLS socket to `host`:443 — through the system proxy when
 *  Chromium reports one, else direct. Tunnel failures fall back to DIRECT
 *  (the pre-v1.32 behavior) so a stale proxy config never regresses. */
async function openProxiedTls(host, alpnProtocols) {
  let line = "DIRECT";
  try {
    line = await resolveProxyLine(host);
  } catch (_) {
    line = "DIRECT";
  }
  const proxy = parseProxyLine(line);
  if (!proxy) {
    return tls.connect({ host, port: 443, servername: host, ALPNProtocols: alpnProtocols });
  }
  try {
    const raw =
      proxy.kind === "socks5"
        ? await connectThroughSocks5(proxy, host, 443)
        : await connectThroughHttpProxy(proxy, host, 443);
    return tls.connect({ sock: raw, servername: host, ALPNProtocols: alpnProtocols });
  } catch (_) {
    // The proxy path failed → direct, exactly the pre-v1.32 behavior.
    return tls.connect({ host, port: 443, servername: host, ALPNProtocols: alpnProtocols });
  }
}

// ---------------------------------------------------------------------------
// v1.33 PACKAGE ENGINE — edge-tts-universal (user directive: adopt the
// maintained community implementation as the PRIMARY synthesis engine).
//
// WHY: the service protocol (Sec-MS-GEC DRM token, WSS framing, metadata
// stream) is UNOFFICIAL and Microsoft changes it periodically. A community
// package that tracks those changes is more durable than a private
// implementation. Its `Communicate` class supports a PROXY URL
// (HttpsProxyAgent) — on machines where Chromium reports an HTTP(S) system
// proxy we hand it over; when Chromium reports SOCKS5 (the package's agent
// cannot do SOCKS) or DIRECT we run the package direct — and the RAW
// v1.32 client below remains the fallback engine: it owns the SOCKS5
// tunnel, the mstts voice STYLES (the package has no express-as support)
// and the exact word-metadata contract the app already verified.
//
// Failure contract: the package's typed errors (WebSocketError,
// NoAudioReceived, EdgeTTSException) are TRANSIENT (connection/service) →
// one package retry, then the raw engine. ValueError (invalid voice) and
// validation failures are NOT retryable — they surface directly.
// ---------------------------------------------------------------------------

/** The package, loaded lazily so this module stays requireable even if
 *  node_modules is partially staged (smoke tests, packaging edge cases). */
function loadTtsPackage() {
  try {
    return require("edge-tts-universal");
  } catch (err) {
    const e = new Error(
      `The edge-tts-universal package is not available (${err.message}) — ` +
        `falling back to the built-in Edge speech client`,
    );
    e.retryable = true; // the built-in client may still succeed
    throw e;
  }
}

/** Chromium's system-proxy verdict, converted to the package's proxy URL
 *  format (http://host:port for HTTP CONNECT proxies). SOCKS5 → null
 *  (the raw engine handles SOCKS natively). DIRECT/unavailable → null. */
async function packageProxyUrl() {
  try {
    const line = await resolveProxyLine(SPEECH_HOST);
    const proxy = parseProxyLine(line);
    if (!proxy || proxy.kind !== "http") return null;
    return `http://${proxy.host}:${proxy.port}`;
  } catch (_) {
    return null;
  }
}

/** +15 → "+15%", -10 → "-10%" (the package's prosody string format). */
const pctStr = (n) => `${n >= 0 ? "+" : ""}${Math.round(n)}%`;
/** +2 → "+2Hz", -5 → "-5Hz". */
const hzStr = (n) => `${n >= 0 ? "+" : ""}${Math.round(n)}Hz`;

/** Is this package error transient (retry / fallback) or terminal? */
function packageErrorIsTransient(err) {
  if (!err) return false;
  const name = err.constructor && err.constructor.name;
  if (name === "ValueError") return false; // invalid voice/text — fix the input
  if (name === "WebSocketError" || name === "NoAudioReceived" || name === "EdgeTTSException") return true;
  // Network-layer: ECONNRESET/ETIMEDOUT/EAI_AGAIN/socket hang up…
  return /socket|connect|network|timeout|timed out|ECONN|EAI_|hang up|EHOSTUNREACH|ENETUNREACH/i.test(
    String(err.message || err),
  );
}

/** Map a package error to a plain Error carrying the structured job shape
 *  (v1.33 user brief: service / code / message / retryable). */
function packageError(err, opts, engineLabel) {
  const voice = opts && opts.voice ? opts.voice : "";
  const name = err && err.constructor && err.constructor.name;
  let code = "TTS_SERVICE_ERROR";
  if (name === "ValueError") code = "TTS_INVALID_VOICE";
  else if (name === "NoAudioReceived") code = "TTS_NO_AUDIO_RESULT";
  else if (name === "WebSocketError") code = "TTS_CONNECTION_FAILED";
  const msg =
    name === "ValueError"
      ? `Voice "${voice}" is not a valid Edge neural voice — pick one from the voice list (Settings → Text to speech)`
      : `${engineLabel}: ${err && err.message ? err.message : String(err)}`;
  const e = new Error(msg);
  e.retryable = packageErrorIsTransient(err);
  e.job = {
    service: "edge-tts",
    code,
    message: msg,
    retryable: e.retryable,
  };
  return e;
}

/**
 * One synthesis attempt through the edge-tts-universal package.
 * @returns {Promise<{mp3:Buffer, words:Array<{text,offsetMs,durationMs}>}>}
 * @throws structured Error (err.job = {service,code,message,retryable})
 */
async function synthesizeViaPackage(opts) {
  const pkg = loadTtsPackage();
  const proxy = await packageProxyUrl();
  const audioParts = [];
  const words = [];
  let sawAudio = false;
  let comm;
  try {
    // NOTE: the constructor itself validates the voice (ValueError) — it
    // must live INSIDE this try or the error escapes unmapped.
    comm = new pkg.Communicate(opts.text, {
      voice: opts.voice,
      rate: pctStr(opts.ratePct || 0),
      volume: pctStr(opts.volumePct || 0),
      pitch: hzStr(opts.pitchHz || 0),
      ...(proxy ? { proxy } : {}),
      connectionTimeout: HANDSHAKE_TIMEOUT_MS,
    });
    for await (const chunk of comm.stream()) {
      if (opts.abortRef && opts.abortRef._cancelled) {
        throw cancelledError();
      }
      if (chunk && chunk.type === "audio" && chunk.data) {
        sawAudio = true;
        audioParts.push(Buffer.isBuffer(chunk.data) ? chunk.data : Buffer.from(chunk.data));
      } else if (chunk && chunk.type === "WordBoundary") {
        words.push({
          text: String(chunk.text || "").trim(),
          offsetMs: Math.round((Number(chunk.offset) || 0) / 10000),
          durationMs: Math.round((Number(chunk.duration) || 0) / 10000),
        });
      }
    }
  } catch (err) {
    if (err && err.cancelled) throw err;
    throw packageError(err, opts, "Edge TTS (edge-tts-universal engine)");
  }
  if (!sawAudio || audioParts.length === 0) {
    const e = new Error(
      "Edge TTS (edge-tts-universal engine): the service returned no audio for this request",
    );
    e.retryable = true;
    e.job = { service: "edge-tts", code: "TTS_NO_AUDIO_RESULT", message: e.message, retryable: true };
    throw e;
  }
  return { mp3: Buffer.concat(audioParts), words: words.filter((w) => w.text) };
}

// ---------------------------------------------------------------------------
// Voice catalog — live fetch with a session cache + built-in fallback
// ---------------------------------------------------------------------------

/** Normalize one raw voice descriptor from the service (or the fallback
 *  table) into FrameFuse's shape.
 *  @returns {{shortName:string, gender:"Female"|"Male", locale:string,
 *             friendlyName:string, displayName:string,
 *             localName?:string, styleList?:string[]}|null} */
function normalizeVoice(v) {
  if (!v || typeof v !== "object") return null;
  const shortName = typeof v.ShortName === "string" ? v.ShortName.trim() : "";
  if (!shortName) return null;
  const locale =
    typeof v.Locale === "string" && v.Locale ? v.Locale : localeFromVoice(shortName);
  const gender = v.Gender === "Male" ? "Male" : "Female";
  // The live list gives "Microsoft Madhur Online (Natural) - Hindi (India)";
  // strip the marketing wrapper when present, otherwise derive from the
  // short name ("hi-IN-MadhurNeural" → "Madhur").
  let friendlyName = "";
  if (typeof v.FriendlyName === "string") {
    const m = /^Microsoft\s+(.+?)\s+Online\b/.exec(v.FriendlyName);
    if (m) friendlyName = m[1].trim();
  }
  if (!friendlyName) {
    const tail = shortName.split("-").slice(2).join("-").replace(/Neural$/, "");
    friendlyName = tail || shortName;
  }
  return {
    shortName,
    gender,
    locale,
    friendlyName,
    displayName: `${friendlyName} (${locale}, ${gender})`,
    // Optional catalog extras — present ONLY when the source provides them
    // (the built-in fallback table has neither). The live list ships
    // LocalName directly and StyleList as a comma-separated string
    // ("cheerful, sad") — styleList is the split array. Existing field
    // names are untouched.
    ...(typeof v.LocalName === "string" && v.LocalName.trim()
      ? { localName: v.LocalName.trim() }
      : {}),
    ...(typeof v.StyleList === "string" && v.StyleList.trim()
      ? {
          styleList: v.StyleList.split(",")
            .map((s) => s.trim())
            .filter(Boolean),
        }
      : {}),
  };
}

/** Build a fallback-catalog entry directly. */
function fallbackVoice(shortName, gender, friendlyName) {
  return normalizeVoice({
    ShortName: shortName,
    Gender: gender,
    Locale: shortName.split("-").slice(0, 2).join("-"),
    FriendlyName: friendlyName,
  });
}

/** Built-in catalog used when the voice-list endpoint is unreachable
 *  (offline installs, service hiccups). Real published Read Aloud voices,
 *  female + male pairs per locale (en-US gets a spare pair). Order matters:
 *  the first female / first male of a locale become voicePairsByLocale()
 *  picks. */
const FALLBACK_VOICES = [
  // Hindi (India) — the dubbing default locale.
  fallbackVoice("hi-IN-SwaraNeural", "Female", "Swara"),
  fallbackVoice("hi-IN-MadhurNeural", "Male", "Madhur"),
  // English (United States)
  fallbackVoice("en-US-AriaNeural", "Female", "Aria"),
  fallbackVoice("en-US-GuyNeural", "Male", "Guy"),
  fallbackVoice("en-US-JennyNeural", "Female", "Jenny"),
  fallbackVoice("en-US-ChristopherNeural", "Male", "Christopher"),
  // English (India)
  fallbackVoice("en-IN-NeerjaNeural", "Female", "Neerja"),
  fallbackVoice("en-IN-PrabhatNeural", "Male", "Prabhat"),
  // English (United Kingdom)
  fallbackVoice("en-GB-SoniaNeural", "Female", "Sonia"),
  fallbackVoice("en-GB-RyanNeural", "Male", "Ryan"),
  // Urdu (Pakistan)
  fallbackVoice("ur-PK-UzmaNeural", "Female", "Uzma"),
  fallbackVoice("ur-PK-AsadNeural", "Male", "Asad"),
  // Arabic (Saudi Arabia)
  fallbackVoice("ar-SA-ZariyahNeural", "Female", "Zariyah"),
  fallbackVoice("ar-SA-HamedNeural", "Male", "Hamed"),
  // Bengali (India)
  fallbackVoice("bn-IN-TanishaaNeural", "Female", "Tanishaa"),
  fallbackVoice("bn-IN-BashkarNeural", "Male", "Bashkar"),
  // Spanish (Spain)
  fallbackVoice("es-ES-ElviraNeural", "Female", "Elvira"),
  fallbackVoice("es-ES-AlvaroNeural", "Male", "Álvaro"),
  // French (France)
  fallbackVoice("fr-FR-DeniseNeural", "Female", "Denise"),
  fallbackVoice("fr-FR-HenriNeural", "Male", "Henri"),
  // German (Germany)
  fallbackVoice("de-DE-KatjaNeural", "Female", "Katja"),
  fallbackVoice("de-DE-ConradNeural", "Male", "Conrad"),
  // Portuguese (Brazil)
  fallbackVoice("pt-BR-FranciscaNeural", "Female", "Francisca"),
  fallbackVoice("pt-BR-AntonioNeural", "Male", "Antônio"),
  // Russian (Russia)
  fallbackVoice("ru-RU-SvetlanaNeural", "Female", "Svetlana"),
  fallbackVoice("ru-RU-DmitryNeural", "Male", "Dmitry"),
  // Chinese (Mandarin, Simplified)
  fallbackVoice("zh-CN-XiaoxiaoNeural", "Female", "Xiaoxiao"),
  fallbackVoice("zh-CN-YunxiNeural", "Male", "Yunxi"),
  // Japanese (Japan)
  fallbackVoice("ja-JP-NanamiNeural", "Female", "Nanami"),
  fallbackVoice("ja-JP-KeitaNeural", "Male", "Keita"),
  // Indonesian (Indonesia)
  fallbackVoice("id-ID-GadisNeural", "Female", "Gadis"),
  fallbackVoice("id-ID-ArdiNeural", "Male", "Ardi"),
  // Tamil (India)
  fallbackVoice("ta-IN-PallaviNeural", "Female", "Pallavi"),
  fallbackVoice("ta-IN-ValluvarNeural", "Male", "Valluvar"),
  // Telugu (India)
  fallbackVoice("te-IN-ShrutiNeural", "Female", "Shruti"),
  fallbackVoice("te-IN-MohanNeural", "Male", "Mohan"),
  // Marathi (India)
  fallbackVoice("mr-IN-AarohiNeural", "Female", "Aarohi"),
  fallbackVoice("mr-IN-ManoharNeural", "Male", "Manohar"),
  // Turkish (Turkey)
  fallbackVoice("tr-TR-EmelNeural", "Female", "Emel"),
  fallbackVoice("tr-TR-AhmetNeural", "Male", "Ahmet"),
];

let voicesCache = null; // successful live fetch — kept for the session
let voicesPromise = null; // in-flight dedup for concurrent listVoices() calls
let voicesFailedAt = 0; // last network failure (drives the retry cooldown)

/** One HTTPS voice-list request. Rejects on any failure (status, network,
 *  parse, 15 s timeout, >8 MB body). */
function fetchVoiceList() {
  return new Promise((resolve, reject) => {
    const req = https.request(
      {
        host: SPEECH_HOST,
        path: `${VOICES_PATH}?trustedclienttoken=${TRUSTED_CLIENT_TOKEN}`,
        method: "GET",
        headers: {
          "Sec-MS-GEC": generateSecMsgEC(),
          "Sec-MS-GEC-Version": SEC_MS_GEC_VERSION,
          "User-Agent": EDGE_USER_AGENT,
          Origin: EXTENSION_ORIGIN,
          "Accept-Encoding": "identity", // we do not decompress
        },
      },
      (res) => {
        const chunks = [];
        let bytes = 0;
        res.on("data", (d) => {
          chunks.push(d);
          bytes += d.length;
          if (bytes > 8 * 1024 * 1024) {
            req.destroy();
            reject(new Error("Voice list response exceeded 8 MB"));
          }
        });
        res.on("end", () => {
          clearTimeout(timer);
          if (res.statusCode !== 200) {
            reject(new Error(`Voice list request failed (HTTP ${res.statusCode})`));
            return;
          }
          try {
            const list = JSON.parse(Buffer.concat(chunks).toString("utf8"));
            if (!Array.isArray(list) || list.length === 0) {
              reject(new Error("Voice list response was empty or malformed"));
              return;
            }
            const voices = list.map(normalizeVoice).filter(Boolean);
            if (voices.length === 0) {
              reject(new Error("Voice list contained no usable entries"));
            } else {
              resolve(voices);
            }
          } catch (err) {
            reject(new Error(`Could not parse the voice list: ${err.message}`));
          }
        });
      },
    );
    const timer = setTimeout(() => {
      req.destroy();
      reject(
        new Error(`Could not reach ${SPEECH_HOST} for the voice list (15s timeout)`),
      );
    }, VOICES_TIMEOUT_MS);
    req.on("error", (err) => {
      clearTimeout(timer);
      reject(err instanceof Error ? err : new Error(String(err)));
    });
    req.end();
  });
}

/** List the available neural voices (live fetch, cached for the session;
 *  FALLBACK_VOICES on any network/DRM failure — never rejects).
 *
 *  Callers get a fresh array each time (safe to sort/filter in place) but
 *  should treat the individual entries as read-only.
 *
 *  @returns {Promise<Array<{shortName:string, gender:"Female"|"Male",
 *                            locale:string, friendlyName:string,
 *                            displayName:string}>>} */
function listVoices() {
  if (voicesCache) return Promise.resolve(voicesCache.slice());
  if (voicesPromise) return voicesPromise;
  if (Date.now() - voicesFailedAt < VOICE_FETCH_COOLDOWN_MS) {
    // Recently failed — serve the fallback without burning another 15 s.
    return Promise.resolve(FALLBACK_VOICES.slice());
  }
  voicesPromise = fetchVoiceList().then(
    (voices) => {
      voicesCache = voices;
      voicesPromise = null;
      return voices.slice();
    },
    () => {
      voicesPromise = null;
      voicesFailedAt = Date.now();
      // Offline / 403 / throttled — degrade to the built-in catalog.
      return FALLBACK_VOICES.slice();
    },
  );
  return voicesPromise;
}

/** Map locale → { female, male } short names, for the dubbing flow's
 *  automatic male/female assignment per language. SYNCHRONOUS (dub-workflow
 *  consumes the plain map without await; `await`ing it elsewhere is still
 *  fine — a non-thenable resolves to itself): derived from the session
 *  voice-list cache when the live catalog has already been fetched
 *  (listVoices()), otherwise from the built-in FALLBACK_VOICES — a
 *  background listVoices() fetch is kicked off so later calls reflect the
 *  full live locale coverage (142+ locales vs the 19 fallback ones).
 *  Locales that ship only one gender reuse that voice for both fields so
 *  dubbing never dead-ends. Returns a fresh map each call — safe for
 *  callers to mutate.
 *
 *  @returns {Object<string, {female:string, male:string}>}
 */
function voicePairsByLocale() {
  const voices =
    voicesCache && voicesCache.length > 0 ? voicesCache : FALLBACK_VOICES;
  if (!voicesCache && !voicesPromise) {
    // Fire-and-forget warm-up — this call answers from the fallback catalog,
    // later calls use the live list. listVoices() never rejects (it falls
    // back internally); the catch is belt-and-braces.
    listVoices().catch(() => {});
  }
  const out = {};
  for (const v of voices) {
    if (!v.locale) continue;
    let entry = out[v.locale];
    if (!entry) {
      entry = { female: null, male: null };
      out[v.locale] = entry;
    }
    if (v.gender === "Male") {
      if (!entry.male) entry.male = v.shortName;
    } else if (!entry.female) entry.female = v.shortName;
  }
  for (const locale of Object.keys(out)) {
    const entry = out[locale];
    if (!entry.female) entry.female = entry.male;
    if (!entry.male) entry.male = entry.female;
  }
  return out;
}

// ---------------------------------------------------------------------------
// SSML construction
// ---------------------------------------------------------------------------

/** XML-escape & < > " ' for embedding text/attributes in the SSML. */
function escapeXml(s) {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

/** The service rejects a few C0 control characters (notably vertical tab,
 *  which shows up in OCR'd PDF text) — replace them with spaces. */
function removeIncompatibleCharacters(s) {
  return String(s).replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, " ");
}

/** Derive the SSML xml:lang locale from a voice name — accepts both the
 *  short form ("hi-IN-SwaraNeural") and the full service Name
 *  ("Microsoft Server Speech Text to Speech Voice (hi-IN, MadhurNeural)"). */
function localeFromVoice(voice) {
  const v = String(voice || "");
  if (v.startsWith("Microsoft Server Speech")) {
    const m = /\(([^,)]+),/.exec(v);
    if (m) return m[1].trim();
  }
  const parts = v.split("-");
  if (parts.length >= 2) return `${parts[0]}-${parts[1]}`;
  return "en-US";
}

/** Format a signed prosody value: 10/"%" → "+10%", -4/"Hz" → "-4Hz". */
function formatSigned(value, unit) {
  const v =
    typeof value === "number" && Number.isFinite(value)
      ? Math.round(value * 100) / 100
      : 0;
  return `${v >= 0 ? "+" : ""}${v}${unit}`;
}

/** Validate an optional mstts:express-as voice style. The voice catalog
 *  advertises per-voice styles ("cheerful", "newscast"…) in StyleList; the
 *  token must stay short and alphanumeric (plus -/_) so it can never
 *  smuggle markup into the SSML.
 *  @returns {string|null} trimmed style, or null when absent/empty. */
function normalizeStyleOption(style) {
  if (style === undefined || style === null) return null;
  if (typeof style !== "string") {
    throw new Error('synthesize: style must be a string (e.g. "cheerful")');
  }
  const s = style.trim();
  if (!s) return null;
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(s)) {
    throw new Error(
      `synthesize: invalid style "${s}" — expected a short alphanumeric ` +
        `token (e.g. "cheerful"; see the voice's styleList)`,
    );
  }
  return s;
}

/** Build the SSML utterance exactly as the service expects it.
 *  @param {{text:string, voice:string, locale?:string,
 *           ratePct?:number, pitchHz?:number, volumePct?:number,
 *           style?:string|null}} o — style wraps the prosody in
 *           <mstts:express-as> (voice styles; only voices that advertise
 *           them in StyleList actually render differently). */
function buildSsml(o) {
  const locale = o.locale || localeFromVoice(o.voice);
  const pitch = formatSigned(o.pitchHz, "Hz");
  const rate = formatSigned(o.ratePct, "%");
  const volume = formatSigned(o.volumePct, "%");
  const prosody =
    `<prosody pitch='${pitch}' rate='${rate}' volume='${volume}'>` +
    `${escapeXml(o.text)}</prosody>`;
  const styled = o.style
    ? `<mstts:express-as style='${escapeXml(o.style)}'>${prosody}</mstts:express-as>`
    : prosody;
  // The mstts namespace is declared on <speak> ONLY when a style is used,
  // so the styleless document stays byte-identical to the pre-style SSML
  // (existing callers — dub-workflow — see no change at all).
  return (
    `<speak version='1.0' xmlns='http://www.w3.org/2001/10/synthesis'` +
    `${o.style ? ` xmlns:mstts='http://www.w3.org/2001/mstts'` : ""} ` +
    `xml:lang='${escapeXml(locale)}'>` +
    `<voice name='${escapeXml(o.voice)}'>` +
    `${styled}` +
    `</voice></speak>`
  );
}

/** "Tue Jan 01 2025 00:00:00 GMT+0000 (Coordinated Universal Time)" — the
 *  JS-style UTC date the service expects in X-Timestamp headers (the SSML
 *  message additionally appends a literal "Z"). */
function jsUtcDateString() {
  const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  const MONTHS = [
    "Jan", "Feb", "Mar", "Apr", "May", "Jun",
    "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
  ];
  const d = new Date();
  const p2 = (n) => (n < 10 ? `0${n}` : String(n));
  return (
    `${DAYS[d.getUTCDay()]} ${MONTHS[d.getUTCMonth()]} ${p2(d.getUTCDate())} ` +
    `${d.getUTCFullYear()} ${p2(d.getUTCHours())}:${p2(d.getUTCMinutes())}:` +
    `${p2(d.getUTCSeconds())} GMT+0000 (Coordinated Universal Time)`
  );
}

// ---------------------------------------------------------------------------
// Raw RFC-6455 WebSocket client framing (no global WebSocket in Electron 33)
// ---------------------------------------------------------------------------

const OP_CONT = 0x0;
const OP_TEXT = 0x1;
const OP_BINARY = 0x2;
const OP_CLOSE = 0x8;
const OP_PING = 0x9;
const OP_PONG = 0xa;

/** Build ONE masked client frame (RFC 6455 §5.3 — clients MUST mask).
 *  @param {number} opcode 0x1 text, 0x2 binary, 0x8 close, 0x9/0xa ping/pong
 *  @param {Buffer} payload
 *  @returns {Buffer} complete frame, ready for a single socket.write() */
function buildWsFrame(opcode, payload) {
  const len = payload.length;
  let header;
  if (len < 126) {
    header = Buffer.alloc(2);
    header[1] = 0x80 | len;
  } else if (len < 65536) {
    header = Buffer.alloc(4);
    header[1] = 0x80 | 126;
    header.writeUInt16BE(len, 2);
  } else {
    header = Buffer.alloc(10);
    header[1] = 0x80 | 127;
    header.writeBigUInt64BE(BigInt(len), 2);
  }
  header[0] = 0x80 | opcode; // FIN + opcode (no fragmentation on send)
  const mask = crypto.randomBytes(4);
  const masked = Buffer.from(payload); // copy — never mutate the caller's data
  for (let i = 0; i < masked.length; i++) masked[i] ^= mask[i & 3];
  return Buffer.concat([header, mask, masked]);
}

/** Incremental parser for unmasked (and, defensively, masked) server
 *  frames. Handles length forms 7/16/64-bit, minimal fragmentation
 *  (continuation frames), and delivers control frames immediately.
 *
 *  @param {(opcode:number, payload:Buffer)=>void} onFrame
 *      called with COMPLETE messages (text/binary) or control frames.
 *  @param {(err:Error)=>void} [onError] protocol violations.
 *  @returns {{write:(chunk:Buffer)=>void}} */
function createWsFrameParser(onFrame, onError) {
  let pending = null;
  let fragOpcode = 0;
  let fragParts = null;

  const fail = (msg) => {
    pending = null;
    fragParts = null;
    fragOpcode = 0;
    if (onError) onError(new Error(msg));
  };

  const parse = () => {
    for (;;) {
      if (!pending || pending.length < 2) return;
      const first = pending[0];
      const fin = (first & 0x80) !== 0;
      const opcode = first & 0x0f;
      if (first & 0x70) {
        fail("Edge TTS WebSocket protocol error (RSV bits set)");
        return;
      }
      const second = pending[1];
      const masked = (second & 0x80) !== 0;
      const len7 = second & 0x7f;
      let offset = 2;
      let length = len7;
      if (len7 === 126) {
        if (pending.length < 4) return;
        length = pending.readUInt16BE(2);
        offset = 4;
      } else if (len7 === 127) {
        if (pending.length < 10) return;
        const big = pending.readBigUInt64BE(2);
        if (big > BigInt(MAX_WS_FRAME_BYTES)) {
          fail(`Edge TTS WebSocket frame exceeded ${MAX_WS_FRAME_BYTES} bytes`);
          return;
        }
        length = Number(big);
        offset = 10;
      }
      let maskKey = null;
      if (masked) {
        if (pending.length < offset + 4) return;
        maskKey = pending.slice(offset, offset + 4);
        offset += 4;
      }
      if (pending.length < offset + length) return; // wait for more bytes
      let payload = pending.slice(offset, offset + length);
      if (maskKey) {
        // Servers must NOT mask, but survive one that does.
        payload = Buffer.from(payload);
        for (let i = 0; i < payload.length; i++) payload[i] ^= maskKey[i & 3];
      }
      pending = pending.slice(offset + length);

      if (opcode === OP_CONT) {
        if (!fragParts) continue; // stray continuation — ignore
        fragParts.push(payload);
        if (fin) {
          const whole = Buffer.concat(fragParts);
          const wholeOpcode = fragOpcode;
          fragParts = null;
          fragOpcode = 0;
          onFrame(wholeOpcode, whole);
        }
      } else if (opcode === OP_TEXT || opcode === OP_BINARY) {
        if (fin) {
          onFrame(opcode, payload);
        } else {
          fragOpcode = opcode;
          fragParts = [payload];
        }
      } else if (opcode === OP_CLOSE || opcode === OP_PING || opcode === OP_PONG) {
        // Control frames are never fragmented (RFC §5.5).
        onFrame(opcode, payload);
      } else {
        fail(`Edge TTS WebSocket protocol error (unknown opcode 0x${opcode.toString(16)})`);
        return;
      }
      if (pending && pending.length === 0) pending = null;
    }
  };

  return {
    write(chunk) {
      pending = pending ? Buffer.concat([pending, chunk]) : chunk;
      if (pending.length > MAX_WS_FRAME_BYTES + 14) {
        fail(`Edge TTS WebSocket stream exceeded ${MAX_WS_FRAME_BYTES} bytes`);
        return;
      }
      parse();
    },
  };
}

/** Decode one Edge binary message — [uint16 BE header length][ASCII header
 *  \r\n lines][payload] — into { headerText, payload, msgPath }, or null
 *  when malformed. Shared by the live session and the unit tests. */
function decodeBinaryMessage(data) {
  if (!Buffer.isBuffer(data) || data.length < 2) return null;
  const headerLength = data.readUInt16BE(0);
  if (headerLength > data.length - 2) return null;
  const headerText = data.slice(2, 2 + headerLength).toString("utf8");
  const payload = data.slice(2 + headerLength);
  return { headerText, payload, msgPath: headerValue(headerText, "Path") };
}

/** Read a value from a "\r\n"-separated header block (case-insensitive). */
function headerValue(headerText, name) {
  for (const line of headerText.split("\r\n")) {
    const colon = line.indexOf(":");
    if (colon === -1) continue;
    if (line.slice(0, colon).trim().toLowerCase() === name.toLowerCase()) {
      return line.slice(colon + 1).trim();
    }
  }
  return "";
}

// ---------------------------------------------------------------------------
// Synthesis — one TLS socket per attempt, raw WSS, MP3 reassembly
// ---------------------------------------------------------------------------

/** Inspect a Path:response JSON body — the service uses these frames to
 *  surface auth/DRM failures (403-style). Returns null for benign acks. */
function responseFrameError(bodyText) {
  if (!bodyText) return null;
  let payload = null;
  try {
    payload = JSON.parse(bodyText);
  } catch (_) {
    return null; // non-JSON body — benign
  }
  if (!payload || typeof payload !== "object") return null;
  const sources = [payload, payload.data, payload.error].filter(
    (s) => s && typeof s === "object",
  );
  let code = null;
  let reason = "";
  for (const src of sources) {
    if (code === null && typeof src.code === "number") code = src.code;
    if (!reason && typeof src.reason === "string") reason = src.reason;
    if (!reason && typeof src.message === "string") reason = src.message;
    if (!reason && typeof src.text === "string") reason = src.text;
  }
  const blob = `${code === null ? "" : code} ${reason}`.toLowerCase();
  const authish = /40[13]|forbidden|unauthorized|drm|token/.test(blob);
  const errorish =
    authish ||
    (code !== null && code >= 400) ||
    /error/.test(String(payload.type || "").toLowerCase());
  if (!errorish) return null;
  const err = new Error(
    `Edge TTS service error${code !== null ? ` (code ${code})` : ""}` +
      `${reason ? `: ${reason}` : ""}`,
  );
  if (authish) err.retryable = true;
  return err;
}

/** Parse a Path:audio.metadata JSON payload into per-word timing entries.
 *  Frame shape (one entry per spoken word, in arrival order):
 *    {"Metadata":[{"Type":"WordBoundary","Data":{"Offset":1250000,
 *     "Duration":500000,"text":{"Text":"Hello","Length":5,
 *     "BoundaryType":"WordBoundary"}}}]
 *  Offset/Duration are 100-NANOSECOND units (Windows FILETIME ticks) —
 *  1 ms = 10,000 units. Malformed frames are skipped, never fatal: the
 *  audio frames themselves remain the source of truth for the MP3.
 *  @param {Buffer} payload the bytes after the binary header
 *  @param {Array<{text:string, offsetMs:number, durationMs:number}>} out */
function collectWordMetadata(payload, out) {
  let parsed = null;
  try {
    parsed = JSON.parse(payload.toString("utf8"));
  } catch (_) {
    return; // non-JSON metadata — ignore
  }
  const items = parsed && Array.isArray(parsed.Metadata) ? parsed.Metadata : null;
  if (!items) return;
  for (const item of items) {
    if (!item || item.Type !== "WordBoundary" || !item.Data) continue;
    const d = item.Data;
    // Some service revisions flatten the text object ("Text" directly on
    // Data) — accept both shapes.
    const text =
      d.text && typeof d.text.Text === "string"
        ? d.text.Text
        : typeof d.Text === "string"
          ? d.Text
          : null;
    const offsetMs = Math.round(Number(d.Offset) / 10000);
    const durationMs = Math.round(Number(d.Duration) / 10000);
    if (text === null || !Number.isFinite(offsetMs) || !Number.isFinite(durationMs)) {
      continue;
    }
    out.push({ text, offsetMs, durationMs });
  }
}

/** One full synthesis connection: TLS connect → WSS upgrade → speech.config
 *  + SSML → drain frames until Path:turn.end. Sec-MS-GEC and ConnectionId
 *  are regenerated on every call, so a retry is a genuinely fresh session.
 *
 *  @param {{ssml:string, abortRef?:object}} opts
 *  @returns {Promise<{mp3:Buffer, words:Array<{text:string,
 *    offsetMs:number, durationMs:number}>}>} the raw MP3 bytes plus this
 *    attempt's WordBoundary timings (empty when the service sends none).
 */
function attemptSynthesis(opts) {
  return new Promise((resolve, reject) => {
    const connectId = crypto.randomBytes(16).toString("hex");
    const requestId = crypto.randomBytes(16).toString("hex");
    const secGec = generateSecMsgEC();
    const wsKey = crypto.randomBytes(16).toString("base64");

    const upgradePath =
      `${WSS_PATH}?TrustedClientToken=${TRUSTED_CLIENT_TOKEN}` +
      `&Sec-MS-GEC=${secGec}` +
      `&Sec-MS-GEC-Version=${SEC_MS_GEC_VERSION}` +
      `&ConnectionId=${connectId}`;
    // Sec-MS-GEC / Sec-MS-GEC-Version ride BOTH as query params and as HTTP
    // headers — the DRM gate at speech.platform.bing.com checks the header
    // on every request, including the WSS upgrade.
    const handshakeRequest =
      `GET ${upgradePath} HTTP/1.1\r\n` +
      `Host: ${SPEECH_HOST}\r\n` +
      `Upgrade: websocket\r\n` +
      `Connection: Upgrade\r\n` +
      `Sec-WebSocket-Key: ${wsKey}\r\n` +
      `Sec-WebSocket-Version: 13\r\n` +
      `Sec-MS-GEC: ${secGec}\r\n` +
      `Sec-MS-GEC-Version: ${SEC_MS_GEC_VERSION}\r\n` +
      `Origin: ${EXTENSION_ORIGIN}\r\n` +
      `User-Agent: ${EDGE_USER_AGENT}\r\n` +
      `Cache-Control: no-cache\r\n` +
      `Pragma: no-cache\r\n` +
      `\r\n`;

    const speechConfigMessage =
      `X-Timestamp:${jsUtcDateString()}\r\n` +
      `Content-Type:application/json; charset=utf-8\r\n` +
      `Path:speech.config\r\n\r\n` +
      `{"context":{"synthesis":{"audio":{"metadataoptions":` +
      `{"sentenceBoundaryEnabled":"false","wordBoundaryEnabled":"true"},` +
      `"outputFormat":"${OUTPUT_FORMAT}"}}}}\r\n`;

    const ssmlMessage =
      `X-RequestId:${requestId}\r\n` +
      `Content-Type:application/ssml+xml\r\n` +
      `X-Timestamp:${jsUtcDateString()}Z\r\n` +
      `Path:ssml\r\n\r\n` +
      opts.ssml;

    const audioChunks = [];
    let audioBytes = 0;
    // WordBoundary timings for THIS attempt (arrival order). A retry runs a
    // fresh attempt → a fresh array, so words from a failed attempt can
    // never leak into a successful result.
    const words = [];
    let settled = false;
    let handshakeDone = false;
    let closeSent = false;
    let sock = null;
    let handshakeBuffer = Buffer.alloc(0);
    let handshakeTimer = null;
    let overallTimer = null;

    const parser = createWsFrameParser(onFrame, onProtocolError);

    const clearTimers = () => {
      if (handshakeTimer) {
        clearTimeout(handshakeTimer);
        handshakeTimer = null;
      }
      if (overallTimer) {
        clearTimeout(overallTimer);
        overallTimer = null;
      }
    };

    const finish = (err, mp3Bytes) => {
      if (settled) return;
      settled = true;
      clearTimers();
      if (sock) {
        try {
          sock.destroy();
        } catch (_) {
          /* best effort */
        }
      }
      if (err) reject(err);
      else resolve({ mp3: mp3Bytes, words });
    };

    // Cancellation hook — the same { abort: fn } pattern as groq-whisper.
    const hardAbort = () => {
      if (opts.abortRef) opts.abortRef._cancelled = true;
      finish(cancelledError());
    };
    if (opts.abortRef && typeof opts.abortRef === "object") {
      opts.abortRef.abort = hardAbort;
    }

    // Overall watchdog for THIS attempt. The base 25 s covers short
    // utterances (dub lines); longer texts stream proportionally more audio
    // (a 2800-char synthesizeLong chunk is ~235 s of MP3 and takes ~17 s
    // solo, ~3× that when three chunks share the service), so the window
    // scales with the text length — 20 ms per character, measured as ~6 ms
    // per character of wall time for a healthy stream.
    const overallTimeoutMs =
      SYNTH_TIMEOUT_MS + Math.round(opts.text.length * 20);
    overallTimer = setTimeout(() => {
      finish(
        new Error(
          `Edge TTS timed out after ${Math.round(overallTimeoutMs / 1000)}s ` +
            "without finishing the audio stream",
        ),
      );
    }, overallTimeoutMs);

    // Faster watchdog for a stalled upgrade (retryable → one fresh retry).
    handshakeTimer = setTimeout(() => {
      const err = new Error(
        `Edge TTS WebSocket handshake stalled — no 101 within ` +
          `${Math.round(HANDSHAKE_TIMEOUT_MS / 1000)}s`,
      );
      err.retryable = true;
      finish(err);
    }, HANDSHAKE_TIMEOUT_MS);

    function onProtocolError(err) {
      finish(err instanceof Error ? err : new Error(String(err)));
    }

    function sendClientFrame(opcode, payload) {
      if (!sock || sock.destroyed) return;
      try {
        // Each protocol message goes out as ONE buffer (frames are a few KB
        // at most) — Node's internal buffering absorbs any backpressure.
        sock.write(buildWsFrame(opcode, payload));
      } catch (_) {
        // A dead socket surfaces through the error/close handlers.
      }
    }

    function onFrame(opcode, payload) {
      if (settled) return;
      if (opcode === OP_TEXT) {
        handleServerText(payload.toString("utf8"));
      } else if (opcode === OP_BINARY) {
        handleServerBinary(payload);
      } else if (opcode === OP_CLOSE) {
        handleServerClose(payload);
      } else if (opcode === OP_PING) {
        sendClientFrame(OP_PONG, payload); // RFC §5.5.2 — reply promptly
      }
      // Unsolicited pongs — ignore.
    }

    function handleServerText(text) {
      const sep = text.indexOf("\r\n\r\n");
      const headerText = sep === -1 ? text : text.slice(0, sep);
      const bodyText = sep === -1 ? "" : text.slice(sep + 4);
      const msgPath = headerValue(headerText, "Path");
      if (msgPath === "turn.end") {
        if (audioBytes === 0) {
          finish(
            new Error(
              "Edge TTS finished without returning any audio — " +
                "the voice name is probably invalid",
            ),
          );
          return;
        }
        finish(null, Buffer.concat(audioChunks, audioBytes));
        return;
      }
      if (msgPath === "response") {
        const err = responseFrameError(bodyText);
        if (err) finish(err);
        // Benign response acks fall through — ignored.
        return;
      }
      if (msgPath === "audio.metadata") {
        // OBSERVED ON THE LIVE SERVICE: word-boundary metadata arrives as
        // TEXT frames (header\r\n\r\nJSON body), the same layout as
        // turn.start/response — not as binary frames as the old comment
        // assumed. The binary-frame interception in handleServerBinary
        // stays as a belt-and-braces path.
        collectWordMetadata(Buffer.from(bodyText, "utf8"), words);
        return;
      }
      // turn.start / notification / … — not needed here.
    }

    function handleServerBinary(data) {
      const msg = decodeBinaryMessage(data);
      if (!msg) return; // malformed — ignore
      if (msg.msgPath === "audio.metadata") {
        // WordBoundary timing frames — collected, never fatal.
        collectWordMetadata(msg.payload, words);
        return;
      }
      if (msg.msgPath === "audio") {
        if (msg.payload.length > 0) {
          audioChunks.push(msg.payload);
          audioBytes += msg.payload.length;
          if (audioBytes > MAX_AUDIO_BYTES) {
            finish(
              new Error(
                `Edge TTS audio stream exceeded ` +
                  `${Math.round(MAX_AUDIO_BYTES / 1048576)} MB — aborted`,
              ),
            );
          }
        }
        return;
      }
      // Other binary messages (on some server revisions turn.end arrives
      // as a binary frame) share the text-frame layout — reuse it.
      handleServerText(
        msg.headerText +
          (msg.payload.length ? "\r\n\r\n" + msg.payload.toString("utf8") : ""),
      );
    }

    function handleServerClose(payload) {
      if (!closeSent) {
        closeSent = true;
        // Echo the close (masked, ≤125-byte payload) per RFC §5.5.1.
        sendClientFrame(OP_CLOSE, payload.slice(0, 125));
      }
      if (settled) return;
      let code = "";
      if (payload.length >= 2) code = ` (close code ${payload.readUInt16BE(0)})`;
      const reason =
        payload.length > 2 ? payload.slice(2).toString("utf8").trim() : "";
      const err = new Error(
        `Edge TTS server closed the connection before the audio finished` +
          `${code}${reason ? `: ${reason}` : ""}`,
      );
      if (/40[13]|forbidden|unauthorized/i.test(`${code} ${reason}`)) {
        err.retryable = true;
      }
      finish(err);
    }

    function onSocketData(chunk) {
      if (settled) return;
      if (!handshakeDone) {
        // --- HTTP/1.1 upgrade phase: read until the blank line ---
        handshakeBuffer = Buffer.concat([handshakeBuffer, chunk]);
        const sep = handshakeBuffer.indexOf("\r\n\r\n");
        if (sep === -1) {
          if (handshakeBuffer.length > 16384) {
            finish(
              new Error(
                "Edge TTS handshake response exceeded 16 KB — " +
                  "not a WebSocket endpoint",
              ),
            );
          }
          return;
        }
        const responseHead = handshakeBuffer.slice(0, sep).toString("latin1");
        const statusMatch = /^HTTP\/\d\.\d\s+(\d{3})/.exec(responseHead);
        const status = statusMatch ? parseInt(statusMatch[1], 10) : 0;
        if (status !== 101) {
          // (The Sec-WebSocket-Accept value is deliberately not verified —
          // the 101 status line is the meaningful signal for this peer.)
          let err;
          if (status === 401 || status === 403) {
            // 403 is usually a DRM-token window mismatch — learn the server
            // clock from the Date header so the retried token lines up.
            learnClockSkewFromResponseHead(responseHead);
            err = new Error(
              `Edge TTS rejected the DRM token during the WebSocket upgrade ` +
                `(HTTP ${status}) — retrying once with a fresh token`,
            );
            err.retryable = true;
          } else {
            err = new Error(
              `Edge TTS WebSocket upgrade failed (HTTP ` +
                `${status || "unparseable status line"})`,
            );
          }
          finish(err);
          return;
        }
        handshakeDone = true;
        if (handshakeTimer) {
          clearTimeout(handshakeTimer);
          handshakeTimer = null;
        }
        // Session start — both protocol messages as single masked frames.
        sendClientFrame(OP_TEXT, Buffer.from(speechConfigMessage, "utf8"));
        sendClientFrame(OP_TEXT, Buffer.from(ssmlMessage, "utf8"));
        const leftover = handshakeBuffer.slice(sep + 4);
        handshakeBuffer = Buffer.alloc(0);
        if (leftover.length > 0) parser.write(leftover);
        return;
      }
      // --- established WSS phase ---
      parser.write(chunk);
    }

    // v1.32: the TLS connection now goes THROUGH THE SYSTEM PROXY when
    // Chromium reports one (session.resolveProxy — PAC/VPN/AV aware). Node's
    // tls module ignores the OS proxy, which is exactly why synthesis died
    // with "TTS synthesis failed" on proxy-routed machines while everything
    // browser-based kept working. DIRECT → the original direct connection.
    openProxiedTls(SPEECH_HOST, ["http/1.1"])
      .then((tlsSock) => {
        if (settled) {
          try { tlsSock.destroy(); } catch (_) { /* superseded */ }
          return;
        }
        sock = tlsSock;
        sock.on("data", onSocketData);
        sock.on("error", (err) => {
          if (settled) return;
          const msg = new Error(
            `Edge TTS connection error: ${err && err.message ? err.message : err}`,
          );
          if (!handshakeDone) msg.retryable = true; // → one fresh retry
          finish(msg);
        });
        sock.on("close", () => {
          if (settled) return;
          const msg = new Error(
            "Edge TTS connection closed unexpectedly before the audio finished",
          );
          if (!handshakeDone) msg.retryable = true;
          finish(msg);
        });
        try {
          sock.setNoDelay(true);
        } catch (_) {
          /* older TLS stacks */
        }
        sock.write(handshakeRequest);
      })
      .catch((err) => {
        const msg = err instanceof Error ? err : new Error(String(err));
        msg.retryable = true; // connect-phase failure → fresh retry
        finish(msg);
      });
  });
}

// ---------------------------------------------------------------------------
// Engine-slot queue — at most MAX_CONCURRENT_SYNTH sockets at a time; extra
// callers wait in FIFO order (and can cancel while waiting).
// ---------------------------------------------------------------------------

let activeSynthCount = 0;
const synthWaitQueue = []; // { resolve, reject, aborted }

function acquireSlot(abortRef) {
  return new Promise((resolve, reject) => {
    if (activeSynthCount < MAX_CONCURRENT_SYNTH) {
      activeSynthCount += 1;
      resolve();
      return;
    }
    const entry = { resolve, reject, aborted: false };
    synthWaitQueue.push(entry);
    if (abortRef) {
      abortRef.abort = () => {
        if (entry.aborted) return;
        entry.aborted = true;
        abortRef._cancelled = true;
        const idx = synthWaitQueue.indexOf(entry);
        if (idx !== -1) synthWaitQueue.splice(idx, 1);
        reject(cancelledError());
      };
    }
  });
}

function releaseSlot() {
  const next = synthWaitQueue.shift();
  if (next) next.resolve(); // hand the slot straight over (count unchanged)
  else activeSynthCount -= 1;
}

function cancelledError() {
  const err = new Error("Edge TTS synthesis cancelled");
  err.cancelled = true;
  return err;
}

// ---------------------------------------------------------------------------
// Public synthesis entry point
// ---------------------------------------------------------------------------

/** Validate + normalize synthesize() options; throws descriptive errors
 *  (a throw inside the async entry point becomes a rejection).
 *  Out-of-range prosody values are silently clamped to sanity bounds. */
function normalizeSynthOptions(o) {
  if (!o || typeof o !== "object") {
    throw new Error("synthesize: an options object is required ({ text, voice, … })");
  }
  const text = typeof o.text === "string" ? o.text : "";
  if (!text.trim()) {
    throw new Error("synthesize: text is required and must be a non-empty string");
  }
  if (text.length > MAX_TEXT_LEN) {
    throw new Error(
      `synthesize: text is ${text.length} characters — the Edge service caps ` +
        `a request at ${MAX_TEXT_LEN}; split it into sentence chunks and ` +
        `concatenate the MP3s (dub-workflow.js does exactly that)`,
    );
  }
  const voice = typeof o.voice === "string" ? o.voice.trim() : "";
  if (!voice) {
    throw new Error(
      'synthesize: voice is required (e.g. "hi-IN-SwaraNeural" — see listVoices())',
    );
  }
  // Control characters the service chokes on → spaces (see remove… above).
  const cleanText = removeIncompatibleCharacters(text);
  const numberOrZero = (v) =>
    typeof v === "number" && Number.isFinite(v) ? v : 0;
  const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
  const ratePct = clamp(numberOrZero(o.ratePct), RATE_RANGE[0], RATE_RANGE[1]);
  const pitchHz = clamp(numberOrZero(o.pitchHz), PITCH_RANGE[0], PITCH_RANGE[1]);
  const volumePct = clamp(
    numberOrZero(o.volumePct),
    VOLUME_RANGE[0],
    VOLUME_RANGE[1],
  );
  const style = normalizeStyleOption(o.style); // throws on malformed tokens
  const locale = localeFromVoice(voice);
  return {
    text: cleanText,
    voice,
    locale,
    ratePct,
    pitchHz,
    volumePct,
    style,
    ssml: buildSsml({ text: cleanText, voice, locale, ratePct, pitchHz, volumePct, style }),
    outFile:
      typeof o.outFile === "string" && o.outFile.trim() ? o.outFile.trim() : null,
    abortRef:
      o.abortRef && typeof o.abortRef === "object" ? o.abortRef : null,
  };
}

/**
 * Synthesize `text` with an Edge neural voice over the raw-WSS protocol.
 *
 * @param {object} o
 * @param {string} o.text          1…3000 characters (chunk longer scripts).
 * @param {string} o.voice         Short name, e.g. "hi-IN-SwaraNeural"
 *                                 (the full service Name also works).
 * @param {number} [o.ratePct=0]   Rate delta — +10 = 10% faster (SSML rate).
 * @param {number} [o.pitchHz=0]   Pitch delta in Hz (SSML pitch, "+2Hz").
 * @param {number} [o.volumePct=0] Volume delta in % (SSML volume).
 * @param {string} [o.style]       Optional mstts:express-as voice style
 *                                 token (e.g. "cheerful" — must appear in
 *                                 the voice's styleList to have an effect).
 * @param {string} [o.outFile]     Absolute path — the MP3 is written there
 *                                 (parent dirs created) and returned as
 *                                 filePath.
 * @param {{abort:Function}} [o.abortRef]
 *                                 Populated with a cancel function (same
 *                                 pattern as groq-whisper.js groqTranscribe).
 *                                 Callable immediately, even while queued.
 * @returns {Promise<{filePath:string|null, bytes:Buffer, bytesLen:number,
 *          words:Array<{text:string, offsetMs:number, durationMs:number}>}>}
 *          bytes = the raw MP3 (audio-24khz-48kbitrate-mono-mp3);
 *          filePath = outFile when given, else null;
 *          words = per-word timings from the WordBoundary metadata stream.
 */
async function synthesize(o) {
  let opts;
  try {
    opts = normalizeSynthOptions(o); // throws → structured rejection below
  } catch (err) {
    // v1.33 structured input validation (user brief): empty text / missing
    // voice / oversized text are TERMINAL (never retried) and carry the
    // AudioJobError shape.
    const msg = err instanceof Error ? err.message : String(err);
    const code = /non-empty string/.test(msg) ? "TTS_EMPTY_TEXT"
      : /voice is required/.test(msg) ? "TTS_VOICE_REQUIRED"
        : /caps\s+a request at/.test(msg) ? "TTS_TEXT_TOO_LONG" : "TTS_INVALID_INPUT";
    err.job = { service: "edge-tts", code, message: msg, retryable: false };
    throw err;
  }
  // Early-cancel stub so abortRef.abort is always callable, even before the
  // socket exists (or while the request waits for an engine slot).
  if (opts.abortRef) {
    opts.abortRef.abort = () => {
      opts.abortRef._cancelled = true;
    };
  }
  await acquireSlot(opts.abortRef); // rejects if cancelled while queued
  try {
    if (opts.abortRef && opts.abortRef._cancelled) throw cancelledError();
    let mp3Bytes = null;
    let words = null;
    let engineUsed = "raw-client";
    // Call-local: the package engine's captured error (concurrent jobs
    // never see each other's notes — this is a per-call context).
    let packageEngineNote = null;
    // v1.33: set when a voice style was dropped because the service
    // rejected express-as — surfaced via result.warnings, never silent.
    let styleDegraded = null;

    // v1.33 ENGINE DISPATCH (user brief: edge-tts-universal is the primary
    // engine). mstts voice STYLES need the raw client's express-as SSML
    // (the package has no style support) — style requests skip the package.
    // A TRANSIENT package failure (connection/service — the package's own
    // typed errors) falls back to the raw client; terminal package errors
    // (invalid voice, invalid input) surface immediately, and the ORIGINAL
    // package error is captured on the fallback's success path for the log.
    if (!opts.style) {
      try {
        const pkgResult = await synthesizeViaPackage(opts);
        mp3Bytes = pkgResult.mp3;
        words = pkgResult.words;
        engineUsed = "edge-tts-universal";
      } catch (err) {
        if (err && err.cancelled) throw err;
        const transient = !!(err && err.retryable);
        if (!transient) throw err; // invalid voice/input — terminal
        // Transient package failure → the raw engine (v1.32 proxy-tunneled
        // client) takes over below. The ORIGINAL package error is captured
        // (brief requirement: never lose the first failure's cause).
        packageEngineNote = err.message;
        // eslint-disable-next-line no-console
        console.warn(
          `[edge-tts] package engine failed (transient) — falling back to the built-in client: ${err.message}`,
        );
      }
    }

    if (mp3Bytes == null) {
      // v1.32: 3 attempts (was 2). Each attempt regenerates Sec-MS-GEC,
      // ConnectionId AND now re-resolves the system proxy — a flappy VPN or
      // AV proxy gets three genuinely fresh chances.
      // v1.33 STYLE DEGRADATION: the speech service has DROPPED the
      // mstts:express-as element (close 1007 "SSML is invalid" — live-verified
      // 2026-10 with both namespace forms). Since no app surface sends styles
      // (the TTS Studio presets are pure prosody), a style request that the
      // service rejects degrades to the STYLELESS SSML once — never silently:
      // the result carries a warnings entry the UI can show.
      let styleStripped = null;
      for (let attempt = 1; attempt <= 3; attempt++) {
        try {
          const attemptResult = await attemptSynthesis(opts);
          mp3Bytes = attemptResult.mp3;
          words = attemptResult.words;
          engineUsed = packageEngineNote
            ? "raw-client (after package engine failure)"
            : "raw-client";
          if (styleStripped) styleDegraded = styleStripped;
          break;
        } catch (err) {
          if (
            opts.style &&
            /ssml is invalid/i.test(String((err && err.message) || ""))
          ) {
            styleStripped = opts.style;
            opts.style = null; // degrade once, warn in the result
            // The SSML is PRE-BUILT in normalizeSynthOptions — rebuilding it
            // is what actually drops the express-as element.
            opts.ssml = buildSsml({
              text: opts.text,
              voice: opts.voice,
              locale: opts.locale,
              ratePct: opts.ratePct,
              pitchHz: opts.pitchHz,
              volumePct: opts.volumePct,
              style: null,
            });
            continue;
          }
          const cancelled =
            (err && err.cancelled) ||
            (opts.abortRef && opts.abortRef._cancelled);
          const retryable = !!(err && err.retryable);
          if (cancelled || !retryable || attempt === 3) {
            if (!cancelled && err instanceof Error) {
              // v1.32: exhausted retryable failures get the actionable hints —
              // the three real-world causes are a region block on the
              // speech endpoint, a proxy/VPN/AV interception, or a badly
              // wrong system clock (the DRM token is time-based).
              err.message =
                `${err.message} — after ${attempt} attempt${attempt === 1 ? "" : "s"}. ` +
                  "If this keeps failing: (1) toggle your VPN/proxy or disable antivirus HTTPS-scanning for this app, " +
                  "(2) check your system clock is correct (the speech DRM token is time-based), " +
                  "(3) try another network — Microsoft's speech endpoint is blocked in some regions";
              err.job = err.job || {
                service: "edge-tts",
                code: "TTS_SERVICE_ERROR",
                message: err.message,
                retryable: false,
              };
            }
            throw err;
          }
          // 403-ish failure / handshake stall / connect error — fresh retry.
          // The retry regenerates Sec-MS-GEC + ConnectionId inside
          // attemptSynthesis and re-resolves the proxy inside openProxiedTls.
        }
      }
    }

    // v1.33 OUTPUT VALIDATION (user brief): NEVER report success until the
    // audio is real — nonzero size AND a valid MP3 signature (ID3 tag or
    // MPEG frame sync). Applies to BOTH engines.
    if (!mp3Bytes || !Buffer.isBuffer(mp3Bytes) || mp3Bytes.length < 100) {
      const e = new Error(
        `TTS produced ${mp3Bytes ? mp3Bytes.length : 0} bytes — too small to be audio (engine: ${engineUsed})`,
      );
      e.job = {
        service: "edge-tts",
        code: "TTS_AUDIO_TOO_SMALL",
        message: e.message,
        retryable: false,
      };
      throw e;
    }
    if (!isMp3Buffer(mp3Bytes)) {
      const e = new Error(
        `TTS output is not recognized as MP3 (no ID3 tag or MPEG frame sync; engine: ${engineUsed}) — the speech service returned an unexpected payload`,
      );
      e.job = {
        service: "edge-tts",
        code: "TTS_OUTPUT_NOT_RECOGNIZED_AS_MP3",
        message: e.message,
        retryable: false,
      };
      throw e;
    }

    const result = {
      filePath: null,
      bytes: mp3Bytes,
      bytesLen: mp3Bytes.length,
      words: words || [],
      engine: engineUsed,
      warnings: styleDegraded
        ? [
            `The speech service no longer accepts voice styles — "${styleDegraded}" was ignored and the audio was synthesized with the default delivery.`,
          ]
        : [],
    };
    if (opts.outFile) {
      // v1.33 ATOMIC WRITE (user brief): a unique temporary file per job,
      // fsync, THEN rename — a half-written destination can never be
      // mistaken for a finished one, and concurrent jobs cannot collide.
      const dir = path.dirname(opts.outFile);
      const temporary = `${opts.outFile}.${process.pid}-${Date.now()}-${crypto
        .randomBytes(4)
        .toString("hex")}.tmp`;
      try {
        fs.mkdirSync(dir, { recursive: true });
        const fd = fs.openSync(temporary, "w");
        try {
          fs.writeSync(fd, mp3Bytes);
          fs.fsyncSync(fd);
        } finally {
          fs.closeSync(fd);
        }
        fs.renameSync(temporary, opts.outFile);
        result.filePath = opts.outFile;
      } catch (err) {
        try { fs.unlinkSync(temporary); } catch (_) { /* never existed */ }
        const e = new Error(
          `Could not write the TTS output file "${opts.outFile}": ${err.message}`,
        );
        e.job = {
          service: "edge-tts",
          code: "TTS_WRITE_FAILED",
          message: e.message,
          retryable: false,
        };
        throw e;
      }
    }
    return result;
  } finally {
    releaseSlot();
  }
}

// ---------------------------------------------------------------------------
// Long-form synthesis — sentence chunking, 3-way parallel, single MP3
// ---------------------------------------------------------------------------

/** Sentence terminators for long-text chunking — Latin .!?… + newline +
 *  Devanagari danda (।) + Urdu/Arabic question mark (؟): the dubbing flow
 *  feeds Hindi/Marathi/Urdu scripts, so the Latin set alone is not enough. */
const SENTENCE_END_RE = /[.!\u2026\u0964\u061F!?\n]/;
const WHITESPACE_RE = /\s/;

/** Split a long script into synthesis-sized chunks (each ≤ maxLen chars).
 *  Cut preference inside each window: (1) the LAST sentence terminator
 *  (Latin .!?…, newline, ।, ؟); (2) the LAST whitespace (a single sentence
 *  longer than the window); (3) a hard cut (a single unbroken token longer
 *  than the window). Only the CHUNK EDGES are trimmed — the text itself is
 *  never re-normalized, so joining the chunks reproduces the input minus
 *  the whitespace at the cut points.
 *  @param {string} text
 *  @param {number} maxLen
 *  @returns {string[]} non-empty chunks whose lengths are ≤ maxLen */
function splitTextIntoChunks(text, maxLen) {
  const trimmed = String(text).trim();
  if (!trimmed) return [];
  if (trimmed.length <= maxLen) return [trimmed];
  const chunks = [];
  let start = 0;
  while (start < trimmed.length) {
    const remaining = trimmed.length - start;
    if (remaining <= maxLen) {
      const last = trimmed.slice(start).trim();
      if (last) chunks.push(last);
      break;
    }
    const window = trimmed.slice(start, start + maxLen);
    let cut = -1;
    for (let i = window.length - 1; i > 0; i--) {
      if (SENTENCE_END_RE.test(window[i])) {
        cut = i + 1;
        break;
      }
    }
    if (cut === -1) {
      for (let i = window.length - 1; i > 0; i--) {
        if (WHITESPACE_RE.test(window[i])) {
          cut = i + 1;
          break;
        }
      }
    }
    if (cut === -1) cut = window.length; // one unbroken token — hard cut
    const piece = window.slice(0, cut).trim();
    if (piece) chunks.push(piece);
    start += cut;
    while (start < trimmed.length && WHITESPACE_RE.test(trimmed[start])) {
      start += 1; // the next chunk starts at its first non-space character
    }
  }
  return chunks;
}

/** Bytes-per-second of the negotiated output format — 48 kbps CBR MP3 ⇒
 *  exactly 6000 bytes/s, so byteCount / 6000 = seconds with frame-level
 *  accuracy (the format has no VBR drift; main.js uses the same math as
 *  its ffprobe fallback). */
const CBR_BYTES_PER_SECOND = 6000;

/**
 * Synthesize a LONG script (up to MAX_LONG_TEXT_LEN ≈ 200 k words) as ONE
 * logical utterance: the text is split into ≤ LONG_CHUNK_LEN sentence
 * chunks, every chunk goes through the normal synthesize() pipeline (the
 * engine-slot queue keeps MAX_CONCURRENT_SYNTH in flight and queues the
 * rest FIFO), and the per-chunk MP3s are concatenated — MP3 frame streams
 * concatenate losslessly, exactly like the intra-call audio frames do.
 *
 * Word timings are rebased to GLOBAL offsets: chunk i starts at the sum of
 * the durations of chunks 0…i-1, where each chunk's duration comes from its
 * byte count (48 kbps CBR ⇒ bytesLen/6000 seconds — see
 * CBR_BYTES_PER_SECOND).
 *
 * @param {object} o
 * @param {string} o.text          1…1.5 M characters.
 * @param {string} o.voice         Short name, e.g. "en-US-AriaNeural".
 * @param {number} [o.ratePct=0]   Rate delta — +10 = 10% faster (SSML rate).
 * @param {number} [o.pitchHz=0]   Pitch delta in Hz (SSML pitch, "+2Hz").
 * @param {number} [o.volumePct=0] Volume delta in % (SSML volume).
 * @param {string} [o.style]       Optional mstts:express-as style token.
 * @param {(p:{phase:"synth", chunkIndex:number, chunkCount:number,
 *             charsDone:number, totalChars:number})=>void} [o.onProgress]
 *                                 Fired after each chunk completes.
 * @param {{abort:Function}} [o.abortRef]
 *                                 Populated with ONE cancel function that
 *                                 aborts EVERY chunk (in flight and queued
 *                                 — dub-workflow's childAbortRef pattern);
 *                                 on abort the promise rejects with an
 *                                 Error whose .cancelled is true.
 * @returns {Promise<{bytes:Buffer, bytesLen:number,
 *          words:Array<{text:string, offsetMs:number, durationMs:number}>,
 *          chunkCount:number}>} the merged MP3 (chunk order, NOT completion
 *          order) + word timings with global offsets, sorted by offset.
 */
async function synthesizeLong(o) {
  if (!o || typeof o !== "object") {
    throw new Error(
      "synthesizeLong: an options object is required ({ text, voice, … })",
    );
  }
  const text = typeof o.text === "string" ? o.text : "";
  if (!text.trim()) {
    throw new Error(
      "synthesizeLong: text is required and must be a non-empty string",
    );
  }
  if (text.length > MAX_LONG_TEXT_LEN) {
    throw new Error(
      `synthesizeLong: text is ${text.length} characters — the cap is ` +
        `${MAX_LONG_TEXT_LEN} (~200,000 words); split the project into passes`,
    );
  }
  const voice = typeof o.voice === "string" ? o.voice.trim() : "";
  if (!voice) {
    throw new Error(
      'synthesizeLong: voice is required (e.g. "en-US-AriaNeural" — see listVoices())',
    );
  }
  const style = normalizeStyleOption(o.style); // throws on malformed tokens
  const numberOrZero = (v) =>
    typeof v === "number" && Number.isFinite(v) ? v : 0;
  // Prosody clamps happen per chunk inside normalizeSynthOptions — the
  // values here only need to be finite numbers.
  const ratePct = numberOrZero(o.ratePct);
  const pitchHz = numberOrZero(o.pitchHz);
  const volumePct = numberOrZero(o.volumePct);
  const onProgress =
    typeof o.onProgress === "function" ? o.onProgress : null;
  const chunks = splitTextIntoChunks(text, LONG_CHUNK_LEN);

  // Cancellation: ONE caller-facing { abort } fans out to a per-chunk
  // abortRef (each is re-pointed by synthesize()/acquireSlot()/
  // attemptSynthesis() as that chunk moves queued → active, so abort()
  // always reaches the live stage).
  const chunkRefs = chunks.map(() => ({ abort: null }));
  const cancelAll = () => {
    for (const ref of chunkRefs) {
      try {
        if (typeof ref.abort === "function") ref.abort();
      } catch (_) {
        /* best effort */
      }
    }
  };
  if (o.abortRef && typeof o.abortRef === "object") {
    o.abortRef.abort = cancelAll;
  }

  // Fire ALL chunk syntheses up front — the engine-slot queue serializes
  // at MAX_CONCURRENT_SYNTH live sockets and hands out the rest FIFO.
  // Results land at their INDEX, so parallel completion can never reorder
  // the merged audio; charsDone is only ever mutated from the JS thread
  // (single-threaded), so plain accumulation is race-free.
  const results = new Array(chunks.length).fill(null);
  const failures = [];
  let charsDone = 0;
  await Promise.all(
    chunks.map((chunkText, i) =>
      (async () => {
        try {
          results[i] = await synthesize({
            text: chunkText,
            voice,
            ratePct,
            pitchHz,
            volumePct,
            style: style || undefined,
            abortRef: chunkRefs[i],
          });
        } catch (err) {
          failures.push(err);
          // One chunk dying kills the whole run — cancel the siblings (in
          // flight AND still queued) instead of burning their sockets.
          cancelAll();
          return;
        }
        charsDone += chunkText.length;
        if (onProgress) {
          try {
            onProgress({
              phase: "synth",
              chunkIndex: i,
              chunkCount: chunks.length,
              charsDone,
              totalChars: text.length,
            });
          } catch (_) {
            /* listener errors must not kill the run */
          }
        }
      })(),
    ),
  );
  if (failures.length > 0) {
    // A genuine chunk error wins over the sibling cancellations it caused;
    // pure caller-cancels surface as the module's standard cancelled error.
    const real = failures.find((err) => !(err && err.cancelled));
    throw real || cancelledError();
  }

  // ---- merge: chunk ORDER (not completion order) defines the timeline ----
  const bytesParts = [];
  let bytesLen = 0;
  const words = [];
  let chunkStartMs = 0;
  for (let i = 0; i < chunks.length; i++) {
    const r = results[i];
    bytesParts.push(r.bytes);
    bytesLen += r.bytesLen;
    // 48 kbps CBR MP3 ⇒ 6000 B/s: byte count IS the chunk duration.
    const chunkDurMs = (r.bytesLen / CBR_BYTES_PER_SECOND) * 1000;
    for (const w of r.words || []) {
      words.push({
        text: w.text,
        offsetMs: Math.round(chunkStartMs + w.offsetMs),
        durationMs: w.durationMs,
      });
    }
    chunkStartMs += chunkDurMs;
  }
  words.sort((a, b) => a.offsetMs - b.offsetMs);
  const bytes = Buffer.concat(bytesParts, bytesLen);
  return { bytes, bytesLen, words, chunkCount: chunks.length };
}

module.exports = {
  // Public API — consumed by dub-workflow.js and the voiceover UI.
  listVoices, // () => Promise<Array<{shortName, gender, locale, friendlyName, displayName}>>
  voicePairsByLocale, // () => Object<string, {female, male}> (SYNC plain map)
  synthesize, // (o) => Promise<{filePath, bytes, bytesLen, words}>
  synthesizeLong, // (o) => Promise<{bytes, bytesLen, words, chunkCount}>
  splitTextIntoChunks, // (text, maxLen) => string[] (long-text chunking)
  FALLBACK_VOICES, // built-in catalog (used automatically when offline)
  // Constants surfaced for callers / tests.
  SPEECH_HOST,
  TRUSTED_CLIENT_TOKEN,
  SEC_MS_GEC_VERSION,
  EDGE_USER_AGENT,
  EDGE_TTS_MAX_TEXT: MAX_TEXT_LEN,
  MAX_CONCURRENT_SYNTH,
  OUTPUT_FORMAT,
  // Internals (unit tests / diagnostics).
  generateSecMsgEC,
  escapeXml,
  localeFromVoice,
  buildSsml,
  buildWsFrame,
  createWsFrameParser,
  decodeBinaryMessage, // (Buffer) => {headerText, payload, msgPath}|null
  collectWordMetadata, // (payload, out[]) => void (WordBoundary parsing)
};
