import type { QuickJSContext, QuickJSDeferredPromise, QuickJSHandle, QuickJSWASMModule } from 'quickjs-emscripten-core';
import { BOOTSTRAP_SOURCE } from './bootstrap.js';
import {
  EXTRACT_WINDOW_MS,
  LogBuffer,
  MAX_ARGS_BYTES,
  MAX_NAME_CHARS,
  STACK_BYTES,
  capResult,
  clampMessage,
  type SandboxLimits,
} from './limits.js';
import type { ErrorKind, LogAccount, SandboxError } from './protocol.js';

/**
 * The in-process half of `mcpkit exec`: run one script in a fresh QuickJS-WASM
 * VM. It knows nothing about processes, MCP servers or the write gate; tool
 * calls go through the `hostCall` it is given.
 */

/** Rejection of a host call: the script sees an Error carrying `kind` and `tool`. */
export class HostCallError extends Error {
  constructor(readonly kind: ErrorKind, message: string, readonly tool?: string) {
    super(message);
    this.name = 'HostCallError';
  }
}

/** Run one tool call. Resolves with the JSON text of the result. */
export type HostCall = (server: string, tool: string, argsJson: string) => Promise<string>;

export interface SandboxRunOptions {
  code: string;
  limits: SandboxLimits;
  hostCall: HostCall;
  /** When the run's wall clock ends (epoch ms), if it started before this call; else `limits.timeoutMs` from now. */
  deadline?: number;
  /** Called with each console line that fits the log budget. */
  onLog?: (line: string) => void;
  /** Called once, when the first console line is dropped or shortened. */
  onLogsCut?: () => void;
  /**
   * Checked from the VM's interrupt handler, which is the only code that runs while a script
   * spins without ever yielding: true ends the run at once (nobody is left to read its result).
   */
  parentGone?: () => boolean;
}

export type SandboxOutcome =
  | {
    ok: true;
    /** JSON text of the result (`null` when the script returned nothing), or its first bytes when cut. */
    result: string;
    resultTruncated: boolean;
    resultBytes: number;
    logs: string[];
    logsTruncated: boolean;
    logAccount: LogAccount;
    /** What the run could not honour: calls the script started after it returned. */
    warnings: string[];
  }
  | { ok: false; error: SandboxError; logs: string[]; logsTruncated: boolean; logAccount: LogAccount; warnings: string[] };

const SCRIPT_FILE = 'script.js';
/** Distinct warnings kept for the envelope. */
const MAX_WARNINGS = 20;
/** Lines the wrapper adds before the script, so line numbers can be reported against the script. */
const WRAPPER_LINES = 1;

/** The engine's linear memory starts at 256 pages (16 MiB); a smaller one is refused at start-up. */
const WASM_INITIAL_PAGES = 256;
const WASM_PAGE_BYTES = 65_536;
/**
 * MiB of that initial memory the engine itself needs (measured: strings of 1 MiB fit until
 * about the total less 6 MiB), so `--memory-mb N` leaves the script about N MiB and not N + 10.
 */
const ENGINE_BASELINE_MIB = 6;

/**
 * The linear memory of one engine instance, capped at the run's memory limit. QuickJS's own
 * limit (`setMemoryLimit`) cannot be relied on here: in the WASM build it sizes each block as 0
 * bytes, so only a single huge allocation trips it and a script can fill gigabytes. The cap on
 * the memory itself holds for strings, arrays, objects and typed arrays alike.
 */
interface BoundedMemory {
  memory: WebAssembly.Memory;
  /** The last attempt to grow the memory was refused: the heap is full. */
  refused(): boolean;
}

