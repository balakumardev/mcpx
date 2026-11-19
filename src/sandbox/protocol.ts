import {
  MAX_ARGS_BYTES,
  MAX_ERROR_MESSAGE_CHARS,
  MAX_LOG_LINE_CHARS,
  MAX_NAME_CHARS,
  type SandboxLimits,
} from './limits.js';

/**
 * Messages on the fork IPC channel between `mcpkit exec` (the parent, which
 * holds every credential and MCP session) and its sandbox child.
 *
 * The child runs agent-written code, so everything it sends is untrusted input
 * and goes through `parseChildMessage`. The child checks what the parent sends
 * too, but the parent is trusted.
 */

export type ErrorKind = 'script' | 'tool' | 'blocked' | 'timeout' | 'limit' | 'interrupted' | 'internal';

export const ERROR_KINDS: readonly ErrorKind[] = ['script', 'tool', 'blocked', 'timeout', 'limit', 'interrupted', 'internal'];

/**
 * The kinds that may cross the IPC channel in either direction. `interrupted` is the parent's
 * own verdict (it received SIGINT or SIGTERM): the sandbox never reports it, and the parent
 * never sends it to the sandbox.
 */
export const RELAYED_ERROR_KINDS: readonly ErrorKind[] = ERROR_KINDS.filter((kind) => kind !== 'interrupted');

export interface SandboxError {
  kind: ErrorKind;
  message: string;
  /** `server.tool`, for errors that belong to one call. */
  tool?: string;
}

// Parent -> child

export interface RunRequest {
  type: 'run';
  code: string;
  limits: SandboxLimits;
  /**
   * When the run's wall clock ends (epoch ms). The parent started the clock before the sandbox
   * process existed, so both sides count from the same instant instead of from "now".
   */
  deadline: number;
}

export type CallResponse =
  | { type: 'call-result'; id: number; ok: true; json: string }
  | { type: 'call-result'; id: number; ok: false; error: SandboxError };

export type ParentMessage = RunRequest | CallResponse;

// Child -> parent

export interface LogMessage {
  type: 'log';
  line: string;
}

export interface CallMessage {
  type: 'call';
  id: number;
  server: string;
  tool: string;
  /** JSON text of the arguments object. */
  args: string;
}

/** The first console line the sandbox could not keep whole: `truncated` is true from here on, even if the sandbox is killed before it can count. */
export interface LogsCutMessage {
  type: 'logs-cut';
}

/** What the sandbox's own log budget cut, counted at the end of the run. */
export interface LogAccount {
  droppedLines: number;
  shortenedLines: number;
  removedBytes: number;
}

interface DoneExtras {
  logs?: LogAccount;
  /** Things the script did that the run could not honour, such as calls started after it returned. */
  warnings?: string[];
}

export type DoneMessage =
  | ({
    type: 'done';
    ok: true;
    /** The JSON text of the result, or when `resultTruncated` its first bytes. */
    result: string;
    resultTruncated: boolean;
    /** Size in bytes of the full JSON text of the result. */
    resultBytes: number;
  } & DoneExtras)
  | ({ type: 'done'; ok: false; error: SandboxError } & DoneExtras);

export type ChildMessage = LogMessage | LogsCutMessage | CallMessage | DoneMessage;

export class ProtocolError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ProtocolError';
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function fail(message: string): never {
  throw new ProtocolError(message);
}

function asString(value: unknown, field: string, maxChars: number, minChars = 0): string {
  if (typeof value !== 'string') return fail(`${field} must be a string`);
  if (value.length < minChars) return fail(`${field} must not be empty`);
  if (value.length > maxChars) return fail(`${field} is too long (${value.length} characters, limit ${maxChars})`);
  return value;
}

function asId(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    return fail('id must be a non-negative integer');
  }
  return value;
}

function asBoolean(value: unknown, field: string): boolean {
  if (typeof value !== 'boolean') return fail(`${field} must be a boolean`);
  return value;
}

function asCount(value: unknown, field: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    return fail(`${field} must be a non-negative integer`);
  }
  return value;
}

function asSandboxError(value: unknown): SandboxError {
  if (!isRecord(value)) return fail('error must be an object');
  const kind = value.kind;
  if (typeof kind !== 'string' || !RELAYED_ERROR_KINDS.includes(kind as ErrorKind)) {
    return fail('error.kind is not a known kind');
  }
  const message = asString(value.message, 'error.message', MAX_ERROR_MESSAGE_CHARS * 2);
  const error: SandboxError = { kind: kind as ErrorKind, message };
  if (value.tool !== undefined) error.tool = asString(value.tool, 'error.tool', MAX_NAME_CHARS * 2 + 1);
  return error;
}

