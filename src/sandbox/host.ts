import { fork, type ChildProcess } from 'node:child_process';
import { BrokerError, CallBroker, defaultBrokerDeps, type BrokerDeps } from './broker.js';
import type { GatePolicy } from './gate.js';
import {
  KILL_GRACE_MS,
  LogBuffer,
  REAP_GRACE_MS,
  clampMessage,
  truncatedResultText,
  type SandboxLimits,
} from './limits.js';
import { debugLog } from './redact.js';
import { createProcessWatch, type ProcessWatch } from './reaper.js';
import {
  parseChildMessage,
  type CallMessage,
  type ChildMessage,
  type DoneMessage,
  type ParentMessage,
  type SandboxError,
} from './protocol.js';

/**
 * The parent side of `mcpkit exec`. It starts the sandbox child with an empty
 * environment, answers the child's `mcp.*` calls through the CallBroker (which
 * holds the sessions, the credentials and the write gate), enforces the limits
 * itself and builds the envelope. It trusts nothing the child sends.
 */

export interface ExecRequest {
  code: string;
  policy: GatePolicy;
  limits: SandboxLimits;
  /** Aborting ends the run as a failure; the child is killed and the sessions are closed. */
  signal?: AbortSignal;
  /** Called for every call the write gate blocks, whether or not the script catches the error. */
  onBlocked?: (server: string, tool: string) => void;
}

export interface ExecSuccess {
  ok: true;
  result: unknown;
  logs: string[];
  calls: number;
  blocked: string[];
  truncated: boolean;
  /** Present only when the run could not honour something the script did. */
  warnings?: string[];
}

export interface ExecFailure {
  ok: false;
  error: SandboxError;
  logs: string[];
  calls: number;
  blocked: string[];
  /** Present (true) only when the logs were cut. */
  truncated?: true;
  /** Present only when the run could not honour something the script did. */
  warnings?: string[];
}

export type ExecEnvelope = ExecSuccess | ExecFailure;

/** The child process, as the host uses it; tests replace it with a fake. */
export interface WorkerHandle {
  send(message: ParentMessage): void;
  onMessage(handler: (raw: unknown) => void): void;
  onExit(handler: (description: string) => void): void;
  /** The last bytes the child wrote to stderr. */
  stderrTail(): string;
  /** SIGKILL the child and wait (bounded) until it is gone. */
  kill(): Promise<void>;
}

export interface HostDeps {
  spawnWorker(): WorkerHandle;
  broker: BrokerDeps;
  /**
   * The processes this one started (the sandbox, the MCP servers, what they spawned), ended when
   * the run is over. Left out, nothing beyond the sandbox is killed.
   */
  processes?: ProcessWatch;
}

export function defaultHostDeps(): HostDeps {
  return { spawnWorker: spawnSandboxWorker, broker: defaultBrokerDeps(), processes: createProcessWatch() };
}

/**
 * The child gets nothing from the parent's environment: no tokens, no `${VAR}`
 * values, no NODE_OPTIONS. (Windows needs SystemRoot to start at all.)
 */
export function buildWorkerEnv(parentEnv: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const env: Record<string, string> = {};
  if (process.platform === 'win32' && parentEnv.SystemRoot !== undefined) env.SystemRoot = parentEnv.SystemRoot;
  return env;
}

/** The parent's node flags (a loader such as tsx in development), minus the inspector, whose port the child would fight over. */
export function buildWorkerExecArgv(execArgv: readonly string[] = process.execArgv): string[] {
  return execArgv.filter((arg) => !/^--inspect/.test(arg));
}

const STDERR_TAIL_BYTES = 4096;
const KILL_WAIT_MS = 2000;
/** How long closing the sessions may take once the processes behind them were ended. */
const FORCED_CLOSE_MS = 1000;

/** Start the child as `mcpkit _sandbox-worker`, found the way `runtime _host` is: via the running CLI entry. */
export function spawnSandboxWorker(): WorkerHandle {
  const entry = process.argv[1];
  if (!entry) throw new Error('cannot locate the mcpkit entry point to start the sandbox');

  const child: ChildProcess = fork(entry, ['_sandbox-worker'], {
    env: buildWorkerEnv(),
    execArgv: buildWorkerExecArgv(),
    stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
    serialization: 'json',
  });

  let tail = '';
  child.stderr?.on('data', (chunk: Buffer) => {
    tail = (tail + chunk.toString('utf-8')).slice(-STDERR_TAIL_BYTES);
  });

  const gone = (): boolean => child.exitCode !== null || child.signalCode !== null;

  return {
    // The callback keeps a closed channel from surfacing as an unhandled 'error' event.
    send: (message) => {
      child.send(message, () => undefined);
    },
    onMessage: (handler) => {
      child.on('message', handler);
    },
    onExit: (handler) => {
      child.once('exit', (code, signal) => handler(signal === null ? `exit code ${code}` : `signal ${signal}`));
      child.once('error', (error) => handler(error.message));
    },
    stderrTail: () => tail,
    kill: () => new Promise<void>((resolve) => {
      if (gone()) {
        resolve();
        return;
      }
      const timer = setTimeout(resolve, KILL_WAIT_MS);
      child.once('exit', () => {
        clearTimeout(timer);
        resolve();
      });
      child.kill('SIGKILL');
    }),
  };
}