function boundedMemory(memoryMb: number): BoundedMemory {
  const maximum = Math.max(WASM_INITIAL_PAGES, Math.ceil(((memoryMb + ENGINE_BASELINE_MIB) * 1024 * 1024) / WASM_PAGE_BYTES));
  const memory = new WebAssembly.Memory({ initial: WASM_INITIAL_PAGES, maximum });
  const grow = memory.grow.bind(memory);
  let refused = false;
  // The engine's allocator calls `memory.grow` when the heap is full and treats a throw as "out
  // of memory". Wrapping it tells us that happened even when the script never sees the error.
  memory.grow = (delta: number): number => {
    try {
      const previous = grow(delta);
      refused = false;
      return previous;
    } catch (error) {
      refused = true;
      throw error;
    }
  };
  return { memory, refused: () => refused };
}

interface Engine {
  module: QuickJSWASMModule;
  memory: BoundedMemory;
}

let engineLibraries: Promise<[typeof import('quickjs-emscripten-core'), typeof import('@jitl/quickjs-wasmfile-release-sync')]> | undefined;

/**
 * A fresh engine for one run (about 5 ms) on its own capped memory. The libraries are imported
 * lazily and once per process: only `exec` pays for them.
 */
async function loadEngine(memoryMb: number): Promise<Engine> {
  engineLibraries ??= Promise.all([
    import('quickjs-emscripten-core'),
    import('@jitl/quickjs-wasmfile-release-sync'),
  ]).catch((error: unknown) => {
    engineLibraries = undefined;
    throw error;
  });
  const [core, variant] = await engineLibraries;
  const memory = boundedMemory(memoryMb);
  const module = await core.newQuickJSWASMModuleFromVariant(
    core.newVariant(variant.default, { wasmMemory: memory.memory }),
  );
  return { module, memory };
}

function shiftLine(line: number): number {
  return Math.max(1, line - WRAPPER_LINES);
}

/**
 * Wrap the script as the body of an async function, then strip the TypeScript
 * types (wrap first, so a top-level `await` and `return` parse).
 */
async function prepareScript(code: string): Promise<string> {
  const { transform } = await import('sucrase');
  try {
    return transform(`(async () => {\n${code}\n})()`, {
      transforms: ['typescript'],
      disableESTransforms: true,
    }).code;
  } catch (error) {
    const loc = (error as { loc?: { line?: number; column?: number } }).loc;
    const reason = (error instanceof Error ? error.message : String(error)).replace(/\s*\(\d+:\d+\)\s*$/, '');
    throw new ScriptSyntaxError(loc?.line === undefined
      ? `SyntaxError: ${reason}`
      : `SyntaxError: ${reason} (script line ${shiftLine(loc.line)}, column ${loc.column ?? 0})`);
  }
}

class ScriptSyntaxError extends Error {}

/** `import` and `export` are the usual mistake: the script is a function body, not a module. */
function syntaxHint(code: string): string {
  return /^\s*(import|export)\b/m.test(code)
    ? ' (the script is the body of an async function: ES module import/export is not available)'
    : '';
}

interface ErrorDescription {
  name?: string;
  message?: string;
  stack?: string;
  /** Present only for an error the bootstrap itself made from the host's answer to a call. */
  host?: { kind?: string; tool?: string };
  /** The thrown value is one of the engine's own InternalErrors (out of memory, stack overflow). */
  engine?: boolean;
  /** The script threw something that is not an error object (a string, a number, `{code: 5}`): `message` is the value itself. */
  thrown?: boolean;
}

function parseDescription(text: string): ErrorDescription {
  try {
    const parsed: unknown = JSON.parse(text);
    return typeof parsed === 'object' && parsed !== null ? parsed as ErrorDescription : {};
  } catch {
    return {};
  }
}

/** Where the script failed, as "(script line L, column C)", from the first script frame of a QuickJS stack. */
function scriptLocation(stack: string | undefined): string {
  const frame = stack === undefined ? null : new RegExp(`${SCRIPT_FILE}:(\\d+):(\\d+)`).exec(stack);
  return frame === null ? '' : ` (script line ${shiftLine(Number(frame[1]))}, column ${frame[2]})`;
}

