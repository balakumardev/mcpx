import type { LogAccount } from './protocol.js';

/** Run limits of `mcpkit exec`, and the helpers that enforce the output ones. */
export interface SandboxLimits {
  /** Wall clock for the whole script, in milliseconds. */
  timeoutMs: number;
  /** QuickJS heap limit, in MiB. */
  memoryMb: number;
  /** Cap, in bytes, applied separately to the serialised result and to the total logs. */
  maxOutputBytes: number;
  /** How many `mcp.*` calls the script may make. */
  maxCalls: number;
}

export const DEFAULT_LIMITS: SandboxLimits = {
  timeoutMs: 120_000,
  memoryMb: 256,
  maxOutputBytes: 102_400,
  maxCalls: 200,
};

/** The WASM linear memory tops out at 2 GiB; asking QuickJS for more is an abort, not an error. */
export const MAX_MEMORY_MB = 1024;
export const MIN_MEMORY_MB = 8;
export const MIN_OUTPUT_BYTES = 256;
/** The result and the logs each travel to the parent as one JSON string; far beyond this is a typo, not a need. */
export const MAX_OUTPUT_BYTES = 64 * 1024 * 1024;
/** Each call is a round trip to a server; a script that needs more is a program, not a batch. */
export const MAX_CALLS_CEILING = 100_000;
/** Starting the sandbox (a new node process and the WASM) takes a few hundred ms of the time limit. */
export const MIN_TIMEOUT_MS = 100;
/**
 * QuickJS stack limit. Not 1 MiB: V8's own stack (about 1 MB) runs out first, which throws
 * out of the WASM and leaves the VM unusable instead of raising a catchable "stack overflow".
 */
export const STACK_BYTES = 256 * 1024;

/** Calls the parent runs against MCP servers at the same time. */
export const MAX_CONCURRENT_CALLS = 8;
/** Largest JSON text of the arguments of one tool call. */
export const MAX_ARGS_BYTES = 1024 * 1024;
/** Largest JSON text of one tool result handed back to the script. */
export const MAX_CALL_RESULT_BYTES = 16 * 1024 * 1024;
/** Largest script accepted from a file, stdin or --code. */
export const MAX_CODE_BYTES = 1024 * 1024;
/** Longest server or tool name accepted from the child. */
export const MAX_NAME_CHARS = 1024;
/** One captured console line is cut to this many characters before it leaves the VM. */
export const MAX_LOG_LINE_CHARS = 65_536;
/** Error messages in the envelope are cut to this many characters. */
export const MAX_ERROR_MESSAGE_CHARS = 8192;

/**
 * Time the parent waits after the deadline for the sandbox to report the timeout itself (with a
 * clearer message) before it kills the sandbox. Anything the sandbox reports after the deadline
 * is a timeout whatever it says.
 */
export const KILL_GRACE_MS = 500;
/** How long the MCP server processes get to exit on SIGTERM when a run is over for good, before SIGKILL. */
export const REAP_GRACE_MS = 300;
/**
 * Largest accepted `--timeout`. Node timers cannot exceed 2^31 - 1 ms (a longer one fires
 * at once), and the parent's kill timer is the timeout plus KILL_GRACE_MS.
 */
export const MAX_TIMEOUT_MS = 2_147_483_647 - KILL_GRACE_MS - 1;
/** Time the sandbox allows itself to serialise the result once the script has finished. */
export const EXTRACT_WINDOW_MS = 2000;

/** Cut `text` to at most `maxBytes` bytes of UTF-8 without splitting a character. */
export function truncateUtf8(text: string, maxBytes: number): string {
  const bytes = Buffer.from(text, 'utf-8');
  if (bytes.length <= maxBytes) return text;
  let end = maxBytes;
  while (end > 0 && (bytes[end] & 0xc0) === 0x80) end--;
  return bytes.subarray(0, end).toString('utf-8');
}

/** Cut an error message to MAX_ERROR_MESSAGE_CHARS, keeping its start. */
export function clampMessage(message: string): string {
  return message.length <= MAX_ERROR_MESSAGE_CHARS
    ? message
    : `${message.slice(0, MAX_ERROR_MESSAGE_CHARS)}... [message truncated]`;
}