type Outcome =
  | { ok: true; value: unknown; resultTruncated: boolean }
  | { ok: false; error: SandboxError };

function internal(message: string): Outcome {
  return { ok: false, error: { kind: 'internal', message } };
}

function interruption(signal: AbortSignal): Outcome {
  return {
    ok: false,
    error: { kind: 'interrupted', message: `interrupted${typeof signal.reason === 'string' ? ` by ${signal.reason}` : ''}` },
  };
}

function timeout(message: string): Outcome {
  return { ok: false, error: { kind: 'timeout', message } };
}

function outcomeOfDone(message: DoneMessage, limits: SandboxLimits): Outcome {
  if (!message.ok) {
    return { ok: false, error: { ...message.error, message: clampMessage(message.error.message) } };
  }
  if (message.resultTruncated) {
    return {
      ok: true,
      value: truncatedResultText(message.result, message.resultBytes, limits.maxOutputBytes),
      resultTruncated: true,
    };
  }
  try {
    return { ok: true, value: JSON.parse(message.result), resultTruncated: false };
  } catch {
    return internal('the sandbox sent a result that is not valid JSON');
  }
}

/**
 * What the script sees when a call fails: the broker's error. Anything else is a bug in the
 * broker, whose text may come from anywhere (a registry parser, a transport), so the script
 * gets a fixed sentence and the detail goes to the parent's stderr when MCPKIT_DEBUG=1.
 */
function callError(error: unknown, name: string): SandboxError {
  if (error instanceof BrokerError) {
    return { kind: error.kind, message: clampMessage(error.message), ...(error.tool === undefined ? {} : { tool: error.tool }) };
  }
  debugLog(`${name}: ${error instanceof Error ? error.stack ?? error.message : String(error)}`);
  return { kind: 'tool', message: `${name} failed unexpectedly (set MCPKIT_DEBUG=1 for details on stderr)`, tool: name };
}

