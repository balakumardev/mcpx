import type { ToolCall } from './client.js';

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
      results: string[];
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
