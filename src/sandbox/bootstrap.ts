import { MAX_LOG_LINE_CHARS } from './limits.js';

/**
 * JavaScript that runs inside the QuickJS VM before the script. It is an
 * expression that evaluates to a function taking the two host functions:
 *
 *   hostCall(server, tool, argsJson) -> Promise<string>   JSON of the tool result;
 *                                                         rejects with a JSON string {kind, message, tool}
 *   hostLog(line, length)                                 one captured console line, cut to MAX_LINE characters;
 *                                                         `length` is its length before the cut
 *
 * The host functions are only ever held in this closure, never on the global
 * object, and they only exchange strings with the host: the host never walks a
 * VM object. The function installs `mcp` and `console` and returns
 * `{ serialize, describe, unhandled }` for the host to turn the script outcome into text.
 *
 * Which errors the host may believe: the failure kind of an error is trusted
 * only when this closure created the error (from the host's answer to a call).
 * The kind, tool and message of such an error are kept in a WeakMap that the
 * script cannot reach, keyed by the error object, so nothing the script sets on
 * an error or throws in its place (a lookalike object, a subclass, a Proxy
 * around a real error, a patched WeakMap) can claim one. The built-ins used for
 * that are captured before the script runs.
 *
 * Unhandled rejections: every promise that `mcp.server.tool(...)` returns is a CallPromise, a
 * Promise subclass that notes when its `then` is called (await, .then, .catch, .finally and
 * Promise.all/race/allSettled all call it) and returns CallPromises from `then` too, so a chain
 * is followed to its end. `unhandled()` names the first rejected one that nothing handled. The
 * engine reports no unhandled rejections of its own, so promises the script makes in its own
 * async functions are not tracked, only the ones that start from a call.
 */
