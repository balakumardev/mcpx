import { createWriteStream, type WriteStream } from 'node:fs';
import { createServer, type Server, type Socket } from 'node:net';
import type { Readable } from 'node:stream';
import { connectToolSession, type ConnectedToolSession } from './client.js';
import { getServer } from './config.js';
import { isPersistentRuntimeEntry, resolveRuntimeConfig } from './runtime-config.js';
import type { RuntimeRequest, RuntimeResponse, RuntimeStatus } from './runtime-protocol.js';
import {
  computeRuntimeFingerprint,
  deleteRuntimeArtifacts,
  ensureRuntimeDir,
  getRuntimeLogPath,
  getRuntimeSocketPath,
  type RuntimeRecord,
  writeRuntimeRecord,
} from './runtime-store.js';

export interface RuntimeHostOptions {
  record: RuntimeRecord;
  session: ConnectedToolSession;
  logStream: WriteStream;
}

function transportStderrStream(transport: ConnectedToolSession['transport']): Readable | null {
  const maybeStream = (transport as { stderr?: Readable | null }).stderr;
  return maybeStream ?? null;
}

export class RuntimeHost {
  private readonly record: RuntimeRecord;
  private readonly session: ConnectedToolSession;
  private readonly logStream: WriteStream;
  private readonly server: Server;
  private queue: Promise<void> = Promise.resolve();
  private closePromise?: Promise<void>;
  private idleTimer?: NodeJS.Timeout;
  private lastUsedAt: string;
  private closed = false;
  private waitForCloseResolve: (() => void) | undefined;
  private readonly waitForClosePromise: Promise<void>;

  constructor(options: RuntimeHostOptions) {
    this.record = options.record;
    this.session = options.session;
    this.logStream = options.logStream;
    this.lastUsedAt = options.record.lastUsedAt;
    this.server = createServer((socket) => {
      this.handleSocket(socket);
    });
    this.waitForClosePromise = new Promise<void>((resolve) => {
      this.waitForCloseResolve = resolve;
    });
  }

  async start(): Promise<void> {
    await ensureRuntimeDir();

    if (process.platform !== 'win32') {
      await deleteRuntimeArtifacts(this.record.serverName);
    }

    const stderr = transportStderrStream(this.session.transport);
    if (stderr) {
      stderr.pipe(this.logStream, { end: false });
    }

    await new Promise<void>((resolve, reject) => {
      this.server.once('error', reject);
      this.server.listen(this.record.socketPath, () => {
        this.server.off('error', reject);
        resolve();
      });
    });

    await writeRuntimeRecord(this.record);
    this.resetIdleTimer();
  }

  async waitUntilClosed(): Promise<void> {
    await this.waitForClosePromise;
  }

  getStatus(): RuntimeStatus {
    return {
      serverName: this.record.serverName,
      pid: this.record.pid,
      socketPath: this.record.socketPath,
      logPath: this.record.logPath,
      fingerprint: this.record.fingerprint,
      startedAt: this.record.startedAt,
      lastUsedAt: this.lastUsedAt,
      idleTimeoutSec: this.record.idleTimeoutSec,
      running: !this.closed,
      configStatus: 'current',
    };
  }

  async close(): Promise<void> {
    if (this.closePromise) return this.closePromise;

    this.closePromise = (async () => {
      if (this.closed) return;
      this.closed = true;
      this.clearIdleTimer();

      await new Promise<void>((resolve) => {
        this.server.close(() => resolve());
      });
      await this.session.close();
      await deleteRuntimeArtifacts(this.record.serverName);
      this.logStream.end();
      this.waitForCloseResolve?.();
    })();

    return this.closePromise;
  }