function memoryLimitError(memoryMb: number): SandboxError {
  return { kind: 'limit', message: `the script ran out of memory (limit ${memoryMb} MiB, set with --memory-mb)` };
}

/**
 * Only an error the bootstrap made (`host`) or one the engine threw (`engine`) can carry a kind
 * other than "script": whatever else the script throws, in whatever shape, is a script error.
 */
function toSandboxError(description: ErrorDescription, code: string, memoryMb: number): SandboxError {
  const name = description.name ?? 'Error';
  const message = description.message ?? '';
  const kind = description.host?.kind;
  if (kind === 'tool' || kind === 'blocked' || kind === 'limit' || kind === 'timeout') {
    return {
      kind,
      message: clampMessage(message),
      ...(description.host?.tool === undefined ? {} : { tool: description.host.tool }),
    };
  }
  if (description.engine === true && /out of memory/i.test(message)) return memoryLimitError(memoryMb);
  if (description.engine === true && /stack overflow/i.test(message)) {
    return { kind: 'limit', message: clampMessage(`${name}: ${message}`) };
  }
  if (description.thrown === true) return { kind: 'script', message: clampMessage(message) };
  const hint = name === 'SyntaxError' ? syntaxHint(code) : '';
  return { kind: 'script', message: clampMessage(`${name}: ${message}${scriptLocation(description.stack)}${hint}`) };
}