export const BOOTSTRAP_SOURCE = `(function (hostCall, hostLog) {
  'use strict';
  var stringify = JSON.stringify;
  var parse = JSON.parse;
  var MAX_LINE = ${MAX_LOG_LINE_CHARS};
  var ErrorCtor = Error;
  var PromiseCtor = Promise;
  var getPrototypeOf = Object.getPrototypeOf;
  var uncurry = Function.prototype.bind.bind(Function.prototype.call);
  var weakGet = uncurry(WeakMap.prototype.get);
  var weakSet = uncurry(WeakMap.prototype.set);
  var thenOf = uncurry(Promise.prototype.then);
  /** error object -> { kind, tool, message } for the errors made by toError below. */
  var trustedErrors = new WeakMap();
  // The engine's own errors (out of memory, stack overflow) are InternalError instances. The
  // constructor is not left on the global object, so a script cannot build one.
  var enginePrototype = typeof InternalError === 'function' ? InternalError.prototype : null;
  delete globalThis.InternalError;

  function show(value) {
    if (typeof value === 'string') return value;
    if (typeof value === 'function') return '[Function' + (value.name ? ': ' + value.name : '') + ']';
    if (typeof value === 'bigint') return String(value) + 'n';
    if (typeof value === 'symbol') return String(value);
    if (value instanceof Error) return String(value.name) + ': ' + String(value.message);
    if (typeof value === 'object' && value !== null) {
      try {
        var text = stringify(value);
        if (typeof text === 'string') return text;
      } catch (e) { /* circular or hostile object: fall through */ }
    }
    try { return String(value); } catch (e) { return '[unprintable]'; }
  }

  function logger(prefix) {
    return function () {
      var parts = [];
      for (var i = 0; i < arguments.length; i++) parts.push(show(arguments[i]));
      var line = prefix + parts.join(' ');
      var length = line.length;
      if (length > MAX_LINE) line = line.slice(0, MAX_LINE - 1) + '\\u2026';
      hostLog(line, length);
    };
  }

  Object.defineProperty(globalThis, 'console', {
    value: {
      log: logger(''),
      info: logger(''),
      debug: logger(''),
      warn: logger('[warn] '),
      error: logger('[error] '),
    },
    writable: true,
    configurable: true,
    enumerable: false,
  });

  function toError(raw, server, tool) {
    var info;
    try { info = parse(raw); } catch (e) { info = { kind: 'tool', message: String(raw) }; }
    var message = String(info.message);
    var error = new ErrorCtor(message);
    error.kind = info.kind;
    error.tool = info.tool || server + '.' + tool;
    weakSet(trustedErrors, error, { kind: info.kind, tool: error.tool, message: message });
    return error;
  }

  /** CallPromise -> its record; and every record, in the order the promises were made. */
  var records = new WeakMap();
  var allRecords = [];
  var rejections = 0;

  class CallPromise extends PromiseCtor {
    // The promises the built-in methods make from this one are plain: then() makes its own.
    static get [Symbol.species]() { return PromiseCtor; }

    constructor(executor) {
      super(executor);
      var record = { handled: false, rejected: false, reason: undefined, order: 0 };
      weakSet(records, this, record);
      allRecords.push(record);
      thenOf(this, undefined, function (reason) {
        record.rejected = true;
        record.reason = reason;
        record.order = ++rejections;
      });
    }

    then(onFulfilled, onRejected) {
      var record = weakGet(records, this);
      if (record !== undefined) record.handled = true;
      var derived = thenOf(this, onFulfilled, onRejected);
      return new CallPromise(function (resolve, reject) { thenOf(derived, resolve, reject); });
    }
  }

  function call(server, tool, args) {
    try {
      if (args === undefined) args = {};
      if (args === null || typeof args !== 'object' || Array.isArray(args)) {
        throw new TypeError('mcp.' + server + '.' + tool + ': the argument must be an object');
      }
      var json = stringify(args);
      var answer = thenOf(
        hostCall(server, tool, json),
        function (text) { return parse(text); },
        function (raw) { throw toError(raw, server, tool); }
      );
      return new CallPromise(function (resolve, reject) { thenOf(answer, resolve, reject); });
    } catch (e) {
      return new CallPromise(function (resolve, reject) { reject(e); });
    }
  }

  // A symbol, 'then' or 'toJSON' is never a name: answering them would make awaiting
  // or serialising a proxy start a call, or hang on a thenable.
  function isName(key) {
    return typeof key === 'string' && key !== 'then' && key !== 'toJSON';
  }

  function serverProxy(server) {
    return new Proxy(Object.create(null), {
      get: function (_target, tool) {
        if (!isName(tool)) return undefined;
        return function (args) { return call(server, tool, args); };
      }
    });
  }

  var mcp = new Proxy(Object.create(null), {
    get: function (_target, server) {
      return isName(server) ? serverProxy(server) : undefined;
    }
  });
  Object.defineProperty(globalThis, 'mcp', {
    value: mcp, writable: true, configurable: true, enumerable: false
  });

  function describe(error) {
    var out = {};
    try {
      var isObject = error !== null && (typeof error === 'object' || typeof error === 'function');
      var trusted = isObject ? weakGet(trustedErrors, error) : undefined;
      if (trusted !== undefined) {
        out.name = 'Error';
        out.message = trusted.message;
        out.host = { kind: trusted.kind, tool: trusted.tool };
      } else if (error !== null && typeof error === 'object') {
        out.name = typeof error.name === 'string' ? error.name : 'Error';
        out.message = String(error.message);
        if (typeof error.stack === 'string') out.stack = error.stack;
        if (error.message === undefined) {
          out.message = show(error);
          out.thrown = true;
        }
        if (enginePrototype !== null && getPrototypeOf(error) === enginePrototype) out.engine = true;
      } else {
        // A thrown string, number, null ...: there is no Error to name, only the value.
        out.name = 'Error';
        out.message = show(error);
        out.thrown = true;
      }
    } catch (e) {
      out = { name: 'Error', message: 'the script threw a value that cannot be described' };
    }
    return stringify(out);
  }

  return {
    serialize: function (value) {
      var text = stringify(value);
      return text === undefined ? 'null' : text;
    },
    describe: describe,
    // The description of the first rejection that nothing handled, or '' when there is none. A call
    // the host refused because the script had already returned is not a failure of the script.
    unhandled: function () {
      var first = null;
      for (var i = 0; i < allRecords.length; i++) {
        var record = allRecords[i];
        if (!record.rejected || record.handled) continue;
        var reason = record.reason;
        var trusted = reason !== null && (typeof reason === 'object' || typeof reason === 'function') ? weakGet(trustedErrors, reason) : undefined;
        if (trusted !== undefined && trusted.kind === 'finished') continue;
        if (first === null || record.order < first.order) first = record;
      }
      return first === null ? '' : describe(first.reason);
    }
  };
})`;
