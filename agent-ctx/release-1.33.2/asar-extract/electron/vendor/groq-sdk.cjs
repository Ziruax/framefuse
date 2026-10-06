"use strict";
var __commonJS = (cb, mod) => () => (mod || cb((mod = { exports: {} }).exports, mod), mod.exports);

// node_modules/groq-sdk/internal/tslib.js
var require_tslib = __commonJS((exports2) => {
  Object.defineProperty(exports2, "__esModule", { value: true });
  exports2.__setModuleDefault = exports2.__createBinding = undefined;
  exports2.__classPrivateFieldSet = __classPrivateFieldSet;
  exports2.__classPrivateFieldGet = __classPrivateFieldGet;
  exports2.__importStar = __importStar;
  exports2.__exportStar = __exportStar;
  function __classPrivateFieldSet(receiver, state, value, kind, f) {
    if (kind === "m")
      throw new TypeError("Private method is not writable");
    if (kind === "a" && !f)
      throw new TypeError("Private accessor was defined without a setter");
    if (typeof state === "function" ? receiver !== state || !f : !state.has(receiver))
      throw new TypeError("Cannot write private member to an object whose class did not declare it");
    return kind === "a" ? f.call(receiver, value) : f ? f.value = value : state.set(receiver, value), value;
  }
  function __classPrivateFieldGet(receiver, state, kind, f) {
    if (kind === "a" && !f)
      throw new TypeError("Private accessor was defined without a getter");
    if (typeof state === "function" ? receiver !== state || !f : !state.has(receiver))
      throw new TypeError("Cannot read private member from an object whose class did not declare it");
    return kind === "m" ? f : kind === "a" ? f.call(receiver) : f ? f.value : state.get(receiver);
  }
  var __createBinding = Object.create ? function(o, m, k, k2) {
    if (k2 === undefined)
      k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = {
        enumerable: true,
        get: function() {
          return m[k];
        }
      };
    }
    Object.defineProperty(o, k2, desc);
  } : function(o, m, k, k2) {
    if (k2 === undefined)
      k2 = k;
    o[k2] = m[k];
  };
  exports2.__createBinding = __createBinding;
  var __setModuleDefault = Object.create ? function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
  } : function(o, v) {
    o["default"] = v;
  };
  exports2.__setModuleDefault = __setModuleDefault;
  var ownKeys = function(o) {
    ownKeys = Object.getOwnPropertyNames || function(o2) {
      var ar = [];
      for (var k in o2)
        if (Object.prototype.hasOwnProperty.call(o2, k))
          ar[ar.length] = k;
      return ar;
    };
    return ownKeys(o);
  };
  function __importStar(mod) {
    if (mod && mod.__esModule)
      return mod;
    var result = {};
    if (mod != null) {
      for (var k = ownKeys(mod), i = 0;i < k.length; i++)
        if (k[i] !== "default")
          __createBinding(result, mod, k[i]);
    }
    __setModuleDefault(result, mod);
    return result;
  }
  function __exportStar(m, o) {
    for (var p in m)
      if (p !== "default" && !Object.prototype.hasOwnProperty.call(o, p))
        __createBinding(o, m, p);
  }
});

// node_modules/groq-sdk/internal/utils/uuid.js
var require_uuid = __commonJS((exports2) => {
  Object.defineProperty(exports2, "__esModule", { value: true });
  exports2.uuid4 = undefined;
  var uuid4 = function() {
    const { crypto } = globalThis;
    if (crypto?.randomUUID) {
      exports2.uuid4 = crypto.randomUUID.bind(crypto);
      return crypto.randomUUID();
    }
    const u8 = new Uint8Array(1);
    const randomByte = crypto ? () => crypto.getRandomValues(u8)[0] : () => Math.random() * 255 & 255;
    return "10000000-1000-4000-8000-100000000000".replace(/[018]/g, (c) => (+c ^ randomByte() & 15 >> +c / 4).toString(16));
  };
  exports2.uuid4 = uuid4;
});

// node_modules/groq-sdk/internal/errors.js
var require_errors = __commonJS((exports2) => {
  Object.defineProperty(exports2, "__esModule", { value: true });
  exports2.castToError = undefined;
  exports2.isAbortError = isAbortError;
  function isAbortError(err) {
    return typeof err === "object" && err !== null && (("name" in err) && err.name === "AbortError" || ("message" in err) && String(err.message).includes("FetchRequestCanceledException"));
  }
  var castToError = (err) => {
    if (err instanceof Error)
      return err;
    if (typeof err === "object" && err !== null) {
      try {
        if (Object.prototype.toString.call(err) === "[object Error]") {
          const error = new Error(err.message, err.cause ? { cause: err.cause } : {});
          if (err.stack)
            error.stack = err.stack;
          if (err.cause && !error.cause)
            error.cause = err.cause;
          if (err.name)
            error.name = err.name;
          return error;
        }
      } catch {}
      try {
        return new Error(JSON.stringify(err));
      } catch {}
    }
    return new Error(err);
  };
  exports2.castToError = castToError;
});

// node_modules/groq-sdk/core/error.js
var require_error = __commonJS((exports2) => {
  Object.defineProperty(exports2, "__esModule", { value: true });
  exports2.InternalServerError = exports2.RateLimitError = exports2.UnprocessableEntityError = exports2.ConflictError = exports2.NotFoundError = exports2.PermissionDeniedError = exports2.AuthenticationError = exports2.BadRequestError = exports2.APIConnectionTimeoutError = exports2.APIConnectionError = exports2.APIUserAbortError = exports2.APIError = exports2.GroqError = undefined;
  var errors_1 = require_errors();

  class GroqError extends Error {
  }
  exports2.GroqError = GroqError;

  class APIError extends GroqError {
    constructor(status, error, message, headers) {
      super(`${APIError.makeMessage(status, error, message)}`);
      this.status = status;
      this.headers = headers;
      this.error = error;
    }
    static makeMessage(status, error, message) {
      const msg = error?.message ? typeof error.message === "string" ? error.message : JSON.stringify(error.message) : error ? JSON.stringify(error) : message;
      if (status && msg) {
        return `${status} ${msg}`;
      }
      if (status) {
        return `${status} status code (no body)`;
      }
      if (msg) {
        return msg;
      }
      return "(no status code or body)";
    }
    static generate(status, errorResponse, message, headers) {
      if (!status || !headers) {
        return new APIConnectionError({ message, cause: (0, errors_1.castToError)(errorResponse) });
      }
      const error = errorResponse;
      if (status === 400) {
        return new BadRequestError(status, error, message, headers);
      }
      if (status === 401) {
        return new AuthenticationError(status, error, message, headers);
      }
      if (status === 403) {
        return new PermissionDeniedError(status, error, message, headers);
      }
      if (status === 404) {
        return new NotFoundError(status, error, message, headers);
      }
      if (status === 409) {
        return new ConflictError(status, error, message, headers);
      }
      if (status === 422) {
        return new UnprocessableEntityError(status, error, message, headers);
      }
      if (status === 429) {
        return new RateLimitError(status, error, message, headers);
      }
      if (status >= 500) {
        return new InternalServerError(status, error, message, headers);
      }
      return new APIError(status, error, message, headers);
    }
  }
  exports2.APIError = APIError;

  class APIUserAbortError extends APIError {
    constructor({ message } = {}) {
      super(undefined, undefined, message || "Request was aborted.", undefined);
    }
  }
  exports2.APIUserAbortError = APIUserAbortError;

  class APIConnectionError extends APIError {
    constructor({ message, cause }) {
      super(undefined, undefined, message || "Connection error.", undefined);
      if (cause)
        this.cause = cause;
    }
  }
  exports2.APIConnectionError = APIConnectionError;

  class APIConnectionTimeoutError extends APIConnectionError {
    constructor({ message } = {}) {
      super({ message: message ?? "Request timed out." });
    }
  }
  exports2.APIConnectionTimeoutError = APIConnectionTimeoutError;

  class BadRequestError extends APIError {
  }
  exports2.BadRequestError = BadRequestError;

  class AuthenticationError extends APIError {
  }
  exports2.AuthenticationError = AuthenticationError;

  class PermissionDeniedError extends APIError {
  }
  exports2.PermissionDeniedError = PermissionDeniedError;

  class NotFoundError extends APIError {
  }
  exports2.NotFoundError = NotFoundError;

  class ConflictError extends APIError {
  }
  exports2.ConflictError = ConflictError;

  class UnprocessableEntityError extends APIError {
  }
  exports2.UnprocessableEntityError = UnprocessableEntityError;

  class RateLimitError extends APIError {
  }
  exports2.RateLimitError = RateLimitError;

  class InternalServerError extends APIError {
  }
  exports2.InternalServerError = InternalServerError;
});

// node_modules/groq-sdk/internal/utils/values.js
var require_values = __commonJS((exports2) => {
  Object.defineProperty(exports2, "__esModule", { value: true });
  exports2.safeJSON = exports2.maybeCoerceBoolean = exports2.maybeCoerceFloat = exports2.maybeCoerceInteger = exports2.coerceBoolean = exports2.coerceFloat = exports2.coerceInteger = exports2.validatePositiveInteger = exports2.ensurePresent = exports2.isReadonlyArray = exports2.isArray = exports2.isAbsoluteURL = undefined;
  exports2.maybeObj = maybeObj;
  exports2.isEmptyObj = isEmptyObj;
  exports2.hasOwn = hasOwn;
  exports2.isObj = isObj;
  var error_1 = require_error();
  var startsWithSchemeRegexp = /^[a-z][a-z0-9+.-]*:/i;
  var isAbsoluteURL = (url) => {
    return startsWithSchemeRegexp.test(url);
  };
  exports2.isAbsoluteURL = isAbsoluteURL;
  var isArray = (val) => (exports2.isArray = Array.isArray, (0, exports2.isArray)(val));
  exports2.isArray = isArray;
  exports2.isReadonlyArray = exports2.isArray;
  function maybeObj(x) {
    if (typeof x !== "object") {
      return {};
    }
    return x ?? {};
  }
  function isEmptyObj(obj) {
    if (!obj)
      return true;
    for (const _k in obj)
      return false;
    return true;
  }
  function hasOwn(obj, key) {
    return Object.prototype.hasOwnProperty.call(obj, key);
  }
  function isObj(obj) {
    return obj != null && typeof obj === "object" && !Array.isArray(obj);
  }
  var ensurePresent = (value) => {
    if (value == null) {
      throw new error_1.GroqError(`Expected a value to be given but received ${value} instead.`);
    }
    return value;
  };
  exports2.ensurePresent = ensurePresent;
  var validatePositiveInteger = (name, n) => {
    if (typeof n !== "number" || !Number.isInteger(n)) {
      throw new error_1.GroqError(`${name} must be an integer`);
    }
    if (n < 0) {
      throw new error_1.GroqError(`${name} must be a positive integer`);
    }
    return n;
  };
  exports2.validatePositiveInteger = validatePositiveInteger;
  var coerceInteger = (value) => {
    if (typeof value === "number")
      return Math.round(value);
    if (typeof value === "string")
      return parseInt(value, 10);
    throw new error_1.GroqError(`Could not coerce ${value} (type: ${typeof value}) into a number`);
  };
  exports2.coerceInteger = coerceInteger;
  var coerceFloat = (value) => {
    if (typeof value === "number")
      return value;
    if (typeof value === "string")
      return parseFloat(value);
    throw new error_1.GroqError(`Could not coerce ${value} (type: ${typeof value}) into a number`);
  };
  exports2.coerceFloat = coerceFloat;
  var coerceBoolean = (value) => {
    if (typeof value === "boolean")
      return value;
    if (typeof value === "string")
      return value === "true";
    return Boolean(value);
  };
  exports2.coerceBoolean = coerceBoolean;
  var maybeCoerceInteger = (value) => {
    if (value == null) {
      return;
    }
    return (0, exports2.coerceInteger)(value);
  };
  exports2.maybeCoerceInteger = maybeCoerceInteger;
  var maybeCoerceFloat = (value) => {
    if (value == null) {
      return;
    }
    return (0, exports2.coerceFloat)(value);
  };
  exports2.maybeCoerceFloat = maybeCoerceFloat;
  var maybeCoerceBoolean = (value) => {
    if (value == null) {
      return;
    }
    return (0, exports2.coerceBoolean)(value);
  };
  exports2.maybeCoerceBoolean = maybeCoerceBoolean;
  var safeJSON = (text) => {
    try {
      return JSON.parse(text);
    } catch (err) {
      return;
    }
  };
  exports2.safeJSON = safeJSON;
});