/** Run `code` in a fresh sandbox. Never throws: every failure is an outcome. */
export async function runSandbox(options: SandboxRunOptions): Promise<SandboxOutcome> {
  const { limits, hostCall } = options;
  const logs = new LogBuffer(limits.maxOutputBytes);
  const warnings: string[] = [];
  const outcomeOf = (error: SandboxError): SandboxOutcome => ({
    ok: false,
    error,
    logs: logs.result(),
    logsTruncated: logs.truncated,
    logAccount: logs.account,
    warnings,
  });

  let script: string;
  try {
    script = await prepareScript(options.code);
  } catch (error) {
    if (error instanceof ScriptSyntaxError) {
      return outcomeOf({ kind: 'script', message: error.message + syntaxHint(options.code) });
    }
    return outcomeOf({ kind: 'internal', message: `could not prepare the script: ${(error as Error).message}` });
  }

  let engine: Engine;
  try {
    engine = await loadEngine(limits.memoryMb);
  } catch (error) {
    return outcomeOf({ kind: 'internal', message: `could not load the JavaScript sandbox: ${(error as Error).message}` });
  }

  const runtime = engine.module.newRuntime();
  const vm = runtime.newContext();
  const handles: Array<{ alive: boolean; dispose(): void }> = [];
  const deferreds = new Set<QuickJSDeferredPromise>();
  const own = <T extends { alive: boolean; dispose(): void }>(handle: T): T => {
    handles.push(handle);
    return handle;
  };

  let deadline = options.deadline ?? Date.now() + limits.timeoutMs;
  let logsCutNotified = false;
  let timedOut = false;
  /** Set when a limit that cannot be caught by the script (call count) trips. */
  let stop: SandboxError | undefined;
  let finished = false;
  /** The VM is being released: nothing may be handed to it any more. */
  let disposed = false;
  let calls = 0;
  let pendingCalls = 0;
  let dirty = false;
  let wake: (() => void) | undefined;
  /** A host exception escaped the WASM (stack exhaustion in native code): the VM is unusable and must not be disposed. */
  let tainted = false;
  /** The heap hit its cap at some point. Sticky: a script that catches the out-of-memory error does not undo it. */
  let heapFull = false;
  const outOfMemory = (): boolean => {
    heapFull ||= engine.memory.refused();
    return heapFull;
  };

  const markDirty = (): void => {
    dirty = true;
    wake?.();
  };

  try {
    runtime.setMemoryLimit(limits.memoryMb * 1024 * 1024);
    runtime.setMaxStackSize(STACK_BYTES);
    runtime.setInterruptHandler(() => {
      if (stop !== undefined) return true;
      if (outOfMemory()) {
        stop = memoryLimitError(limits.memoryMb);
        return true;
      }
      if (options.parentGone?.() === true) {
        stop = { kind: 'internal', message: 'the process that started the sandbox is gone' };
        return true;
      }
      if (Date.now() > deadline) {
        timedOut = true;
        return true;
      }
      return false;
    });

    /** The kind `finished` is only ever seen by the bootstrap: it marks a call refused after the script returned. */
    const rejectWith = (deferred: QuickJSDeferredPromise, kind: ErrorKind | 'finished', message: string, tool?: string): void => {
      const reason = vm.newString(JSON.stringify({ kind, message, ...(tool === undefined ? {} : { tool }) }));
      deferred.reject(reason);
      reason.dispose();
    };

    const hostCallFn = own(vm.newFunction('hostCall', (serverHandle, toolHandle, argsHandle) => {
      const deferred = vm.newPromise();
      deferreds.add(deferred);
      const server = vm.getString(serverHandle);
      const tool = vm.getString(toolHandle);
      const argsJson = vm.getString(argsHandle);

      if (finished) {
        // The script already returned (this is code that ran afterwards, such as a `.then` on a call it did
        // not await): the call is not made, and the envelope says so.
        const message = `mcp.${server}.${tool}() was called after the script returned, so it was not run`;
        if (warnings.length < MAX_WARNINGS && !warnings.includes(message)) warnings.push(message);
        rejectWith(deferred, 'finished', message);
        return deferred.handle;
      }
      // These would only be refused by the parent as a protocol violation (and end the run as an
      // internal error), so the script gets a catchable error of the right kind instead.
      const name = `${server}.${tool}`;
      if (server === '' || tool === '' || server.length > MAX_NAME_CHARS || tool.length > MAX_NAME_CHARS) {
        rejectWith(deferred, 'tool', `mcpkit: a server or tool name is empty or longer than ${MAX_NAME_CHARS} characters`);
        return deferred.handle;
      }
      if (Buffer.byteLength(argsJson, 'utf-8') > MAX_ARGS_BYTES) {
        rejectWith(deferred, 'limit', `mcpkit: the arguments of ${name} are larger than ${MAX_ARGS_BYTES} bytes; send less`, name);
        return deferred.handle;
      }
      if (calls >= limits.maxCalls) {
        const message = `mcpkit: call limit reached (${limits.maxCalls} calls); raise it with --max-calls`;
        stop = { kind: 'limit', message };
        rejectWith(deferred, 'limit', message);
        return deferred.handle;
      }
      calls++;
      pendingCalls++;

      const settle = (apply: () => void): void => {
        pendingCalls--;
        // After the script returned, calls it did not await still answer (see settleLooseEnds).
        if (!disposed) {
          try {
            apply();
          } catch (error) {
            // Out of memory while handing the result to the VM: report it to the script if there is room.
            try {
              rejectWith(deferred, 'limit', `could not hand the result to the script: ${(error as Error).message}`);
            } catch {
              // The VM is full: the script ends as "never finished" instead.
            }
          }
        }
        markDirty();
      };
      hostCall(server, tool, argsJson).then(
        (json) => settle(() => {
          const value = vm.newString(json);
          deferred.resolve(value);
          value.dispose();
        }),
        (error: unknown) => settle(() => {
          const failure = error instanceof HostCallError
            ? error
            : new HostCallError('internal', error instanceof Error ? error.message : String(error));
          rejectWith(deferred, failure.kind, failure.message, failure.tool);
        }),
      );
      return deferred.handle;
    }));

    const hostLogFn = own(vm.newFunction('hostLog', (lineHandle, lengthHandle) => {
      const line = vm.getString(lineHandle);
      // The bootstrap cuts a very long line before it leaves the VM and says how long it was.
      const kept = logs.add(line, lengthHandle === undefined ? line.length : vm.getNumber(lengthHandle));
      if (kept !== undefined) options.onLog?.(kept);
      if (!logsCutNotified && logs.truncated) {
        logsCutNotified = true;
        options.onLogsCut?.();
      }
    }));

    const bootstrap = own(vm.unwrapResult(vm.evalCode(BOOTSTRAP_SOURCE, 'bootstrap.js')));
    const api = own(vm.unwrapResult(vm.callFunction(bootstrap, vm.undefined, hostCallFn, hostLogFn)));
    const serialize = own(vm.getProp(api, 'serialize'));
    const describe = own(vm.getProp(api, 'describe'));
    const unhandled = own(vm.getProp(api, 'unhandled'));

    const describeError = (error: QuickJSHandle): ErrorDescription => {
      const text = vm.callFunction(describe, vm.undefined, error);
      if (text.error) {
        text.error.dispose();
        return { name: 'Error', message: 'the script threw a value that cannot be described' };
      }
      const description = parseDescription(vm.getString(text.value));
      text.value.dispose();
      return description;
    };

    /** Why the VM was stopped from outside, if it was. Running more VM code is pointless then. */
    const interrupted = (): SandboxError | undefined => {
      if (stop !== undefined) return stop;
      if (outOfMemory()) return memoryLimitError(limits.memoryMb);
      // The deadline is checked here as well as in the interrupt handler: a script that waits on
      // calls and catches their timeout errors never runs code the handler would see.
      if (!timedOut && Date.now() > deadline) timedOut = true;
      if (timedOut) {
        return { kind: 'timeout', message: `the script ran past the time limit of ${limits.timeoutMs} ms` };
      }
      return undefined;
    };
    const runDeadline = deadline;
    /** The script is over; give the serialisation its own short window (the main deadline may be spent). */
    const beginExtraction = (): void => {
      finished = true;
      deadline = Date.now() + EXTRACT_WINDOW_MS;
      timedOut = false;
    };

    /**
     * Calls the script did not await may still be running, and code that waits on them may still
     * run. Let them finish, so a fire-and-forget write is not cut off and a failure that nothing
     * caught can still end the run (like an unhandled rejection in Node). Calls started from here on
     * are refused and listed in the warnings. Resolves with the failure that ends the run, if any.
     */
    const settleLooseEnds = async (): Promise<SandboxError | undefined> => {
      deadline = runDeadline;
      timedOut = false;
      for (;;) {
        const jobs = runtime.executePendingJobs();
        if (jobs.error) {
          const early = interrupted();
          const description = early === undefined ? describeError(jobs.error) : undefined;
          jobs.error.dispose();
          return early ?? toSandboxError(description as ErrorDescription, options.code, limits.memoryMb);
        }
        const early = interrupted();
        if (early !== undefined) {
          return early.kind === 'timeout' && pendingCalls > 0
            ? {
              kind: 'timeout',
              message: `the script finished, but ${pendingCalls} call(s) it did not await were still running at the time limit of ${limits.timeoutMs} ms`,
            }
            : early;
        }
        if (pendingCalls === 0) break;
        if (!dirty) {
          await new Promise<void>((resolve) => {
            wake = resolve;
          });
          wake = undefined;
        }
        dirty = false;
      }

      const text = vm.callFunction(unhandled, vm.undefined);
      if (text.error) {
        text.error.dispose();
        return undefined;
      }
      const description = vm.getString(text.value);
      text.value.dispose();
      if (description === '') return undefined;
      const failure = toSandboxError(parseDescription(description), options.code, limits.memoryMb);
      return { ...failure, message: clampMessage(`${failure.message} [the call was not awaited and its failure was not caught, so it ended the run]`) };
    };

    const evaluated = vm.evalCode(script, SCRIPT_FILE);
    if (evaluated.error) {
      const early = interrupted();
      const description = early === undefined ? describeError(evaluated.error) : undefined;
      evaluated.error.dispose();
      return outcomeOf(early ?? toSandboxError(description as ErrorDescription, options.code, limits.memoryMb));
    }
    const mainPromise = own(evaluated.value);

    const timer = setTimeout(() => {
      timedOut = true;
      markDirty();
    }, Math.max(0, deadline - Date.now()));

    try {
      for (;;) {
        const jobs = runtime.executePendingJobs();
        if (jobs.error) {
          const early = interrupted();
          const description = early === undefined ? describeError(jobs.error) : undefined;
          jobs.error.dispose();
          return outcomeOf(early ?? toSandboxError(description as ErrorDescription, options.code, limits.memoryMb));
        }
        if (stop !== undefined) return outcomeOf(stop);

        const state = vm.getPromiseState(mainPromise);
        if (state.type === 'fulfilled') {
          const late = interrupted();
          if (late !== undefined) {
            state.value.dispose();
            return outcomeOf(late);
          }
          beginExtraction();
          const text = vm.callFunction(serialize, vm.undefined, state.value);
          state.value.dispose();
          if (text.error) {
            const early = interrupted();
            const description = early === undefined ? describeError(text.error) : undefined;
            text.error.dispose();
            return outcomeOf(early ?? {
              kind: 'script',
              message: clampMessage(`the returned value cannot be converted to JSON: ${description?.message ?? 'unknown error'}`),
            });
          }
          const capped = capResult(vm.getString(text.value), limits.maxOutputBytes);
          text.value.dispose();
          const loose = await settleLooseEnds();
          if (loose !== undefined) return outcomeOf(loose);
          return {
            ok: true,
            result: capped.text,
            resultTruncated: capped.truncated,
            resultBytes: capped.totalBytes,
            logs: logs.result(),
            logsTruncated: logs.truncated,
            logAccount: logs.account,
            warnings,
          };
        }
        if (state.type === 'rejected') {
          // An interrupt surfaces as a rejection of the async wrapper, so it is checked before the error is read.
          const early = interrupted();
          if (early !== undefined) {
            state.error.dispose();
            return outcomeOf(early);
          }
          beginExtraction();
          const description = describeError(state.error);
          state.error.dispose();
          return outcomeOf(toSandboxError(description, options.code, limits.memoryMb));
        }

        const early = interrupted();
        if (early !== undefined) return outcomeOf(early);
        if (pendingCalls === 0) {
          return outcomeOf({
            kind: 'script',
            message: 'the script never finished: it awaits a promise that nothing can resolve (there are no timers; only mcp.* calls settle)',
          });
        }
        if (!dirty) {
          await new Promise<void>((resolve) => {
            wake = resolve;
          });
          wake = undefined;
        }
        dirty = false;
      }
    } finally {
      clearTimeout(timer);
    }
  } catch (error) {
    tainted = true;
    if (outOfMemory()) return outcomeOf(memoryLimitError(limits.memoryMb));
    if (error instanceof RangeError && /call stack/i.test(error.message)) {
      return outcomeOf({ kind: 'limit', message: 'the script exhausted the stack (too much recursion or nesting)' });
    }
    return outcomeOf({ kind: 'internal', message: `sandbox failure: ${(error as Error).message}` });
  } finally {
    finished = true;
    disposed = true;
    if (!tainted) disposeAll(runtime, vm, deferreds, handles);
  }
}

/** Release the VM. Best effort: a script that left handles behind must not turn into a crash. */
function disposeAll(
  runtime: { dispose(): void },
  vm: QuickJSContext,
  deferreds: Set<QuickJSDeferredPromise>,
  handles: Array<{ alive: boolean; dispose(): void }>,
): void {
  const attempt = (release: () => void): void => {
    try {
      release();
    } catch {
      // Already released, or the WASM refused: nothing more to do.
    }
  };
  for (const deferred of deferreds) attempt(() => deferred.dispose());
  for (const handle of handles.reverse()) attempt(() => handle.alive && handle.dispose());
  attempt(() => vm.dispose());
  attempt(() => runtime.dispose());
}