function asLogAccount(value: unknown): LogAccount | undefined {
  if (value === undefined) return undefined;
  if (!isRecord(value)) return fail('logs must be an object');
  return {
    droppedLines: asCount(value.droppedLines, 'logs.droppedLines'),
    shortenedLines: asCount(value.shortenedLines, 'logs.shortenedLines'),
    removedBytes: asCount(value.removedBytes, 'logs.removedBytes'),
  };
}

const MAX_WARNINGS = 20;

function asWarnings(value: unknown): string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.length > MAX_WARNINGS) return fail(`warnings must be an array of at most ${MAX_WARNINGS} strings`);
  return value.map((warning) => asString(warning, 'warning', MAX_ERROR_MESSAGE_CHARS));
}

/** The optional parts of a `done` message, left out of the parsed message when the sandbox sent none. */
function doneExtras(raw: Record<string, unknown>): DoneExtras {
  const logs = asLogAccount(raw.logs);
  const warnings = asWarnings(raw.warnings);
  return { ...(logs === undefined ? {} : { logs }), ...(warnings === undefined ? {} : { warnings }) };
}

/** Validate one message received from the sandbox child. Throws ProtocolError. */
export function parseChildMessage(raw: unknown, limits: Pick<SandboxLimits, 'maxOutputBytes'>): ChildMessage {
  if (!isRecord(raw)) return fail('message must be an object');

  switch (raw.type) {
    case 'log':
      return { type: 'log', line: asString(raw.line, 'line', MAX_LOG_LINE_CHARS) };

    case 'logs-cut':
      return { type: 'logs-cut' };

    case 'call': {
      const args = asString(raw.args, 'args', MAX_ARGS_BYTES);
      if (Buffer.byteLength(args, 'utf-8') > MAX_ARGS_BYTES) {
        return fail(`args are too large (limit ${MAX_ARGS_BYTES} bytes)`);
      }
      return {
        type: 'call',
        id: asId(raw.id),
        server: asString(raw.server, 'server', MAX_NAME_CHARS, 1),
        tool: asString(raw.tool, 'tool', MAX_NAME_CHARS, 1),
        args,
      };
    }

    case 'done': {
      if (asBoolean(raw.ok, 'ok')) {
        const result = asString(raw.result, 'result', limits.maxOutputBytes);
        if (Buffer.byteLength(result, 'utf-8') > limits.maxOutputBytes) {
          return fail(`result is larger than the output limit (${limits.maxOutputBytes} bytes)`);
        }
        return {
          type: 'done',
          ok: true,
          result,
          resultTruncated: asBoolean(raw.resultTruncated, 'resultTruncated'),
          resultBytes: asCount(raw.resultBytes, 'resultBytes'),
          ...doneExtras(raw),
        };
      }
      return { type: 'done', ok: false, error: asSandboxError(raw.error), ...doneExtras(raw) };
    }

    default:
      return fail('unknown message type');
  }
}

function asLimits(value: unknown): SandboxLimits {
  if (!isRecord(value)) return fail('limits must be an object');
  return {
    timeoutMs: asCount(value.timeoutMs, 'limits.timeoutMs'),
    memoryMb: asCount(value.memoryMb, 'limits.memoryMb'),
    maxOutputBytes: asCount(value.maxOutputBytes, 'limits.maxOutputBytes'),
    maxCalls: asCount(value.maxCalls, 'limits.maxCalls'),
  };
}

/** Validate one message received from the parent. Throws ProtocolError. */
export function parseParentMessage(raw: unknown): ParentMessage {
  if (!isRecord(raw)) return fail('message must be an object');

  switch (raw.type) {
    case 'run':
      return {
        type: 'run',
        code: asString(raw.code, 'code', Number.MAX_SAFE_INTEGER),
        limits: asLimits(raw.limits),
        deadline: asCount(raw.deadline, 'deadline'),
      };

    case 'call-result': {
      const id = asId(raw.id);
      if (asBoolean(raw.ok, 'ok')) {
        return { type: 'call-result', id, ok: true, json: asString(raw.json, 'json', Number.MAX_SAFE_INTEGER) };
      }
      return { type: 'call-result', id, ok: false, error: asSandboxError(raw.error) };
    }

    default:
      return fail('unknown message type');
  }
}