// node_modules/groq-sdk/internal/utils/sleep.js
var require_sleep = __commonJS((exports2) => {
  Object.defineProperty(exports2, "__esModule", { value: true });
  exports2.sleep = undefined;
  var sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  exports2.sleep = sleep;
});

// node_modules/groq-sdk/version.js
var require_version = __commonJS((exports2) => {
  Object.defineProperty(exports2, "__esModule", { value: true });
  exports2.VERSION = undefined;
  exports2.VERSION = "1.6.0";
});

// node_modules/groq-sdk/internal/detect-platform.js
var require_detect_platform = __commonJS((exports2) => {
  Object.defineProperty(exports2, "__esModule", { value: true });
  exports2.getPlatformHeaders = exports2.isRunningInBrowser = undefined;
  var version_1 = require_version();
  var isRunningInBrowser = () => {
    return typeof window !== "undefined" && typeof window.document !== "undefined" && typeof navigator !== "undefined";
  };
  exports2.isRunningInBrowser = isRunningInBrowser;
  function getDetectedPlatform() {
    if (typeof Deno !== "undefined" && Deno.build != null) {
      return "deno";
    }
    if (typeof EdgeRuntime !== "undefined") {
      return "edge";
    }
    if (Object.prototype.toString.call(typeof globalThis.process !== "undefined" ? globalThis.process : 0) === "[object process]") {
      return "node";
    }
    return "unknown";
  }
  var getPlatformProperties = () => {
    const detectedPlatform = getDetectedPlatform();
    if (detectedPlatform === "deno") {
      return {
        "X-Stainless-Lang": "js",
        "X-Stainless-Package-Version": version_1.VERSION,
        "X-Stainless-OS": normalizePlatform(Deno.build.os),
        "X-Stainless-Arch": normalizeArch(Deno.build.arch),
        "X-Stainless-Runtime": "deno",
        "X-Stainless-Runtime-Version": typeof Deno.version === "string" ? Deno.version : Deno.version?.deno ?? "unknown"
      };
    }
    if (typeof EdgeRuntime !== "undefined") {
      return {
        "X-Stainless-Lang": "js",
        "X-Stainless-Package-Version": version_1.VERSION,
        "X-Stainless-OS": "Unknown",
        "X-Stainless-Arch": `other:${EdgeRuntime}`,
        "X-Stainless-Runtime": "edge",
        "X-Stainless-Runtime-Version": globalThis.process.version
      };
    }
    if (detectedPlatform === "node") {
      return {
        "X-Stainless-Lang": "js",
        "X-Stainless-Package-Version": version_1.VERSION,
        "X-Stainless-OS": normalizePlatform(globalThis.process.platform ?? "unknown"),
        "X-Stainless-Arch": normalizeArch(globalThis.process.arch ?? "unknown"),
        "X-Stainless-Runtime": "node",
        "X-Stainless-Runtime-Version": globalThis.process.version ?? "unknown"
      };
    }
    const browserInfo = getBrowserInfo();
    if (browserInfo) {
      return {
        "X-Stainless-Lang": "js",
        "X-Stainless-Package-Version": version_1.VERSION,
        "X-Stainless-OS": "Unknown",
        "X-Stainless-Arch": "unknown",
        "X-Stainless-Runtime": `browser:${browserInfo.browser}`,
        "X-Stainless-Runtime-Version": browserInfo.version
      };
    }
    return {
      "X-Stainless-Lang": "js",
      "X-Stainless-Package-Version": version_1.VERSION,
      "X-Stainless-OS": "Unknown",
      "X-Stainless-Arch": "unknown",
      "X-Stainless-Runtime": "unknown",
      "X-Stainless-Runtime-Version": "unknown"
    };
  };
  function getBrowserInfo() {
    if (typeof navigator === "undefined" || !navigator) {
      return null;
    }
    const browserPatterns = [
      { key: "edge", pattern: /Edge(?:\W+(\d+)\.(\d+)(?:\.(\d+))?)?/ },
      { key: "ie", pattern: /MSIE(?:\W+(\d+)\.(\d+)(?:\.(\d+))?)?/ },
      { key: "ie", pattern: /Trident(?:.*rv\:(\d+)\.(\d+)(?:\.(\d+))?)?/ },
      { key: "chrome", pattern: /Chrome(?:\W+(\d+)\.(\d+)(?:\.(\d+))?)?/ },
      { key: "firefox", pattern: /Firefox(?:\W+(\d+)\.(\d+)(?:\.(\d+))?)?/ },
      { key: "safari", pattern: /(?:Version\W+(\d+)\.(\d+)(?:\.(\d+))?)?(?:\W+Mobile\S*)?\W+Safari/ }
    ];
    for (const { key, pattern } of browserPatterns) {
      const match = pattern.exec(navigator.userAgent);
      if (match) {
        const major = match[1] || 0;
        const minor = match[2] || 0;
        const patch = match[3] || 0;
        return { browser: key, version: `${major}.${minor}.${patch}` };
      }
    }
    return null;
  }
  var normalizeArch = (arch) => {
    if (arch === "x32")
      return "x32";
    if (arch === "x86_64" || arch === "x64")
      return "x64";
    if (arch === "arm")
      return "arm";
    if (arch === "aarch64" || arch === "arm64")
      return "arm64";
    if (arch)
      return `other:${arch}`;
    return "unknown";
  };
  var normalizePlatform = (platform) => {
    platform = platform.toLowerCase();
    if (platform.includes("ios"))
      return "iOS";
    if (platform === "android")
      return "Android";
    if (platform === "darwin")
      return "MacOS";
    if (platform === "win32")
      return "Windows";
    if (platform === "freebsd")
      return "FreeBSD";
    if (platform === "openbsd")
      return "OpenBSD";
    if (platform === "linux")
      return "Linux";
    if (platform)
      return `Other:${platform}`;
    return "Unknown";
  };
  var _platformHeaders;
  var getPlatformHeaders = () => {
    return _platformHeaders ?? (_platformHeaders = getPlatformProperties());
  };
  exports2.getPlatformHeaders = getPlatformHeaders;
});

// node_modules/groq-sdk/internal/shims.js
var require_shims = __commonJS((exports2) => {
  Object.defineProperty(exports2, "__esModule", { value: true });
  exports2.getDefaultFetch = getDefaultFetch;
  exports2.makeReadableStream = makeReadableStream;
  exports2.ReadableStreamFrom = ReadableStreamFrom;
  exports2.ReadableStreamToAsyncIterable = ReadableStreamToAsyncIterable;
  exports2.CancelReadableStream = CancelReadableStream;
  function getDefaultFetch() {
    if (typeof fetch !== "undefined") {
      return fetch;
    }
    throw new Error("`fetch` is not defined as a global; Either pass `fetch` to the client, `new Groq({ fetch })` or polyfill the global, `globalThis.fetch = fetch`");
  }
  function makeReadableStream(...args) {
    const ReadableStream = globalThis.ReadableStream;
    if (typeof ReadableStream === "undefined") {
      throw new Error("`ReadableStream` is not defined as a global; You will need to polyfill it, `globalThis.ReadableStream = ReadableStream`");
    }
    return new ReadableStream(...args);
  }
  function ReadableStreamFrom(iterable) {
    let iter = Symbol.asyncIterator in iterable ? iterable[Symbol.asyncIterator]() : iterable[Symbol.iterator]();
    return makeReadableStream({
      start() {},
      async pull(controller) {
        const { done, value } = await iter.next();
        if (done) {
          controller.close();
        } else {
          controller.enqueue(value);
        }
      },
      async cancel() {
        await iter.return?.();
      }
    });
  }
  function ReadableStreamToAsyncIterable(stream) {
    if (stream[Symbol.asyncIterator])
      return stream;
    const reader = stream.getReader();
    return {
      async next() {
        try {
          const result = await reader.read();
          if (result?.done)
            reader.releaseLock();
          return result;
        } catch (e) {
          reader.releaseLock();
          throw e;
        }
      },
      async return() {
        const cancelPromise = reader.cancel();
        reader.releaseLock();
        await cancelPromise;
        return { done: true, value: undefined };
      },
      [Symbol.asyncIterator]() {
        return this;
      }
    };
  }
  async function CancelReadableStream(stream) {
    if (stream === null || typeof stream !== "object")
      return;
    if (stream[Symbol.asyncIterator]) {
      await stream[Symbol.asyncIterator]().return?.();
      return;
    }
    const reader = stream.getReader();
    const cancelPromise = reader.cancel();
    reader.releaseLock();
    await cancelPromise;
  }
});

// node_modules/groq-sdk/internal/request-options.js
var require_request_options = __commonJS((exports2) => {
  Object.defineProperty(exports2, "__esModule", { value: true });
  exports2.FallbackEncoder = undefined;
  var FallbackEncoder = ({ headers, body }) => {
    return {
      bodyHeaders: {
        "content-type": "application/json"
      },
      body: JSON.stringify(body)
    };
  };
  exports2.FallbackEncoder = FallbackEncoder;
});