export interface CappedResult {
  /** The JSON text itself when it fits, else the first `maxBytes` bytes of it. */
  text: string;
  truncated: boolean;
  /** Size of the full JSON text in bytes. */
  totalBytes: number;
}

export function capResult(json: string, maxBytes: number): CappedResult {
  const totalBytes = Buffer.byteLength(json, 'utf-8');
  if (totalBytes <= maxBytes) return { text: json, truncated: false, totalBytes };
  return { text: truncateUtf8(json, maxBytes), truncated: true, totalBytes };
}

/** The value `result` takes in the envelope when the serialised result was cut. */
export function truncatedResultText(prefix: string, totalBytes: number, maxBytes: number): string {
  return `${prefix}\n[truncated: the result is ${totalBytes} bytes, the limit is ${maxBytes}]`;
}

/**
 * Keeps console lines up to a byte budget and counts what it cuts. The child and the parent
 * each keep one: the child so it stops sending lines once the budget is spent, the parent
 * because it must not trust what the child sends. The child reports its counts in `done`, and
 * the parent adds them to its own (`absorb`), so the envelope says how much is missing.
 */
export class LogBuffer {
  private readonly lines: string[] = [];
  private used = 0;
  private full = false;
  private droppedLines = 0;
  private shortenedLines = 0;
  private removedBytes = 0;
  /** The sandbox said it cut lines but has not (yet) said how many. */
  private cutUncounted = false;

  constructor(private readonly maxBytes: number) {}

  /**
   * The line to keep (shortened when it hits the budget), or undefined when it was dropped.
   * `originalChars` is the length of the line before the caller shortened it, when it did.
   */
  add(line: string, originalChars: number = line.length): string | undefined {
    const size = Buffer.byteLength(line, 'utf-8');
    // Characters stand in for the bytes of a part the caller already cut off: that text is gone too.
    const cutBefore = Math.max(0, originalChars - line.length);

    let kept: string | undefined;
    if (!this.full) {
      if (this.used + size <= this.maxBytes) {
        kept = line;
      } else {
        this.full = true;
        const part = truncateUtf8(line, this.maxBytes - this.used);
        kept = part === '' ? undefined : part;
      }
    }
    if (kept === undefined) {
      this.droppedLines++;
      this.removedBytes += size + cutBefore;
      return undefined;
    }

    const keptBytes = Buffer.byteLength(kept, 'utf-8');
    this.lines.push(kept);
    this.used += keptBytes;
    const removed = cutBefore + size - keptBytes;
    if (removed > 0) {
      this.shortenedLines++;
      this.removedBytes += removed;
    }
    return kept;
  }

  /** Anything was cut: a line dropped, a line shortened, or the sandbox said so. */
  get truncated(): boolean {
    return this.full || this.droppedLines > 0 || this.shortenedLines > 0 || this.cutUncounted;
  }

  /** What was cut so far. */
  get account(): LogAccount {
    return { droppedLines: this.droppedLines, shortenedLines: this.shortenedLines, removedBytes: this.removedBytes };
  }

  /** The sandbox cut lines that this buffer never saw; `account` follows at the end of the run. */
  noteCut(): void {
    if (!this.truncated) this.cutUncounted = true;
  }

  /** Add the counts of a buffer that cut lines before they reached this one. */
  absorb(account: LogAccount): void {
    this.droppedLines += account.droppedLines;
    this.shortenedLines += account.shortenedLines;
    this.removedBytes += account.removedBytes;
    this.cutUncounted = false;
  }

  /** The kept lines, plus a final marker line when something was cut. */
  result(): string[] {
    if (!this.truncated) return [...this.lines];
    const counted = this.droppedLines > 0 || this.shortenedLines > 0;
    return [
      ...this.lines,
      counted
        ? `[logs truncated: the limit is ${this.maxBytes} bytes; ${this.droppedLines} line(s) dropped, ${this.shortenedLines} line(s) shortened, about ${this.removedBytes} byte(s) removed in all]`
        : `[logs truncated: the limit is ${this.maxBytes} bytes; some lines were cut before the sandbox could count them]`,
    ];
  }
}
