import type { ToolCall } from './client.js';

/**
 * Version of the socket protocol and of what a host does with a call. It is part of the runtime
 * fingerprint (runtime-store.ts), so a host started by an older mcpkit never matches the
 * fingerprint of this one: the CLI stops it and starts a new host before it sends any call. That
 * has to happen first because a call cannot be retried once it ran (tools may not be idempotent)
 * and an older host's reply may not say whether the tool failed. Bump it whenever a change here
 * would make an older host unsafe to talk to, or this one unsafe for an older CLI.
 *
 * The comparison is by equality, so it cuts both ways: a host of a NEWER protocol has a fingerprint
 * this CLI does not recognise either, and is stopped and replaced in the same way, without a message.
 * A call that host is running gets about five seconds to finish before the host is terminated. Two
 * mcpkit versions that share a home therefore replace each other's host on every other call, which
 * costs a start each time but never runs a call on a host that cannot report its outcome.
 *
 * 1: v0.1.29 and earlier, which did not fingerprint it. 2: call replies carry `values` and `isError`.
 * 3: call replies carry `omitted`, what each result's plain text leaves out (images, audio, resources).
 */
export const RUNTIME_PROTOCOL_VERSION = 3;

export interface RuntimeStatus {
  serverName: string;
  pid: number;
  socketPath: string;
  logPath: string;
  fingerprint: string;
  startedAt: string;
  lastUsedAt: string;
  idleTimeoutSec: number;
  callTimeoutSec: number;
  running: boolean;
  configStatus?: 'current' | 'stale';
  /** No registered server has this name, so nothing can say whether the runtime's configuration is current. */
  orphaned?: boolean;
  /** Live daemons recorded for the same server besides `pid`. A server runs one daemon, so any are leftovers. */
  otherPids?: number[];
}

export type RuntimeRequest =
  | {
      requestId: string;
      type: 'call';
      calls: ToolCall[];
    }
  | {
      requestId: string;
      type: 'status';
    }
  | {
      requestId: string;
      type: 'stop';
    };

export type RuntimeResponse =
  | {
      requestId: string;
      ok: true;
      type: 'call';
      /** Printable text of each executed call. A chain stops at its first failed call. */
      results: string[];
      /** Normalised value of each executed call, for `call --json`. */
      values: unknown[];
      /**
       * What the text of each executed call leaves out (`ToolCallOutput.omitted`): one list per call,
       * empty when nothing was left out. Every host of protocol 3 sends it; a reply without it is read
       * as nothing omitted.
       */
      omitted?: string[][];
      /** The last executed call reported `isError`. */
      isError: boolean;
    }
  | {
      requestId: string;
      ok: true;
      type: 'status';
      status: RuntimeStatus;
    }
  | {
      requestId: string;
      ok: true;
      type: 'stop';
    }
  | {
      requestId: string;
      ok: false;
      error: string;
    };