// node_modules/groq-sdk/internal/utils/query.js
var require_query = __commonJS((exports2) => {
  Object.defineProperty(exports2, "__esModule", { value: true });
  exports2.stringifyQuery = stringifyQuery;
  var error_1 = require_error();
  function stringifyQuery(query) {
    return Object.entries(query).filter(([_, value]) => typeof value !== "undefined").map(([key, value]) => {
      if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
        return `${encodeURIComponent(key)}=${encodeURIComponent(value)}`;
      }
      if (value === null) {
        return `${encodeURIComponent(key)}=`;
      }
      throw new error_1.GroqError(`Cannot stringify type ${typeof value}; Expected string, number, boolean, or null. If you need to pass nested query parameters, you can manually encode them, e.g. { query: { 'foo[key1]': value1, 'foo[key2]': value2 } }, and please open a GitHub issue requesting better support for your use case.`);
    }).join("&");
  }
});

// node_modules/groq-sdk/internal/uploads.js
var require_uploads = __commonJS((exports2) => {
  Object.defineProperty(exports2, "__esModule", { value: true });
  exports2.createForm = exports2.multipartFormRequestOptions = exports2.maybeMultipartFormRequestOptions = exports2.isAsyncIterable = exports2.checkFileSupport = undefined;
  exports2.makeFile = makeFile;
  exports2.getName = getName;
  var shims_1 = require_shims();
  var checkFileSupport = () => {
    if (typeof File === "undefined") {
      const { process } = globalThis;
      const isOldNode = typeof process?.versions?.node === "string" && parseInt(process.versions.node.split(".")) < 20;
      throw new Error("`File` is not defined as a global, which is required for file uploads." + (isOldNode ? " Update to Node 20 LTS or newer, or set `globalThis.File` to `import('node:buffer').File`." : ""));
    }
  };
  exports2.checkFileSupport = checkFileSupport;
  function makeFile(fileBits, fileName, options) {
    (0, exports2.checkFileSupport)();
    return new File(fileBits, fileName ?? "unknown_file", options);
  }
  function getName(value) {
    return (typeof value === "object" && value !== null && (("name" in value) && value.name && String(value.name) || ("url" in value) && value.url && String(value.url) || ("filename" in value) && value.filename && String(value.filename) || ("path" in value) && value.path && String(value.path)) || "").split(/[\\/]/).pop() || undefined;
  }
  var isAsyncIterable = (value) => value != null && typeof value === "object" && typeof value[Symbol.asyncIterator] === "function";
  exports2.isAsyncIterable = isAsyncIterable;
  var maybeMultipartFormRequestOptions = async (opts, fetch2) => {
    if (!hasUploadableValue(opts.body))
      return opts;
    return { ...opts, body: await (0, exports2.createForm)(opts.body, fetch2) };
  };
  exports2.maybeMultipartFormRequestOptions = maybeMultipartFormRequestOptions;
  var multipartFormRequestOptions = async (opts, fetch2) => {
    return { ...opts, body: await (0, exports2.createForm)(opts.body, fetch2) };
  };
  exports2.multipartFormRequestOptions = multipartFormRequestOptions;
  var supportsFormDataMap = /* @__PURE__ */ new WeakMap;
  function supportsFormData(fetchObject) {
    const fetch2 = typeof fetchObject === "function" ? fetchObject : fetchObject.fetch;
    const cached = supportsFormDataMap.get(fetch2);
    if (cached)
      return cached;
    const promise = (async () => {
      try {
        const FetchResponse = "Response" in fetch2 ? fetch2.Response : (await fetch2("data:,")).constructor;
        const data = new FormData;
        if (data.toString() === await new FetchResponse(data).text()) {
          return false;
        }
        return true;
      } catch {
        return true;
      }
    })();
    supportsFormDataMap.set(fetch2, promise);
    return promise;
  }
  var createForm = async (body, fetch2) => {
    if (!await supportsFormData(fetch2)) {
      throw new TypeError("The provided fetch function does not support file uploads with the current global FormData class.");
    }
    const form = new FormData;
    await Promise.all(Object.entries(body || {}).map(([key, value]) => addFormValue(form, key, value)));
    return form;
  };
  exports2.createForm = createForm;
  var isNamedBlob = (value) => value instanceof Blob && ("name" in value);
  var isUploadable = (value) => typeof value === "object" && value !== null && (value instanceof Response || (0, exports2.isAsyncIterable)(value) || isNamedBlob(value));
  var hasUploadableValue = (value) => {
    if (isUploadable(value))
      return true;
    if (Array.isArray(value))
      return value.some(hasUploadableValue);
    if (value && typeof value === "object") {
      for (const k in value) {
        if (hasUploadableValue(value[k]))
          return true;
      }
    }
    return false;
  };
  var addFormValue = async (form, key, value) => {
    if (value === undefined)
      return;
    if (value == null) {
      throw new TypeError(`Received null for "${key}"; to pass null in FormData, you must use the string 'null'`);
    }
    if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
      form.append(key, String(value));
    } else if (value instanceof Response) {
      form.append(key, makeFile([await value.blob()], getName(value)));
    } else if ((0, exports2.isAsyncIterable)(value)) {
      form.append(key, makeFile([await new Response((0, shims_1.ReadableStreamFrom)(value)).blob()], getName(value)));
    } else if (isNamedBlob(value)) {
      form.append(key, value, getName(value));
    } else if (Array.isArray(value)) {
      await Promise.all(value.map((entry) => addFormValue(form, key + "[]", entry)));
    } else if (typeof value === "object") {
      await Promise.all(Object.entries(value).map(([name, prop]) => addFormValue(form, `${key}[${name}]`, prop)));
    } else {
      throw new TypeError(`Invalid value given to form, expected a string, number, boolean, object, Array, File or Blob but got ${value} instead`);
    }
  };
});

// node_modules/groq-sdk/internal/to-file.js
var require_to_file = __commonJS((exports2) => {
  Object.defineProperty(exports2, "__esModule", { value: true });
  exports2.toFile = toFile;
  var uploads_1 = require_uploads();
  var uploads_2 = require_uploads();
  var isBlobLike = (value) => value != null && typeof value === "object" && typeof value.size === "number" && typeof value.type === "string" && typeof value.text === "function" && typeof value.slice === "function" && typeof value.arrayBuffer === "function";
  var isFileLike = (value) => value != null && typeof value === "object" && typeof value.name === "string" && typeof value.lastModified === "number" && isBlobLike(value);
  var isResponseLike = (value) => value != null && typeof value === "object" && typeof value.url === "string" && typeof value.blob === "function";
  async function toFile(value, name, options) {
    (0, uploads_2.checkFileSupport)();
    value = await value;
    if (isFileLike(value)) {
      if (value instanceof File) {
        return value;
      }
      return (0, uploads_1.makeFile)([await value.arrayBuffer()], value.name);
    }
    if (isResponseLike(value)) {
      const blob = await value.blob();
      name || (name = new URL(value.url).pathname.split(/[\\/]/).pop());
      return (0, uploads_1.makeFile)(await getBytes(blob), name, options);
    }
    const parts = await getBytes(value);
    name || (name = (0, uploads_1.getName)(value));
    if (!options?.type) {
      const type = parts.find((part) => typeof part === "object" && ("type" in part) && part.type);
      if (typeof type === "string") {
        options = { ...options, type };
      }
    }
    return (0, uploads_1.makeFile)(parts, name, options);
  }
  async function getBytes(value) {
    let parts = [];
    if (typeof value === "string" || ArrayBuffer.isView(value) || value instanceof ArrayBuffer) {
      parts.push(value);
    } else if (isBlobLike(value)) {
      parts.push(value instanceof Blob ? value : await value.arrayBuffer());
    } else if ((0, uploads_1.isAsyncIterable)(value)) {
      for await (const chunk of value) {
        parts.push(...await getBytes(chunk));
      }
    } else {
      const constructor = value?.constructor?.name;
      throw new Error(`Unexpected data type: ${typeof value}${constructor ? `; constructor: ${constructor}` : ""}${propsForError(value)}`);
    }
    return parts;
  }
  function propsForError(value) {
    if (typeof value !== "object" || value === null)
      return "";
    const props = Object.getOwnPropertyNames(value);
    return `; props: [${props.map((p) => `"${p}"`).join(", ")}]`;
  }
});

// node_modules/groq-sdk/core/uploads.js
var require_uploads2 = __commonJS((exports2) => {
  Object.defineProperty(exports2, "__esModule", { value: true });
  exports2.toFile = undefined;
  var to_file_1 = require_to_file();
  Object.defineProperty(exports2, "toFile", { enumerable: true, get: function() {
    return to_file_1.toFile;
  } });
});

// node_modules/groq-sdk/resources/shared.js
var require_shared = __commonJS((exports2) => {
  Object.defineProperty(exports2, "__esModule", { value: true });
});

// node_modules/groq-sdk/core/resource.js
var require_resource = __commonJS((exports2) => {
  Object.defineProperty(exports2, "__esModule", { value: true });
  exports2.APIResource = undefined;

  class APIResource {
    constructor(client) {
      this._client = client;
    }
  }
  exports2.APIResource = APIResource;
});

// node_modules/groq-sdk/internal/headers.js
var require_headers = __commonJS((exports2) => {
  Object.defineProperty(exports2, "__esModule", { value: true });
  exports2.isEmptyHeaders = exports2.buildHeaders = undefined;
  var values_1 = require_values();
  var brand_privateNullableHeaders = /* @__PURE__ */ Symbol("brand.privateNullableHeaders");
  function* iterateHeaders(headers) {
    if (!headers)
      return;
    if (brand_privateNullableHeaders in headers) {
      const { values, nulls } = headers;
      yield* values.entries();
      for (const name of nulls) {
        yield [name, null];
      }
      return;
    }
    let shouldClear = false;
    let iter;
    if (headers instanceof Headers) {
      iter = headers.entries();
    } else if ((0, values_1.isReadonlyArray)(headers)) {
      iter = headers;
    } else {
      shouldClear = true;
      iter = Object.entries(headers ?? {});
    }
    for (let row of iter) {
      const name = row[0];
      if (typeof name !== "string")
        throw new TypeError("expected header name to be a string");
      const values = (0, values_1.isReadonlyArray)(row[1]) ? row[1] : [row[1]];
      let didClear = false;
      for (const value of values) {
        if (value === undefined)
          continue;
        if (shouldClear && !didClear) {
          didClear = true;
          yield [name, null];
        }
        yield [name, value];
      }
    }
  }
  var buildHeaders = (newHeaders) => {
    const targetHeaders = new Headers;
    const nullHeaders = new Set;
    for (const headers of newHeaders) {
      const seenHeaders = new Set;
      for (const [name, value] of iterateHeaders(headers)) {
        const lowerName = name.toLowerCase();
        if (!seenHeaders.has(lowerName)) {
          targetHeaders.delete(name);
          seenHeaders.add(lowerName);
        }
        if (value === null) {
          targetHeaders.delete(name);
          nullHeaders.add(lowerName);
        } else {
          targetHeaders.append(name, value);
          nullHeaders.delete(lowerName);
        }
      }
    }
    return { [brand_privateNullableHeaders]: true, values: targetHeaders, nulls: nullHeaders };
  };
  exports2.buildHeaders = buildHeaders;
  var isEmptyHeaders = (headers) => {
    for (const _ of iterateHeaders(headers))
      return false;
    return true;
  };
  exports2.isEmptyHeaders = isEmptyHeaders;
});