  private handleSocket(socket: Socket): void {
    let buffer = '';

    socket.on('data', (chunk) => {
      buffer += chunk.toString();

      while (buffer.includes('\n')) {
        const newlineIndex = buffer.indexOf('\n');
        const line = buffer.slice(0, newlineIndex).trim();
        buffer = buffer.slice(newlineIndex + 1);
        if (!line) continue;

        let request: RuntimeRequest;
        try {
          request = JSON.parse(line) as RuntimeRequest;
        } catch {
          this.writeResponse(socket, {
            requestId: 'unknown',
            ok: false,
            error: 'Invalid runtime request payload.',
          });
          continue;
        }

        void this.dispatchRequest(socket, request);
      }
    });
  }

  private async dispatchRequest(socket: Socket, request: RuntimeRequest): Promise<void> {
    const task = request.type === 'status'
      ? this.handleRequest(request)
      : this.enqueue(() => this.handleRequest(request));

    try {
      const response = await task;
      this.writeResponse(socket, response);
      if (request.type === 'stop') {
        setImmediate(() => {
          void this.close();
        });
      }
    } catch (error) {
      this.writeResponse(socket, {
        requestId: request.requestId,
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  private enqueue<T>(task: () => Promise<T>): Promise<T> {
    const run = this.queue.then(task, task);
    this.queue = run.then(() => undefined, () => undefined);
    return run;
  }

  private async handleRequest(request: RuntimeRequest): Promise<RuntimeResponse> {
    switch (request.type) {
      case 'status':
        return {
          requestId: request.requestId,
          ok: true,
          type: 'status',
          status: this.getStatus(),
        };
      case 'stop':
        return {
          requestId: request.requestId,
          ok: true,
          type: 'stop',
        };
      case 'call': {
        if (request.calls.length === 0) {
          throw new Error('Runtime call request must include at least one tool call.');
        }

        this.clearIdleTimer();
        try {
          const results = request.calls.length === 1
            ? [await this.session.callTool(request.calls[0].toolName, request.calls[0].params)]
            : await this.session.callToolsChained(request.calls);
          await this.touch();
          return {
            requestId: request.requestId,
            ok: true,
            type: 'call',
            results,
          };
        } finally {
          this.resetIdleTimer();
        }
      }
    }
  }

  private async touch(): Promise<void> {
    this.lastUsedAt = new Date().toISOString();
    await writeRuntimeRecord({
      ...this.record,
      lastUsedAt: this.lastUsedAt,
    });
  }

  private clearIdleTimer(): void {
    if (this.idleTimer) {
      clearTimeout(this.idleTimer);
      this.idleTimer = undefined;
    }
  }

  private resetIdleTimer(): void {
    this.clearIdleTimer();
    this.idleTimer = setTimeout(() => {
      void this.close();
    }, this.record.idleTimeoutSec * 1000);
    this.idleTimer.unref?.();
  }

  private writeResponse(socket: Socket, response: RuntimeResponse): void {
    if (socket.destroyed) return;
    socket.end(`${JSON.stringify(response)}\n`);
  }
}

export async function createRuntimeHostForServer(serverName: string): Promise<RuntimeHost> {
  const entry = await getServer(serverName);
  if (!entry) {
    throw new Error(`Server "${serverName}" not found.`);
  }
  if (!isPersistentRuntimeEntry(entry)) {
    throw new Error(`Server "${serverName}" is not configured for a persistent stdio runtime.`);
  }

  const runtime = resolveRuntimeConfig(entry.runtime);
  const fingerprint = computeRuntimeFingerprint(entry);
  const now = new Date().toISOString();
  const logPath = getRuntimeLogPath(serverName);
  await ensureRuntimeDir();
  const session = await connectToolSession(entry.transport, undefined, entry.paramProvider);
  const logStream = createWriteStream(logPath, { flags: 'a' });

  const host = new RuntimeHost({
    record: {
      serverName,
      pid: process.pid,
      socketPath: getRuntimeSocketPath(serverName),
      logPath,
      fingerprint,
      startedAt: now,
      lastUsedAt: now,
      idleTimeoutSec: runtime.idleTimeoutSec,
    },
    session,
    logStream,
  });

  await host.start();
  return host;
}