/** Run one script and return its envelope. Never rejects; always leaves no child and no session behind. */
export async function runExec(request: ExecRequest, deps: HostDeps = defaultHostDeps()): Promise<ExecEnvelope> {
  const { limits, signal } = request;
  const logs = new LogBuffer(limits.maxOutputBytes);
  const deadline = Date.now() + limits.timeoutMs;
  const broker = new CallBroker({
    policy: request.policy,
    maxCalls: limits.maxCalls,
    deadline,
    deps: deps.broker,
    onBlocked: request.onBlocked,
  });
  /** Every call the child made that is not yet decided and settled, awaited by the script or not. */
  const inflight = new Set<Promise<void>>();
  /** What the sandbox says the run could not honour (see DoneMessage); in the envelope only when there is any. */
  let warnings: string[] = [];
  let worker: WorkerHandle | undefined;
  let timer: NodeJS.Timeout | undefined;
  let onAbort: (() => void) | undefined;
  /** False when the run ended any way but a clean success: then the processes are ended without waiting for them to close. */
  let graceful = false;

  const envelopeOf = (outcome: Outcome): ExecEnvelope => {
    const common = {
      logs: logs.result(),
      calls: broker.calls,
      blocked: broker.blocked,
      ...(warnings.length === 0 ? {} : { warnings }),
    };
    if (outcome.ok) {
      return {
        ok: true,
        result: outcome.value ?? null,
        ...common,
        truncated: outcome.resultTruncated || logs.truncated,
      };
    }
    return { ok: false, error: outcome.error, ...common, ...(logs.truncated ? { truncated: true as const } : {}) };
  };

  try {
    const child = deps.spawnWorker();
    worker = child;

    const outcome = await new Promise<Outcome>((resolve) => {
      let settled = false;
      const settle = (result: Outcome): void => {
        settled = true;
        resolve(result);
      };

      const answer = (message: CallMessage): void => {
        const name = `${message.server}.${message.tool}`;
        const pending: Promise<void> = broker.call(message.server, message.tool, message.args).then(
          (json): ParentMessage => ({ type: 'call-result', id: message.id, ok: true, json }),
          (error: unknown): ParentMessage => ({ type: 'call-result', id: message.id, ok: false, error: callError(error, name) }),
        ).then((reply) => {
          inflight.delete(pending);
          if (!settled) child.send(reply);
        });
        inflight.add(pending);
      };

      child.onMessage((raw) => {
        if (settled) return;
        let message: ChildMessage;
        try {
          message = parseChildMessage(raw, limits);
        } catch (error) {
          settle(internal(`the sandbox sent an invalid message: ${(error as Error).message}`));
          return;
        }
        if (message.type === 'log') {
          logs.add(message.line);
        } else if (message.type === 'logs-cut') {
          logs.noteCut();
        } else if (message.type === 'call') {
          answer(message);
        } else {
          if (message.logs !== undefined) logs.absorb(message.logs);
          warnings = (message.warnings ?? []).map(clampMessage);
          // Whatever the script did, a run that ends after its deadline has timed out.
          settle(Date.now() > deadline ? timeout(`the script ran past the time limit of ${limits.timeoutMs} ms`) : outcomeOfDone(message, limits));
        }
      });

      child.onExit((description) => {
        const stderr = child.stderrTail().trim();
        settle(internal(
          `the sandbox process exited unexpectedly (${description})${stderr === '' ? '' : `: ${clampMessage(stderr)}`}`,
        ));
      });

      // The sandbox ends the run itself at the deadline; this is for one that does not answer.
      timer = setTimeout(() => {
        settle(timeout(`the script ran past the time limit of ${limits.timeoutMs} ms and its sandbox was killed`));
      }, Math.max(0, deadline - Date.now()) + KILL_GRACE_MS);

      if (signal !== undefined) {
        const interrupted = (): void => settle(interruption(signal));
        if (signal.aborted) {
          interrupted();
        } else {
          onAbort = interrupted;
          signal.addEventListener('abort', onAbort, { once: true });
        }
      }

      child.send({ type: 'run', code: request.code, limits, deadline });
    });

    /**
     * The script is over, but calls it did not await may still be running (or still waiting for the
     * gate): wait for them, so `blocked` and `calls` are complete and a fire-and-forget write is
     * not cut off when the process exits. Only the time left in the run bounds the wait.
     */
    const waitForCalls = async (): Promise<Outcome> => {
      if (inflight.size === 0 || (signal?.aborted ?? false)) return outcome;
      let expiry: NodeJS.Timeout | undefined;
      let abort: (() => void) | undefined;
      const result = await Promise.race([
        (async () => {
          while (inflight.size > 0) await Promise.all([...inflight]);
          return 'settled' as const;
        })(),
        new Promise<'expired'>((resolve) => {
          expiry = setTimeout(() => resolve('expired'), Math.max(0, deadline - Date.now()));
        }),
        new Promise<'aborted'>((resolve) => {
          abort = () => resolve('aborted');
          signal?.addEventListener('abort', abort, { once: true });
        }),
      ]);
      clearTimeout(expiry);
      if (abort !== undefined) signal?.removeEventListener('abort', abort);
      if (result === 'aborted' && signal !== undefined) return interruption(signal);
      if (result === 'expired' && outcome.ok) {
        return timeout(
          `the script finished, but ${inflight.size} call(s) it did not await were still running at the time limit of ${limits.timeoutMs} ms`,
        );
      }
      return outcome;
    };

    const final = await waitForCalls();
    graceful = final.ok && inflight.size === 0 && !(signal?.aborted ?? false);
    return envelopeOf(final);
  } catch (error) {
    return envelopeOf(internal(`could not start the sandbox: ${error instanceof Error ? error.message : String(error)}`));
  } finally {
    clearTimeout(timer);
    if (onAbort !== undefined) signal?.removeEventListener('abort', onAbort);
    await shutDown(worker, broker, deps, graceful);
  }
}

/**
 * End the sandbox and close every session. After a clean success the servers are asked to exit
 * by closing their stdin (the SDK waits for them). Any other ending (time limit, interrupt,
 * failure) may leave a call stuck or a server frozen, and the SDK would wait seconds for each:
 * the process tree is ended directly first, so closing the sessions then returns at once.
 * Either way, a last sweep ends whatever is still running below this process.
 */
async function shutDown(worker: WorkerHandle | undefined, broker: CallBroker, deps: HostDeps, graceful: boolean): Promise<void> {
  // Read the tree before anything dies: a server that exits first leaves its children without a parent to be found through.
  deps.processes?.refresh();
  await worker?.kill();
  if (!graceful) await deps.processes?.reap(REAP_GRACE_MS);
  await broker.close(graceful ? undefined : FORCED_CLOSE_MS);
  // Whatever is left (a server that ignored its closed stdin, a grandchild that holds its pipes) is
  // ended too: nothing the run started outlives it.
  await deps.processes?.reap(0);
}