// node_modules/groq-sdk/resources/audio/speech.js
var require_speech = __commonJS((exports2) => {
  Object.defineProperty(exports2, "__esModule", { value: true });
  exports2.Speech = undefined;
  var resource_1 = require_resource();
  var headers_1 = require_headers();

  class Speech extends resource_1.APIResource {
    create(body, options) {
      return this._client.post("/openai/v1/audio/speech", {
        body,
        ...options,
        headers: (0, headers_1.buildHeaders)([{ Accept: "audio/wav" }, options?.headers]),
        __binaryResponse: true
      });
    }
  }
  exports2.Speech = Speech;
});

// node_modules/groq-sdk/resources/audio/transcriptions.js
var require_transcriptions = __commonJS((exports2) => {
  Object.defineProperty(exports2, "__esModule", { value: true });
  exports2.Transcriptions = undefined;
  var resource_1 = require_resource();
  var uploads_1 = require_uploads();

  class Transcriptions extends resource_1.APIResource {
    create(body, options) {
      return this._client.post("/openai/v1/audio/transcriptions", (0, uploads_1.multipartFormRequestOptions)({ body, ...options }, this._client));
    }
  }
  exports2.Transcriptions = Transcriptions;
});

// node_modules/groq-sdk/resources/audio/translations.js
var require_translations = __commonJS((exports2) => {
  Object.defineProperty(exports2, "__esModule", { value: true });
  exports2.Translations = undefined;
  var resource_1 = require_resource();
  var uploads_1 = require_uploads();

  class Translations extends resource_1.APIResource {
    create(body, options) {
      return this._client.post("/openai/v1/audio/translations", (0, uploads_1.multipartFormRequestOptions)({ body, ...options }, this._client));
    }
  }
  exports2.Translations = Translations;
});

// node_modules/groq-sdk/resources/audio/audio.js
var require_audio = __commonJS((exports2) => {
  Object.defineProperty(exports2, "__esModule", { value: true });
  exports2.Audio = undefined;
  var tslib_1 = require_tslib();
  var resource_1 = require_resource();
  var SpeechAPI = tslib_1.__importStar(require_speech());
  var speech_1 = require_speech();
  var TranscriptionsAPI = tslib_1.__importStar(require_transcriptions());
  var transcriptions_1 = require_transcriptions();
  var TranslationsAPI = tslib_1.__importStar(require_translations());
  var translations_1 = require_translations();

  class Audio extends resource_1.APIResource {
    constructor() {
      super(...arguments);
      this.speech = new SpeechAPI.Speech(this._client);
      this.transcriptions = new TranscriptionsAPI.Transcriptions(this._client);
      this.translations = new TranslationsAPI.Translations(this._client);
    }
  }
  exports2.Audio = Audio;
  Audio.Speech = speech_1.Speech;
  Audio.Transcriptions = transcriptions_1.Transcriptions;
  Audio.Translations = translations_1.Translations;
});

