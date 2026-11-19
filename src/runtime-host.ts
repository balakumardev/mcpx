import { once } from 'node:events';
import { createWriteStream, type WriteStream } from 'node:fs';
import { chmod, rm } from 'node:fs/promises';
import { createServer, type Server, type Socket } from 'node:net';
import type { Readable } from 'node:stream';
import { connectToolSession, type ConnectedToolSession } from './client.js';
import { getServer } from './config.js';
import { claimRuntime, RuntimeAlreadyRunningError, socketAnswers } from './runtime-claim.js';
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
    // The MCP server process is the reason this host exists: when it exits, stop too, so
    // the next call starts a fresh pair instead of talking to a dead one until the idle timeout.
    this.session.client.onclose = () => this.handleSessionClosed();
    this.server = createServer((socket) => {
      this.handleSocket(socket);
    });
    this.waitForClosePromise = new Promise<void>((resolve) => {
      this.waitForCloseResolve = resolve;
    });
  }

  async start(): Promise<void> {
    await ensureRuntimeDir();
    await this.protectLog();

    const stderr = transportStderrStream(this.session.transport);
    if (stderr) {
      stderr.pipe(this.logStream, { end: false });
    }

    await this.bindSocket();
    // The socket runs tools with the user's credentials: nobody else may connect to it.
    await chmod(this.record.socketPath, 0o600).catch(() => undefined);

    await writeRuntimeRecord(this.record);
    this.resetIdleTimer();
  }

  /** The log can hold request data. One that exists with wider permissions (an older release's) is tightened. */
  private async protectLog(): Promise<void> {
    try {
      if (this.logStream.pending) await once(this.logStream, 'open');
      await chmod(this.record.logPath, 0o600);
    } catch {
      // A log that cannot be opened is reported by the stream itself.
    }
  }

  /**
   * Listen on the runtime socket, never taking over one that is in use. A path that something
   * answers on belongs to a live host and makes this one give up (RuntimeAlreadyRunningError);
   * only a socket file nobody listens on is a leftover that can be replaced.
   */
  private async bindSocket(): Promise<void> {
    const { socketPath, serverName } = this.record;
    try {
      await this.listenOn(socketPath);
      return;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EADDRINUSE') throw error;
    }
    // A named pipe cannot be unlinked: when its name is taken, something is serving it.
    if (process.platform === 'win32' || await socketAnswers(socketPath)) {
      throw new RuntimeAlreadyRunningError(serverName);
    }
    await rm(socketPath, { force: true });
    await this.listenOn(socketPath);
  }

  private listenOn(socketPath: string): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      this.server.once('error', reject);
      this.server.listen(socketPath, () => {
        this.server.off('error', reject);
        resolve();
      });
    });
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
      callTimeoutSec: this.record.callTimeoutSec,
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
      await deleteRuntimeArtifacts(this.record.serverName, { pids: [this.record.pid], keepSocket: true });
      await new Promise<void>((resolve) => this.logStream.end(resolve));
      this.waitForCloseResolve?.();
    })();

    return this.closePromise;
  }

  private handleSessionClosed(): void {
    if (this.closed) return;
    this.logStream.write(`${new Date().toISOString()} MCP server process exited; stopping the runtime.\n`);
    void this.close();
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

        if (this.closed) {
          throw new Error(`The runtime for "${this.record.serverName}" has stopped. Run the call again to start a new one.`);
        }

        this.clearIdleTimer();
        try {
          const outputs = request.calls.length === 1
            ? [await this.session.callTool(request.calls[0].toolName, request.calls[0].params)]
            : await this.session.callToolsChained(request.calls);
          await this.touch();
          return {
            requestId: request.requestId,
            ok: true,
            type: 'call',
            results: outputs.map((output) => output.text),
            values: outputs.map((output) => output.value),
            omitted: outputs.map((output) => output.omitted ?? []),
            isError: outputs.some((output) => output.isError),
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
  // Before anything is started: a host that is not the only one for this server exits here with
  // RuntimeAlreadyRunningError, having started no MCP server and touched none of the owner's files.
  await claimRuntime(serverName);

  let session: ConnectedToolSession;
  try {
    session = await connectToolSession(
      entry.transport,
      undefined,
      entry.paramProvider,
      entry.envHints,
      { timeoutMs: runtime.callTimeoutSec * 1000 },
    );
  } catch (error) {
    await deleteRuntimeArtifacts(serverName, { pids: [process.pid], keepSocket: true });
    throw error;
  }

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
      callTimeoutSec: runtime.callTimeoutSec,
    },
    session,
    logStream: createWriteStream(logPath, { flags: 'a', mode: 0o600 }),
  });

  try {
    await host.start();
    return host;
  } catch (error) {
    // Closes the MCP server this host started, and gives back its claim.
    await host.close();
    throw error;
  }
}