// node_modules/groq-sdk/internal/utils/path.js
var require_path = __commonJS((exports2) => {
  Object.defineProperty(exports2, "__esModule", { value: true });
  exports2.path = exports2.createPathTagFunction = undefined;
  exports2.encodeURIPath = encodeURIPath;
  var error_1 = require_error();
  function encodeURIPath(str) {
    return str.replace(/[^A-Za-z0-9\-._~!$&'()*+,;=:@]+/g, encodeURIComponent);
  }
  var EMPTY = /* @__PURE__ */ Object.freeze(/* @__PURE__ */ Object.create(null));
  var createPathTagFunction = (pathEncoder = encodeURIPath) => function path(statics, ...params) {
    if (statics.length === 1)
      return statics[0];
    let postPath = false;
    const invalidSegments = [];
    const path2 = statics.reduce((previousValue, currentValue, index) => {
      if (/[?#]/.test(currentValue)) {
        postPath = true;
      }
      const value = params[index];
      let encoded = (postPath ? encodeURIComponent : pathEncoder)("" + value);
      if (index !== params.length && (value == null || typeof value === "object" && value.toString === Object.getPrototypeOf(Object.getPrototypeOf(value.hasOwnProperty ?? EMPTY) ?? EMPTY)?.toString)) {
        encoded = value + "";
        invalidSegments.push({
          start: previousValue.length + currentValue.length,
          length: encoded.length,
          error: `Value of type ${Object.prototype.toString.call(value).slice(8, -1)} is not a valid path parameter`
        });
      }
      return previousValue + currentValue + (index === params.length ? "" : encoded);
    }, "");
    const pathOnly = path2.split(/[?#]/, 1)[0];
    const invalidSegmentPattern = /(?<=^|\/)(?:\.|%2e){1,2}(?=\/|$)/gi;
    let match;
    while ((match = invalidSegmentPattern.exec(pathOnly)) !== null) {
      invalidSegments.push({
        start: match.index,
        length: match[0].length,
        error: `Value "${match[0]}" can't be safely passed as a path parameter`
      });
    }
    invalidSegments.sort((a, b) => a.start - b.start);
    if (invalidSegments.length > 0) {
      let lastEnd = 0;
      const underline = invalidSegments.reduce((acc, segment) => {
        const spaces = " ".repeat(segment.start - lastEnd);
        const arrows = "^".repeat(segment.length);
        lastEnd = segment.start + segment.length;
        return acc + spaces + arrows;
      }, "");
      throw new error_1.GroqError(`Path parameters result in path with invalid segments:
${invalidSegments.map((e) => e.error).join(`
`)}
${path2}
${underline}`);
    }
    return path2;
  };
  exports2.createPathTagFunction = createPathTagFunction;
  exports2.path = (0, exports2.createPathTagFunction)(encodeURIPath);
});

// node_modules/groq-sdk/resources/batches.js
var require_batches = __commonJS((exports2) => {
  Object.defineProperty(exports2, "__esModule", { value: true });
  exports2.Batches = undefined;
  var resource_1 = require_resource();
  var path_1 = require_path();

  class Batches extends resource_1.APIResource {
    create(body, options) {
      return this._client.post("/openai/v1/batches", { body, ...options });
    }
    retrieve(batchID, options) {
      return this._client.get((0, path_1.path)`/openai/v1/batches/${batchID}`, options);
    }
    list(options) {
      return this._client.get("/openai/v1/batches", options);
    }
    cancel(batchID, options) {
      return this._client.post((0, path_1.path)`/openai/v1/batches/${batchID}/cancel`, options);
    }
  }
  exports2.Batches = Batches;
});

// node_modules/groq-sdk/resources/chat/completions.js
var require_completions = __commonJS((exports2) => {
  Object.defineProperty(exports2, "__esModule", { value: true });
  exports2.Completions = undefined;
  var resource_1 = require_resource();

  class Completions extends resource_1.APIResource {
    create(body, options) {
      return this._client.post("/openai/v1/chat/completions", {
        body,
        ...options,
        stream: body.stream ?? false
      });
    }
  }
  exports2.Completions = Completions;
});

// node_modules/groq-sdk/resources/chat/chat.js
var require_chat = __commonJS((exports2) => {
  Object.defineProperty(exports2, "__esModule", { value: true });
  exports2.Chat = undefined;
  var tslib_1 = require_tslib();
  var resource_1 = require_resource();
  var CompletionsAPI = tslib_1.__importStar(require_completions());
  var completions_1 = require_completions();

  class Chat extends resource_1.APIResource {
    constructor() {
      super(...arguments);
      this.completions = new CompletionsAPI.Completions(this._client);
    }
  }
  exports2.Chat = Chat;
  Chat.Completions = completions_1.Completions;
});

// node_modules/groq-sdk/resources/completions.js
var require_completions2 = __commonJS((exports2) => {
  Object.defineProperty(exports2, "__esModule", { value: true });
  exports2.Completions = undefined;
  var resource_1 = require_resource();

  class Completions extends resource_1.APIResource {
  }
  exports2.Completions = Completions;
});

// node_modules/groq-sdk/resources/embeddings.js
var require_embeddings = __commonJS((exports2) => {
  Object.defineProperty(exports2, "__esModule", { value: true });
  exports2.Embeddings = undefined;
  var resource_1 = require_resource();

  class Embeddings extends resource_1.APIResource {
    create(body, options) {
      return this._client.post("/openai/v1/embeddings", { body, ...options });
    }
  }
  exports2.Embeddings = Embeddings;
});

// node_modules/groq-sdk/resources/files.js
var require_files = __commonJS((exports2) => {
  Object.defineProperty(exports2, "__esModule", { value: true });
  exports2.Files = undefined;
  var resource_1 = require_resource();
  var headers_1 = require_headers();
  var uploads_1 = require_uploads();
  var path_1 = require_path();

  class Files extends resource_1.APIResource {
    create(body, options) {
      return this._client.post("/openai/v1/files", (0, uploads_1.multipartFormRequestOptions)({ body, ...options }, this._client));
    }
    list(options) {
      return this._client.get("/openai/v1/files", options);
    }
    delete(fileID, options) {
      return this._client.delete((0, path_1.path)`/openai/v1/files/${fileID}`, options);
    }
    content(fileID, options) {
      return this._client.get((0, path_1.path)`/openai/v1/files/${fileID}/content`, {
        ...options,
        headers: (0, headers_1.buildHeaders)([{ Accept: "application/octet-stream" }, options?.headers]),
        __binaryResponse: true
      });
    }
    info(fileID, options) {
      return this._client.get((0, path_1.path)`/openai/v1/files/${fileID}`, options);
    }
  }
  exports2.Files = Files;
});

// node_modules/groq-sdk/resources/models.js
var require_models = __commonJS((exports2) => {
  Object.defineProperty(exports2, "__esModule", { value: true });
  exports2.Models = undefined;
  var resource_1 = require_resource();
  var path_1 = require_path();

  class Models extends resource_1.APIResource {
    retrieve(model, options) {
      return this._client.get((0, path_1.path)`/openai/v1/models/${model}`, options);
    }
    list(options) {
      return this._client.get("/openai/v1/models", options);
    }
    delete(model, options) {
      return this._client.delete((0, path_1.path)`/openai/v1/models/${model}`, options);
    }
  }
  exports2.Models = Models;
});

// node_modules/groq-sdk/resources/index.js
var require_resources = __commonJS((exports2) => {
  Object.defineProperty(exports2, "__esModule", { value: true });
  exports2.Models = exports2.Files = exports2.Embeddings = exports2.Completions = exports2.Chat = exports2.Batches = exports2.Audio = undefined;
  var tslib_1 = require_tslib();
  tslib_1.__exportStar(require_shared(), exports2);
  var audio_1 = require_audio();
  Object.defineProperty(exports2, "Audio", { enumerable: true, get: function() {
    return audio_1.Audio;
  } });
  var batches_1 = require_batches();
  Object.defineProperty(exports2, "Batches", { enumerable: true, get: function() {
    return batches_1.Batches;
  } });
  var chat_1 = require_chat();
  Object.defineProperty(exports2, "Chat", { enumerable: true, get: function() {
    return chat_1.Chat;
  } });
  var completions_1 = require_completions2();
  Object.defineProperty(exports2, "Completions", { enumerable: true, get: function() {
    return completions_1.Completions;
  } });
  var embeddings_1 = require_embeddings();
  Object.defineProperty(exports2, "Embeddings", { enumerable: true, get: function() {
    return embeddings_1.Embeddings;
  } });
  var files_1 = require_files();
  Object.defineProperty(exports2, "Files", { enumerable: true, get: function() {
    return files_1.Files;
  } });
  var models_1 = require_models();
  Object.defineProperty(exports2, "Models", { enumerable: true, get: function() {
    return models_1.Models;
  } });
});

// node_modules/groq-sdk/internal/utils/bytes.js
var require_bytes = __commonJS((exports2) => {
  Object.defineProperty(exports2, "__esModule", { value: true });
  exports2.concatBytes = concatBytes;
  exports2.encodeUTF8 = encodeUTF8;
  exports2.decodeUTF8 = decodeUTF8;
  function concatBytes(buffers) {
    let length = 0;
    for (const buffer of buffers) {
      length += buffer.length;
    }
    const output = new Uint8Array(length);
    let index = 0;
    for (const buffer of buffers) {
      output.set(buffer, index);
      index += buffer.length;
    }
    return output;
  }
  var encodeUTF8_;
  function encodeUTF8(str) {
    let encoder;
    return (encodeUTF8_ ?? (encoder = new globalThis.TextEncoder, encodeUTF8_ = encoder.encode.bind(encoder)))(str);
  }
  var decodeUTF8_;
  function decodeUTF8(bytes) {
    let decoder;
    return (decodeUTF8_ ?? (decoder = new globalThis.TextDecoder, decodeUTF8_ = decoder.decode.bind(decoder)))(bytes);
  }
});

// node_modules/groq-sdk/internal/decoders/line.js
var require_line = __commonJS((exports2) => {
  var _LineDecoder_buffer;
  var _LineDecoder_carriageReturnIndex;
  Object.defineProperty(exports2, "__esModule", { value: true });
  exports2.LineDecoder = undefined;
  exports2.findDoubleNewlineIndex = findDoubleNewlineIndex;
  var tslib_1 = require_tslib();
  var bytes_1 = require_bytes();

  class LineDecoder {
    constructor() {
      _LineDecoder_buffer.set(this, undefined);
      _LineDecoder_carriageReturnIndex.set(this, undefined);
      tslib_1.__classPrivateFieldSet(this, _LineDecoder_buffer, new Uint8Array, "f");
      tslib_1.__classPrivateFieldSet(this, _LineDecoder_carriageReturnIndex, null, "f");
    }
    decode(chunk) {
      if (chunk == null) {
        return [];
      }
      const binaryChunk = chunk instanceof ArrayBuffer ? new Uint8Array(chunk) : typeof chunk === "string" ? (0, bytes_1.encodeUTF8)(chunk) : chunk;
      tslib_1.__classPrivateFieldSet(this, _LineDecoder_buffer, (0, bytes_1.concatBytes)([tslib_1.__classPrivateFieldGet(this, _LineDecoder_buffer, "f"), binaryChunk]), "f");
      const lines = [];
      let patternIndex;
      while ((patternIndex = findNewlineIndex(tslib_1.__classPrivateFieldGet(this, _LineDecoder_buffer, "f"), tslib_1.__classPrivateFieldGet(this, _LineDecoder_carriageReturnIndex, "f"))) != null) {
        if (patternIndex.carriage && tslib_1.__classPrivateFieldGet(this, _LineDecoder_carriageReturnIndex, "f") == null) {
          tslib_1.__classPrivateFieldSet(this, _LineDecoder_carriageReturnIndex, patternIndex.index, "f");
          continue;
        }
        if (tslib_1.__classPrivateFieldGet(this, _LineDecoder_carriageReturnIndex, "f") != null && (patternIndex.index !== tslib_1.__classPrivateFieldGet(this, _LineDecoder_carriageReturnIndex, "f") + 1 || patternIndex.carriage)) {
          lines.push((0, bytes_1.decodeUTF8)(tslib_1.__classPrivateFieldGet(this, _LineDecoder_buffer, "f").subarray(0, tslib_1.__classPrivateFieldGet(this, _LineDecoder_carriageReturnIndex, "f") - 1)));
          tslib_1.__classPrivateFieldSet(this, _LineDecoder_buffer, tslib_1.__classPrivateFieldGet(this, _LineDecoder_buffer, "f").subarray(tslib_1.__classPrivateFieldGet(this, _LineDecoder_carriageReturnIndex, "f")), "f");
          tslib_1.__classPrivateFieldSet(this, _LineDecoder_carriageReturnIndex, null, "f");
          continue;
        }
        const endIndex = tslib_1.__classPrivateFieldGet(this, _LineDecoder_carriageReturnIndex, "f") !== null ? patternIndex.preceding - 1 : patternIndex.preceding;
        const line = (0, bytes_1.decodeUTF8)(tslib_1.__classPrivateFieldGet(this, _LineDecoder_buffer, "f").subarray(0, endIndex));
        lines.push(line);
        tslib_1.__classPrivateFieldSet(this, _LineDecoder_buffer, tslib_1.__classPrivateFieldGet(this, _LineDecoder_buffer, "f").subarray(patternIndex.index), "f");
        tslib_1.__classPrivateFieldSet(this, _LineDecoder_carriageReturnIndex, null, "f");
      }
      return lines;
    }
    flush() {
      if (!tslib_1.__classPrivateFieldGet(this, _LineDecoder_buffer, "f").length) {
        return [];
      }
      return this.decode(`
`);
    }
  }
  exports2.LineDecoder = LineDecoder;
  _LineDecoder_buffer = new WeakMap, _LineDecoder_carriageReturnIndex = new WeakMap;
  LineDecoder.NEWLINE_CHARS = new Set([`
`, "\r"]);
  LineDecoder.NEWLINE_REGEXP = /\r\n|[\n\r]/g;
  function findNewlineIndex(buffer, startIndex) {
    const newline = 10;
    const carriage = 13;
    for (let i = startIndex ?? 0;i < buffer.length; i++) {
      if (buffer[i] === newline) {
        return { preceding: i, index: i + 1, carriage: false };
      }
      if (buffer[i] === carriage) {
        return { preceding: i, index: i + 1, carriage: true };
      }
    }
    return null;
  }
  function findDoubleNewlineIndex(buffer) {
    const newline = 10;
    const carriage = 13;
    for (let i = 0;i < buffer.length - 1; i++) {
      if (buffer[i] === newline && buffer[i + 1] === newline) {
        return i + 2;
      }
      if (buffer[i] === carriage && buffer[i + 1] === carriage) {
        return i + 2;
      }
      if (buffer[i] === carriage && buffer[i + 1] === newline && i + 3 < buffer.length && buffer[i + 2] === carriage && buffer[i + 3] === newline) {
        return i + 4;
      }
    }
    return -1;
  }
});

// node_modules/groq-sdk/internal/utils/log.js
var require_log = __commonJS((exports2) => {
  Object.defineProperty(exports2, "__esModule", { value: true });
  exports2.formatRequestDetails = exports2.parseLogLevel = undefined;
  exports2.loggerFor = loggerFor;
  var values_1 = require_values();
  var levelNumbers = {
    off: 0,
    error: 200,
    warn: 300,
    info: 400,
    debug: 500
  };
  var parseLogLevel = (maybeLevel, sourceName, client) => {
    if (!maybeLevel) {
      return;
    }
    if ((0, values_1.hasOwn)(levelNumbers, maybeLevel)) {
      return maybeLevel;
    }
    loggerFor(client).warn(`${sourceName} was set to ${JSON.stringify(maybeLevel)}, expected one of ${JSON.stringify(Object.keys(levelNumbers))}`);
    return;
  };
  exports2.parseLogLevel = parseLogLevel;
  function noop() {}
  function makeLogFn(fnLevel, logger, logLevel) {
    if (!logger || levelNumbers[fnLevel] > levelNumbers[logLevel]) {
      return noop;
    } else {
      return logger[fnLevel].bind(logger);
    }
  }
  var noopLogger = {
    error: noop,
    warn: noop,
    info: noop,
    debug: noop
  };
  var cachedLoggers = /* @__PURE__ */ new WeakMap;
  function loggerFor(client) {
    const logger = client.logger;
    const logLevel = client.logLevel ?? "off";
    if (!logger) {
      return noopLogger;
    }
    const cachedLogger = cachedLoggers.get(logger);
    if (cachedLogger && cachedLogger[0] === logLevel) {
      return cachedLogger[1];
    }
    const levelLogger = {
      error: makeLogFn("error", logger, logLevel),
      warn: makeLogFn("warn", logger, logLevel),
      info: makeLogFn("info", logger, logLevel),
      debug: makeLogFn("debug", logger, logLevel)
    };
    cachedLoggers.set(logger, [logLevel, levelLogger]);
    return levelLogger;
  }
  var formatRequestDetails = (details) => {
    if (details.options) {
      details.options = { ...details.options };
      delete details.options["headers"];
    }
    if (details.headers) {
      details.headers = Object.fromEntries((details.headers instanceof Headers ? [...details.headers] : Object.entries(details.headers)).map(([name, value]) => [
        name,
        name.toLowerCase() === "authorization" || name.toLowerCase() === "api-key" || name.toLowerCase() === "x-api-key" || name.toLowerCase() === "cookie" || name.toLowerCase() === "set-cookie" ? "***" : value
      ]));
    }
    if ("retryOfRequestLogID" in details) {
      if (details.retryOfRequestLogID) {
        details.retryOf = details.retryOfRequestLogID;
      }
      delete details.retryOfRequestLogID;
    }
    return details;
  };
  exports2.formatRequestDetails = formatRequestDetails;
});

// node_modules/groq-sdk/core/streaming.js
var require_streaming = __commonJS((exports2) => {
  var _Stream_client;
  Object.defineProperty(exports2, "__esModule", { value: true });
  exports2.Stream = undefined;
  exports2._iterSSEMessages = _iterSSEMessages;
  var tslib_1 = require_tslib();
  var error_1 = require_error();
  var shims_1 = require_shims();
  var line_1 = require_line();
  var shims_2 = require_shims();
  var errors_1 = require_errors();
  var bytes_1 = require_bytes();
  var log_1 = require_log();
  var error_2 = require_error();

  class Stream {
    constructor(iterator, controller, client) {
      this.iterator = iterator;
      _Stream_client.set(this, undefined);
      this.controller = controller;
      tslib_1.__classPrivateFieldSet(this, _Stream_client, client, "f");
    }
    static fromSSEResponse(response, controller, client) {
      let consumed = false;
      const logger = client ? (0, log_1.loggerFor)(client) : console;
      async function* iterator() {
        if (consumed) {
          throw new error_1.GroqError("Cannot iterate over a consumed stream, use `.tee()` to split the stream.");
        }
        consumed = true;
        let done = false;
        try {
          for await (const sse of _iterSSEMessages(response, controller)) {
            if (done)
              continue;
            if (sse.data.startsWith("[DONE]")) {
              done = true;
              continue;
            }
            if (sse.event === null || !sse.event.startsWith("thread.")) {
              let data;
              try {
                data = JSON.parse(sse.data);
              } catch (e) {
                logger.error(`Could not parse message into JSON:`, sse.data);
                logger.error(`From chunk:`, sse.raw);
                throw e;
              }
              if (data && data.error) {
                throw new error_2.APIError(undefined, data.error, undefined, response.headers);
              }
              yield data;
            } else {
              let data;
              try {
                data = JSON.parse(sse.data);
              } catch (e) {
                console.error(`Could not parse message into JSON:`, sse.data);
                console.error(`From chunk:`, sse.raw);
                throw e;
              }
              if (sse.event == "error") {
                throw new error_2.APIError(undefined, data.error, data.message, undefined);
              }
              yield { event: sse.event, data };
            }
          }
          done = true;
        } catch (e) {
          if ((0, errors_1.isAbortError)(e))
            return;
          throw e;
        } finally {
          if (!done)
            controller.abort();
        }
      }
      return new Stream(iterator, controller, client);
    }
    static fromReadableStream(readableStream, controller, client) {
      let consumed = false;
      async function* iterLines() {
        const lineDecoder = new line_1.LineDecoder;
        const iter = (0, shims_2.ReadableStreamToAsyncIterable)(readableStream);
        for await (const chunk of iter) {
          for (const line of lineDecoder.decode(chunk)) {
            yield line;
          }
        }
        for (const line of lineDecoder.flush()) {
          yield line;
        }
      }
      async function* iterator() {
        if (consumed) {
          throw new error_1.GroqError("Cannot iterate over a consumed stream, use `.tee()` to split the stream.");
        }
        consumed = true;
        let done = false;
        try {
          for await (const line of iterLines()) {
            if (done)
              continue;
            if (line)
              yield JSON.parse(line);
          }
          done = true;
        } catch (e) {
          if ((0, errors_1.isAbortError)(e))
            return;
          throw e;
        } finally {
          if (!done)
            controller.abort();
        }
      }
      return new Stream(iterator, controller, client);
    }
    [(_Stream_client = new WeakMap, Symbol.asyncIterator)]() {
      return this.iterator();
    }
    tee() {
      const left = [];
      const right = [];
      const iterator = this.iterator();
      const teeIterator = (queue) => {
        return {
          next: () => {
            if (queue.length === 0) {
              const result = iterator.next();
              left.push(result);
              right.push(result);
            }
            return queue.shift();
          }
        };
      };
      return [
        new Stream(() => teeIterator(left), this.controller, tslib_1.__classPrivateFieldGet(this, _Stream_client, "f")),
        new Stream(() => teeIterator(right), this.controller, tslib_1.__classPrivateFieldGet(this, _Stream_client, "f"))
      ];
    }
    toReadableStream() {
      const self = this;
      let iter;
      return (0, shims_1.makeReadableStream)({
        async start() {
          iter = self[Symbol.asyncIterator]();
        },
        async pull(ctrl) {
          try {
            const { value, done } = await iter.next();
            if (done)
              return ctrl.close();
            const bytes = (0, bytes_1.encodeUTF8)(JSON.stringify(value) + `
`);
            ctrl.enqueue(bytes);
          } catch (err) {
            ctrl.error(err);
          }
        },
        async cancel() {
          await iter.return?.();
        }
      });
    }
  }
  exports2.Stream = Stream;
  async function* _iterSSEMessages(response, controller) {
    if (!response.body) {
      controller.abort();
      if (typeof globalThis.navigator !== "undefined" && globalThis.navigator.product === "ReactNative") {
        throw new error_1.GroqError(`The default react-native fetch implementation does not support streaming. Please use expo/fetch: https://docs.expo.dev/versions/latest/sdk/expo/#expofetch-api`);
      }
      throw new error_1.GroqError(`Attempted to iterate over a response with no body`);
    }
    const sseDecoder = new SSEDecoder;
    const lineDecoder = new line_1.LineDecoder;
    const iter = (0, shims_2.ReadableStreamToAsyncIterable)(response.body);
    for await (const sseChunk of iterSSEChunks(iter)) {
      for (const line of lineDecoder.decode(sseChunk)) {
        const sse = sseDecoder.decode(line);
        if (sse)
          yield sse;
      }
    }
    for (const line of lineDecoder.flush()) {
      const sse = sseDecoder.decode(line);
      if (sse)
        yield sse;
    }
  }
  async function* iterSSEChunks(iterator) {
    let data = new Uint8Array;
    for await (const chunk of iterator) {
      if (chunk == null) {
        continue;
      }
      const binaryChunk = chunk instanceof ArrayBuffer ? new Uint8Array(chunk) : typeof chunk === "string" ? (0, bytes_1.encodeUTF8)(chunk) : chunk;
      let newData = new Uint8Array(data.length + binaryChunk.length);
      newData.set(data);
      newData.set(binaryChunk, data.length);
      data = newData;
      let patternIndex;
      while ((patternIndex = (0, line_1.findDoubleNewlineIndex)(data)) !== -1) {
        yield data.slice(0, patternIndex);
        data = data.slice(patternIndex);
      }
    }
    if (data.length > 0) {
      yield data;
    }
  }

  class SSEDecoder {
    constructor() {
      this.event = null;
      this.data = [];
      this.chunks = [];
    }
    decode(line) {
      if (line.endsWith("\r")) {
        line = line.substring(0, line.length - 1);
      }
      if (!line) {
        if (!this.event && !this.data.length)
          return null;
        const sse = {
          event: this.event,
          data: this.data.join(`
`),
          raw: this.chunks
        };
        this.event = null;
        this.data = [];
        this.chunks = [];
        return sse;
      }
      this.chunks.push(line);
      if (line.startsWith(":")) {
        return null;
      }
      let [fieldname, _, value] = partition(line, ":");
      if (value.startsWith(" ")) {
        value = value.substring(1);
      }
      if (fieldname === "event") {
        this.event = value;
      } else if (fieldname === "data") {
        this.data.push(value);
      }
      return null;
    }
  }
  function partition(str, delimiter) {
    const index = str.indexOf(delimiter);
    if (index !== -1) {
      return [str.substring(0, index), delimiter, str.substring(index + delimiter.length)];
    }
    return [str, "", ""];
  }
});

// node_modules/groq-sdk/internal/parse.js
var require_parse = __commonJS((exports2) => {
  Object.defineProperty(exports2, "__esModule", { value: true });
  exports2.defaultParseResponse = defaultParseResponse;
  var streaming_1 = require_streaming();
  var log_1 = require_log();
  async function defaultParseResponse(client, props) {
    const { response, requestLogID, retryOfRequestLogID, startTime } = props;
    const body = await (async () => {
      if (response.status === 204) {
        return null;
      }
      if (props.options.__binaryResponse) {
        return response;
      }
      if (props.options.stream) {
        return streaming_1.Stream.fromSSEResponse(response, props.controller, client);
      }
      const contentType = response.headers.get("content-type");
      const mediaType = contentType?.split(";")[0]?.trim();
      const isJSON = mediaType?.includes("application/json") || mediaType?.endsWith("+json");
      if (isJSON) {
        const contentLength = response.headers.get("content-length");
        if (contentLength === "0") {
          return;
        }
        const json = await response.json();
        return json;
      }
      const text = await response.text();
      return text;
    })();
    (0, log_1.loggerFor)(client).debug(`[${requestLogID}] response parsed`, (0, log_1.formatRequestDetails)({
      retryOfRequestLogID,
      url: response.url,
      status: response.status,
      body,
      durationMs: Date.now() - startTime
    }));
    return body;
  }
});

// node_modules/groq-sdk/core/api-promise.js
var require_api_promise = __commonJS((exports2) => {
  var _APIPromise_client;
  Object.defineProperty(exports2, "__esModule", { value: true });
  exports2.APIPromise = undefined;
  var tslib_1 = require_tslib();
  var parse_1 = require_parse();

  class APIPromise extends Promise {
    constructor(client, responsePromise, parseResponse = parse_1.defaultParseResponse) {
      super((resolve) => {
        resolve(null);
      });
      this.responsePromise = responsePromise;
      this.parseResponse = parseResponse;
      _APIPromise_client.set(this, undefined);
      tslib_1.__classPrivateFieldSet(this, _APIPromise_client, client, "f");
    }
    _thenUnwrap(transform) {
      return new APIPromise(tslib_1.__classPrivateFieldGet(this, _APIPromise_client, "f"), this.responsePromise, async (client, props) => transform(await this.parseResponse(client, props), props));
    }
    asResponse() {
      return this.responsePromise.then((p) => p.response);
    }
    async withResponse() {
      const [data, response] = await Promise.all([this.parse(), this.asResponse()]);
      return { data, response };
    }
    parse() {
      if (!this.parsedPromise) {
        this.parsedPromise = this.responsePromise.then((data) => this.parseResponse(tslib_1.__classPrivateFieldGet(this, _APIPromise_client, "f"), data));
      }
      return this.parsedPromise;
    }
    then(onfulfilled, onrejected) {
      return this.parse().then(onfulfilled, onrejected);
    }
    catch(onrejected) {
      return this.parse().catch(onrejected);
    }
    finally(onfinally) {
      return this.parse().finally(onfinally);
    }
  }
  exports2.APIPromise = APIPromise;
  _APIPromise_client = new WeakMap;
});

// node_modules/groq-sdk/internal/utils/env.js
var require_env = __commonJS((exports2) => {
  Object.defineProperty(exports2, "__esModule", { value: true });
  exports2.readEnv = undefined;
  var readEnv = (env) => {
    if (typeof globalThis.process !== "undefined") {
      return globalThis.process.env?.[env]?.trim() || undefined;
    }
    if (typeof globalThis.Deno !== "undefined") {
      return globalThis.Deno.env?.get?.(env)?.trim() || undefined;
    }
    return;
  };
  exports2.readEnv = readEnv;
});

// node_modules/groq-sdk/client.js
var require_client = __commonJS((exports2) => {
  var _Groq_instances;
  var _a;
  var _Groq_encoder;
  var _Groq_baseURLOverridden;
  Object.defineProperty(exports2, "__esModule", { value: true });
  exports2.Groq = undefined;
  var tslib_1 = require_tslib();
  var uuid_1 = require_uuid();
  var values_1 = require_values();
  var sleep_1 = require_sleep();
  var errors_1 = require_errors();
  var detect_platform_1 = require_detect_platform();
  var Shims = tslib_1.__importStar(require_shims());
  var Opts = tslib_1.__importStar(require_request_options());
  var query_1 = require_query();
  var version_1 = require_version();
  var Errors = tslib_1.__importStar(require_error());
  var Uploads = tslib_1.__importStar(require_uploads2());
  var API = tslib_1.__importStar(require_resources());
  var api_promise_1 = require_api_promise();
  var batches_1 = require_batches();
  var completions_1 = require_completions2();
  var embeddings_1 = require_embeddings();
  var files_1 = require_files();
  var models_1 = require_models();
  var audio_1 = require_audio();
  var chat_1 = require_chat();
  var detect_platform_2 = require_detect_platform();
  var headers_1 = require_headers();
  var env_1 = require_env();
  var log_1 = require_log();
  var values_2 = require_values();

  class Groq {
    constructor({ baseURL = (0, env_1.readEnv)("GROQ_BASE_URL"), apiKey = (0, env_1.readEnv)("GROQ_API_KEY"), ...opts } = {}) {
      _Groq_instances.add(this);
      _Groq_encoder.set(this, undefined);
      this.completions = new API.Completions(this);
      this.chat = new API.Chat(this);
      this.embeddings = new API.Embeddings(this);
      this.audio = new API.Audio(this);
      this.models = new API.Models(this);
      this.batches = new API.Batches(this);
      this.files = new API.Files(this);
      if (apiKey === undefined) {
        throw new Errors.GroqError("The GROQ_API_KEY environment variable is missing or empty; either provide it, or instantiate the Groq client with an apiKey option, like new Groq({ apiKey: 'My API Key' }).");
      }
      const options = {
        apiKey,
        ...opts,
        baseURL: baseURL || `https://api.groq.com`
      };
      if (!options.dangerouslyAllowBrowser && (0, detect_platform_2.isRunningInBrowser)()) {
        throw new Errors.GroqError(`It looks like you're running in a browser-like environment.

This is disabled by default, as it risks exposing your secret API credentials to attackers.
If you understand the risks and have appropriate mitigations in place,
you can set the \`dangerouslyAllowBrowser\` option to \`true\`, e.g.,

new Groq({ apiKey, dangerouslyAllowBrowser: true })`);
      }
      this.baseURL = options.baseURL;
      this.timeout = options.timeout ?? _a.DEFAULT_TIMEOUT;
      this.logger = options.logger ?? console;
      const defaultLogLevel = "warn";
      this.logLevel = defaultLogLevel;
      this.logLevel = (0, log_1.parseLogLevel)(options.logLevel, "ClientOptions.logLevel", this) ?? (0, log_1.parseLogLevel)((0, env_1.readEnv)("GROQ_LOG"), "process.env['GROQ_LOG']", this) ?? defaultLogLevel;
      this.fetchOptions = options.fetchOptions;
      this.maxRetries = options.maxRetries ?? 2;
      this.fetch = options.fetch ?? Shims.getDefaultFetch();
      tslib_1.__classPrivateFieldSet(this, _Groq_encoder, Opts.FallbackEncoder, "f");
      const customHeadersEnv = (0, env_1.readEnv)("GROQ_CUSTOM_HEADERS");
      if (customHeadersEnv) {
        const parsed = {};
        for (const line of customHeadersEnv.split(`
`)) {
          const colon = line.indexOf(":");
          if (colon >= 0) {
            parsed[line.substring(0, colon).trim()] = line.substring(colon + 1).trim();
          }
        }
        options.defaultHeaders = { ...parsed, ...options.defaultHeaders };
      }
      this._options = options;
      this.apiKey = apiKey;
    }
    withOptions(options) {
      const client = new this.constructor({
        ...this._options,
        baseURL: this.baseURL,
        maxRetries: this.maxRetries,
        timeout: this.timeout,
        logger: this.logger,
        logLevel: this.logLevel,
        fetch: this.fetch,
        fetchOptions: this.fetchOptions,
        apiKey: this.apiKey,
        ...options
      });
      return client;
    }
    defaultQuery() {
      return this._options.defaultQuery;
    }
    validateHeaders({ values, nulls }) {
      return;
    }
    async authHeaders(opts) {
      return (0, headers_1.buildHeaders)([{ Authorization: `Bearer ${this.apiKey}` }]);
    }
    stringifyQuery(query) {
      return (0, query_1.stringifyQuery)(query);
    }
    getUserAgent() {
      return `${this.constructor.name}/JS ${version_1.VERSION}`;
    }
    defaultIdempotencyKey() {
      return `stainless-node-retry-${(0, uuid_1.uuid4)()}`;
    }
    makeStatusError(status, error, message, headers) {
      return Errors.APIError.generate(status, error, message, headers);
    }
    buildURL(path, query, defaultBaseURL) {
      const baseURL = !tslib_1.__classPrivateFieldGet(this, _Groq_instances, "m", _Groq_baseURLOverridden).call(this) && defaultBaseURL || this.baseURL;
      const url = (0, values_1.isAbsoluteURL)(path) ? new URL(path) : new URL(baseURL + (baseURL.endsWith("/") && path.startsWith("/") ? path.slice(1) : path));
      const defaultQuery = this.defaultQuery();
      const pathQuery = Object.fromEntries(url.searchParams);
      if (!(0, values_2.isEmptyObj)(defaultQuery) || !(0, values_2.isEmptyObj)(pathQuery)) {
        query = { ...pathQuery, ...defaultQuery, ...query };
      }
      if (typeof query === "object" && query && !Array.isArray(query)) {
        url.search = this.stringifyQuery(query);
      }
      return url.toString();
    }
    async prepareOptions(options) {}
    async prepareRequest(request, { url, options }) {}
    get(path, opts) {
      return this.methodRequest("get", path, opts);
    }
    post(path, opts) {
      return this.methodRequest("post", path, opts);
    }
    patch(path, opts) {
      return this.methodRequest("patch", path, opts);
    }
    put(path, opts) {
      return this.methodRequest("put", path, opts);
    }
    delete(path, opts) {
      return this.methodRequest("delete", path, opts);
    }
    methodRequest(method, path, opts) {
      return this.request(Promise.resolve(opts).then((opts2) => {
        return { method, path, ...opts2 };
      }));
    }
    request(options, remainingRetries = null) {
      return new api_promise_1.APIPromise(this, this.makeRequest(options, remainingRetries, undefined));
    }
    async makeRequest(optionsInput, retriesRemaining, retryOfRequestLogID) {
      const options = await optionsInput;
      const maxRetries = options.maxRetries ?? this.maxRetries;
      if (retriesRemaining == null) {
        retriesRemaining = maxRetries;
      }
      await this.prepareOptions(options);
      const { req, url, timeout } = await this.buildRequest(options, {
        retryCount: maxRetries - retriesRemaining
      });
      await this.prepareRequest(req, { url, options });
      const requestLogID = "log_" + (Math.random() * (1 << 24) | 0).toString(16).padStart(6, "0");
      const retryLogStr = retryOfRequestLogID === undefined ? "" : `, retryOf: ${retryOfRequestLogID}`;
      const startTime = Date.now();
      (0, log_1.loggerFor)(this).debug(`[${requestLogID}] sending request`, (0, log_1.formatRequestDetails)({
        retryOfRequestLogID,
        method: options.method,
        url,
        options,
        headers: req.headers
      }));
      if (options.signal?.aborted) {
        throw new Errors.APIUserAbortError;
      }
      const controller = new AbortController;
      const response = await this.fetchWithTimeout(url, req, timeout, controller).catch(errors_1.castToError);
      const headersTime = Date.now();
      if (response instanceof globalThis.Error) {
        const retryMessage = `retrying, ${retriesRemaining} attempts remaining`;
        if (options.signal?.aborted) {
          throw new Errors.APIUserAbortError;
        }
        const isTimeout = (0, errors_1.isAbortError)(response) || /timed? ?out/i.test(String(response) + ("cause" in response ? String(response.cause) : ""));
        if (retriesRemaining) {
          (0, log_1.loggerFor)(this).info(`[${requestLogID}] connection ${isTimeout ? "timed out" : "failed"} - ${retryMessage}`);
          (0, log_1.loggerFor)(this).debug(`[${requestLogID}] connection ${isTimeout ? "timed out" : "failed"} (${retryMessage})`, (0, log_1.formatRequestDetails)({
            retryOfRequestLogID,
            url,
            durationMs: headersTime - startTime,
            message: response.message
          }));
          return this.retryRequest(options, retriesRemaining, retryOfRequestLogID ?? requestLogID);
        }
        (0, log_1.loggerFor)(this).info(`[${requestLogID}] connection ${isTimeout ? "timed out" : "failed"} - error; no more retries left`);
        (0, log_1.loggerFor)(this).debug(`[${requestLogID}] connection ${isTimeout ? "timed out" : "failed"} (error; no more retries left)`, (0, log_1.formatRequestDetails)({
          retryOfRequestLogID,
          url,
          durationMs: headersTime - startTime,
          message: response.message
        }));
        if (isTimeout) {
          throw new Errors.APIConnectionTimeoutError;
        }
        throw new Errors.APIConnectionError({ cause: response });
      }
      const responseInfo = `[${requestLogID}${retryLogStr}] ${req.method} ${url} ${response.ok ? "succeeded" : "failed"} with status ${response.status} in ${headersTime - startTime}ms`;
      if (!response.ok) {
        const shouldRetry = await this.shouldRetry(response);
        if (retriesRemaining && shouldRetry) {
          const retryMessage2 = `retrying, ${retriesRemaining} attempts remaining`;
          await Shims.CancelReadableStream(response.body);
          (0, log_1.loggerFor)(this).info(`${responseInfo} - ${retryMessage2}`);
          (0, log_1.loggerFor)(this).debug(`[${requestLogID}] response error (${retryMessage2})`, (0, log_1.formatRequestDetails)({
            retryOfRequestLogID,
            url: response.url,
            status: response.status,
            headers: response.headers,
            durationMs: headersTime - startTime
          }));
          return this.retryRequest(options, retriesRemaining, retryOfRequestLogID ?? requestLogID, response.headers);
        }
        const retryMessage = shouldRetry ? `error; no more retries left` : `error; not retryable`;
        (0, log_1.loggerFor)(this).info(`${responseInfo} - ${retryMessage}`);
        const errText = await response.text().catch((err2) => (0, errors_1.castToError)(err2).message);
        const errJSON = (0, values_1.safeJSON)(errText);
        const errMessage = errJSON ? undefined : errText;
        (0, log_1.loggerFor)(this).debug(`[${requestLogID}] response error (${retryMessage})`, (0, log_1.formatRequestDetails)({
          retryOfRequestLogID,
          url: response.url,
          status: response.status,
          headers: response.headers,
          message: errMessage,
          durationMs: Date.now() - startTime
        }));
        const err = this.makeStatusError(response.status, errJSON, errMessage, response.headers);
        throw err;
      }
      (0, log_1.loggerFor)(this).info(responseInfo);
      (0, log_1.loggerFor)(this).debug(`[${requestLogID}] response start`, (0, log_1.formatRequestDetails)({
        retryOfRequestLogID,
        url: response.url,
        status: response.status,
        headers: response.headers,
        durationMs: headersTime - startTime
      }));
      return { response, options, controller, requestLogID, retryOfRequestLogID, startTime };
    }
    async fetchWithTimeout(url, init, ms, controller) {
      const { signal, method, ...options } = init || {};
      const abort = this._makeAbort(controller);
      if (signal)
        signal.addEventListener("abort", abort, { once: true });
      const timeout = setTimeout(abort, ms);
      const isReadableBody = globalThis.ReadableStream && options.body instanceof globalThis.ReadableStream || typeof options.body === "object" && options.body !== null && Symbol.asyncIterator in options.body;
      const fetchOptions = {
        signal: controller.signal,
        ...isReadableBody ? { duplex: "half" } : {},
        method: "GET",
        ...options
      };
      if (method) {
        fetchOptions.method = method.toUpperCase();
      }
      try {
        return await this.fetch.call(undefined, url, fetchOptions);
      } finally {
        clearTimeout(timeout);
      }
    }
    async shouldRetry(response) {
      const shouldRetryHeader = response.headers.get("x-should-retry");
      if (shouldRetryHeader === "true")
        return true;
      if (shouldRetryHeader === "false")
        return false;
      if (response.status === 408)
        return true;
      if (response.status === 409)
        return true;
      if (response.status === 429)
        return true;
      if (response.status >= 500)
        return true;
      return false;
    }
    async retryRequest(options, retriesRemaining, requestLogID, responseHeaders) {
      let timeoutMillis;
      const retryAfterMillisHeader = responseHeaders?.get("retry-after-ms");
      if (retryAfterMillisHeader) {
        const timeoutMs = parseFloat(retryAfterMillisHeader);
        if (!Number.isNaN(timeoutMs)) {
          timeoutMillis = timeoutMs;
        }
      }
      const retryAfterHeader = responseHeaders?.get("retry-after");
      if (retryAfterHeader && !timeoutMillis) {
        const timeoutSeconds = parseFloat(retryAfterHeader);
        if (!Number.isNaN(timeoutSeconds)) {
          timeoutMillis = timeoutSeconds * 1000;
        } else {
          timeoutMillis = Date.parse(retryAfterHeader) - Date.now();
        }
      }
      if (timeoutMillis === undefined) {
        const maxRetries = options.maxRetries ?? this.maxRetries;
        timeoutMillis = this.calculateDefaultRetryTimeoutMillis(retriesRemaining, maxRetries);
      }
      await (0, sleep_1.sleep)(timeoutMillis);
      return this.makeRequest(options, retriesRemaining - 1, requestLogID);
    }
    calculateDefaultRetryTimeoutMillis(retriesRemaining, maxRetries) {
      const initialRetryDelay = 0.5;
      const maxRetryDelay = 8;
      const numRetries = maxRetries - retriesRemaining;
      const sleepSeconds = Math.min(initialRetryDelay * Math.pow(2, numRetries), maxRetryDelay);
      const jitter = 1 - Math.random() * 0.25;
      return sleepSeconds * jitter * 1000;
    }
    async buildRequest(inputOptions, { retryCount = 0 } = {}) {
      const options = { ...inputOptions };
      const { method, path, query, defaultBaseURL } = options;
      const url = this.buildURL(path, query, defaultBaseURL);
      if ("timeout" in options)
        (0, values_1.validatePositiveInteger)("timeout", options.timeout);
      options.timeout = options.timeout ?? this.timeout;
      const { bodyHeaders, body } = this.buildBody({ options });
      const reqHeaders = await this.buildHeaders({ options: inputOptions, method, bodyHeaders, retryCount });
      const req = {
        method,
        headers: reqHeaders,
        ...options.signal && { signal: options.signal },
        ...globalThis.ReadableStream && body instanceof globalThis.ReadableStream && { duplex: "half" },
        ...body && { body },
        ...this.fetchOptions ?? {},
        ...options.fetchOptions ?? {}
      };
      return { req, url, timeout: options.timeout };
    }
    async buildHeaders({ options, method, bodyHeaders, retryCount }) {
      let idempotencyHeaders = {};
      if (this.idempotencyHeader && method !== "get") {
        if (!options.idempotencyKey)
          options.idempotencyKey = this.defaultIdempotencyKey();
        idempotencyHeaders[this.idempotencyHeader] = options.idempotencyKey;
      }
      const headers = (0, headers_1.buildHeaders)([
        idempotencyHeaders,
        {
          Accept: "application/json",
          "User-Agent": this.getUserAgent(),
          "X-Stainless-Retry-Count": String(retryCount),
          ...options.timeout ? { "X-Stainless-Timeout": String(Math.trunc(options.timeout / 1000)) } : {},
          ...(0, detect_platform_1.getPlatformHeaders)()
        },
        await this.authHeaders(options),
        this._options.defaultHeaders,
        bodyHeaders,
        options.headers
      ]);
      this.validateHeaders(headers);
      return headers.values;
    }
    _makeAbort(controller) {
      return () => controller.abort();
    }
    buildBody({ options }) {
      const { body, headers: rawHeaders } = options;
      if (!body) {
        if (body == null && "body" in options) {
          return tslib_1.__classPrivateFieldGet(this, _Groq_encoder, "f").call(this, { body, headers: (0, headers_1.buildHeaders)([rawHeaders]) });
        }
        return { bodyHeaders: undefined, body: undefined };
      }
      const headers = (0, headers_1.buildHeaders)([rawHeaders]);
      if (ArrayBuffer.isView(body) || body instanceof ArrayBuffer || body instanceof DataView || typeof body === "string" && headers.values.has("content-type") || globalThis.Blob && body instanceof globalThis.Blob || body instanceof FormData || body instanceof URLSearchParams || globalThis.ReadableStream && body instanceof globalThis.ReadableStream) {
        return { bodyHeaders: undefined, body };
      } else if (typeof body === "object" && ((Symbol.asyncIterator in body) || (Symbol.iterator in body) && ("next" in body) && typeof body.next === "function")) {
        return { bodyHeaders: undefined, body: Shims.ReadableStreamFrom(body) };
      } else if (typeof body === "object" && headers.values.get("content-type") === "application/x-www-form-urlencoded") {
        return {
          bodyHeaders: { "content-type": "application/x-www-form-urlencoded" },
          body: this.stringifyQuery(body)
        };
      } else {
        return tslib_1.__classPrivateFieldGet(this, _Groq_encoder, "f").call(this, { body, headers });
      }
    }
  }
  exports2.Groq = Groq;
  _a = Groq, _Groq_encoder = new WeakMap, _Groq_instances = new WeakSet, _Groq_baseURLOverridden = function _Groq_baseURLOverridden2() {
    return this.baseURL !== "https://api.groq.com";
  };
  Groq.Groq = _a;
  Groq.DEFAULT_TIMEOUT = 60000;
  Groq.GroqError = Errors.GroqError;
  Groq.APIError = Errors.APIError;
  Groq.APIConnectionError = Errors.APIConnectionError;
  Groq.APIConnectionTimeoutError = Errors.APIConnectionTimeoutError;
  Groq.APIUserAbortError = Errors.APIUserAbortError;
  Groq.NotFoundError = Errors.NotFoundError;
  Groq.ConflictError = Errors.ConflictError;
  Groq.RateLimitError = Errors.RateLimitError;
  Groq.BadRequestError = Errors.BadRequestError;
  Groq.AuthenticationError = Errors.AuthenticationError;
  Groq.InternalServerError = Errors.InternalServerError;
  Groq.PermissionDeniedError = Errors.PermissionDeniedError;
  Groq.UnprocessableEntityError = Errors.UnprocessableEntityError;
  Groq.toFile = Uploads.toFile;
  Groq.Completions = completions_1.Completions;
  Groq.Chat = chat_1.Chat;
  Groq.Embeddings = embeddings_1.Embeddings;
  Groq.Audio = audio_1.Audio;
  Groq.Models = models_1.Models;
  Groq.Batches = batches_1.Batches;
  Groq.Files = files_1.Files;
});

// node_modules/groq-sdk/index.js
exports = module.exports = function(...args) {
  return new exports.default(...args);
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.UnprocessableEntityError = exports.PermissionDeniedError = exports.InternalServerError = exports.AuthenticationError = exports.BadRequestError = exports.RateLimitError = exports.ConflictError = exports.NotFoundError = exports.APIUserAbortError = exports.APIConnectionTimeoutError = exports.APIConnectionError = exports.APIError = exports.GroqError = exports.Groq = exports.APIPromise = exports.toFile = exports.default = undefined;
var client_1 = require_client();
Object.defineProperty(exports, "default", { enumerable: true, get: function() {
  return client_1.Groq;
} });
var uploads_1 = require_uploads2();
Object.defineProperty(exports, "toFile", { enumerable: true, get: function() {
  return uploads_1.toFile;
} });
var api_promise_1 = require_api_promise();
Object.defineProperty(exports, "APIPromise", { enumerable: true, get: function() {
  return api_promise_1.APIPromise;
} });
var client_2 = require_client();
Object.defineProperty(exports, "Groq", { enumerable: true, get: function() {
  return client_2.Groq;
} });
var error_1 = require_error();
Object.defineProperty(exports, "GroqError", { enumerable: true, get: function() {
  return error_1.GroqError;
} });
Object.defineProperty(exports, "APIError", { enumerable: true, get: function() {
  return error_1.APIError;
} });
Object.defineProperty(exports, "APIConnectionError", { enumerable: true, get: function() {
  return error_1.APIConnectionError;
} });
Object.defineProperty(exports, "APIConnectionTimeoutError", { enumerable: true, get: function() {
  return error_1.APIConnectionTimeoutError;
} });
Object.defineProperty(exports, "APIUserAbortError", { enumerable: true, get: function() {
  return error_1.APIUserAbortError;
} });
Object.defineProperty(exports, "NotFoundError", { enumerable: true, get: function() {
  return error_1.NotFoundError;
} });
Object.defineProperty(exports, "ConflictError", { enumerable: true, get: function() {
  return error_1.ConflictError;
} });
Object.defineProperty(exports, "RateLimitError", { enumerable: true, get: function() {
  return error_1.RateLimitError;
} });
Object.defineProperty(exports, "BadRequestError", { enumerable: true, get: function() {
  return error_1.BadRequestError;
} });
Object.defineProperty(exports, "AuthenticationError", { enumerable: true, get: function() {
  return error_1.AuthenticationError;
} });
Object.defineProperty(exports, "InternalServerError", { enumerable: true, get: function() {
  return error_1.InternalServerError;
} });
Object.defineProperty(exports, "PermissionDeniedError", { enumerable: true, get: function() {
  return error_1.PermissionDeniedError;
} });
Object.defineProperty(exports, "UnprocessableEntityError", { enumerable: true, get: function() {
  return error_1.UnprocessableEntityError;
} });
