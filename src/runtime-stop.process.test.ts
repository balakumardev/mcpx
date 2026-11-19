import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { stopRuntime, stopRuntimeDaemons } from './runtime-manager.js';
import {
  ensureRuntimeDir,
  getRuntimeClaimPath,
  getRuntimeLockPath,
  getRuntimeMetadataPath,
  getRuntimeSocketPath,
  isProcessRunning,
  type RuntimeRecord,
  writeRuntimeRecord,
} from './runtime-store.js';

/**
 * Stands in for a runtime host. It is started the way the real one is (`<script> runtime _host <name>`,
 * detached, so it leads a process group of its own) and has a child of its own, like the MCP server.
 * Its first line of output is the child's pid. With FAKE_IGNORE_TERM=1 it ignores SIGTERM.
 */
const FAKE_DAEMON = `
import { spawn } from 'node:child_process';
if (process.env.FAKE_IGNORE_TERM === '1') process.on('SIGTERM', () => {});
const child = spawn(process.execPath, ['-e', 'process.on("SIGTERM", () => {}); setInterval(() => {}, 1000)'], { stdio: 'ignore' });
console.log(child.pid);
setInterval(() => {}, 1000);
`;

/**
 * A host that is in the middle of a call: it accepts the stop request but only answers it after
 * three seconds, and then exits on its own. SIGTERM is recorded in a file.
 */
const FAKE_BUSY_DAEMON = `
import { rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
const [, , , , socketPath, recordPath, markerPath] = process.argv;
process.on('SIGTERM', () => { writeFileSync(markerPath, 'terminated'); process.exit(1); });
createServer((socket) => {
  socket.on('data', () => setTimeout(() => {
    socket.end('{"ok":true,"type":"stop"}\\n', () => { rmSync(recordPath, { force: true }); process.exit(0); });
  }, 3000));
}).listen(socketPath, () => console.log('ready'));
`;

describe('stopping every daemon recorded for a server', () => {
  const originalHome = process.env.HOME;
  let homeDir = '';
  let scriptPath = '';
  const spawned: number[] = [];
  const NAME = 'stopp';

  interface FakeDaemon { pid: number; childPid: number }

  async function startDaemon(options: { ignoreTerm?: boolean } = {}): Promise<FakeDaemon> {
    const child: ChildProcess = spawn(process.execPath, [scriptPath, 'runtime', '_host', NAME], {
      detached: true,
      stdio: ['ignore', 'pipe', 'ignore'],
      env: { ...process.env, FAKE_IGNORE_TERM: options.ignoreTerm ? '1' : '0' },
    });
    child.unref();
    const childPid = await new Promise<number>((resolve) => {
      child.stdout!.once('data', (chunk) => resolve(Number(String(chunk).trim())));
    });
    spawned.push(child.pid!, childPid);
    return { pid: child.pid!, childPid };
  }

  async function recordFor(pid: number): Promise<void> {
    const now = new Date().toISOString();
    const record: RuntimeRecord = {
      serverName: NAME,
      pid,
      socketPath: getRuntimeSocketPath(NAME),
      logPath: join(homeDir, 'unused.log'),
      fingerprint: 'fingerprint',
      startedAt: now,
      lastUsedAt: now,
      idleTimeoutSec: 60,
      callTimeoutSec: 30,
    };
    await writeRuntimeRecord(record);
  }

  const claimFor = (pid: number) => writeFile(
    getRuntimeClaimPath(NAME),
    JSON.stringify({ pid, startedAt: new Date().toISOString() }),
  );

  beforeEach(async () => {
    homeDir = await mkdtemp(join(tmpdir(), 'mcpkit-stop-'));
    process.env.HOME = homeDir;
    scriptPath = join(homeDir, 'fake-daemon.mjs');
    await writeFile(scriptPath, FAKE_DAEMON, 'utf-8');
    await ensureRuntimeDir();
  });

  afterEach(async () => {
    for (const pid of spawned.splice(0)) {
      try { process.kill(pid, 'SIGKILL'); } catch { /* already gone */ }
    }
    if (originalHome === undefined) delete process.env.HOME;
    else process.env.HOME = originalHome;
    await rm(homeDir, { recursive: true, force: true });
  });

  it('stops the daemon in the record and the one in the claim file, and reports that there were two', async () => {
    const recorded = await startDaemon();
    const claimed = await startDaemon();
    await recordFor(recorded.pid);
    await claimFor(claimed.pid);

    const result = await stopRuntimeDaemons(NAME);

    expect(result).toEqual({ found: true, daemons: [recorded.pid, claimed.pid], killed: [] });
    expect(isProcessRunning(recorded.pid)).toBe(false);
    expect(isProcessRunning(claimed.pid)).toBe(false);
    expect(existsSync(getRuntimeMetadataPath(NAME))).toBe(false);
    expect(existsSync(getRuntimeClaimPath(NAME))).toBe(false);
  }, 30_000);

  it('stops a daemon that is still starting (a claim and no record), which has no socket to ask', async () => {
    const starting = await startDaemon();
    await claimFor(starting.pid);

    const result = await stopRuntimeDaemons(NAME);

    expect(result).toEqual({ found: true, daemons: [starting.pid], killed: [] });
    expect(isProcessRunning(starting.pid)).toBe(false);
    expect(existsSync(getRuntimeClaimPath(NAME))).toBe(false);
  }, 30_000);

  it('kills a daemon that ignores SIGTERM together with its process group, so its MCP server is not left behind', async () => {
    const stubborn = await startDaemon({ ignoreTerm: true });
    await recordFor(stubborn.pid);

    const result = await stopRuntimeDaemons(NAME);

    expect(result).toEqual({ found: true, daemons: [stubborn.pid], killed: [stubborn.pid] });
    // The child ignores SIGTERM too: only the group kill reaches it.
    for (let waited = 0; waited < 3_000 && (isProcessRunning(stubborn.pid) || isProcessRunning(stubborn.childPid)); waited += 100) {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    expect(isProcessRunning(stubborn.pid)).toBe(false);
    expect(isProcessRunning(stubborn.childPid)).toBe(false);
    expect(existsSync(getRuntimeMetadataPath(NAME))).toBe(false);
  }, 30_000);

  it('never signals a pid that is no longer a runtime host: a record can outlive its daemon and the pid be reused', async () => {
    const stranger = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
    spawned.push(stranger.pid!);
    await recordFor(stranger.pid!);

    const result = await stopRuntimeDaemons(NAME);

    expect(result.found).toBe(true);
    expect(result.killed).toEqual([]);
    expect(isProcessRunning(stranger.pid!)).toBe(true);
    expect(existsSync(getRuntimeMetadataPath(NAME))).toBe(false);
  }, 30_000);

  it('cleans up the files of a daemon that is already dead, and says nothing was running', async () => {
    const gone = await startDaemon();
    process.kill(gone.pid, 'SIGKILL');
    process.kill(gone.childPid, 'SIGKILL');
    while (isProcessRunning(gone.pid)) await new Promise((resolve) => setTimeout(resolve, 20));
    await recordFor(gone.pid);
    await claimFor(gone.pid);

    expect(await stopRuntimeDaemons(NAME)).toEqual({ found: true, daemons: [], killed: [] });

    expect(existsSync(getRuntimeMetadataPath(NAME))).toBe(false);
    expect(existsSync(getRuntimeClaimPath(NAME))).toBe(false);
  });

  it('finds nothing to stop when no runtime is recorded, and still leaves the start lock to its holder', async () => {
    await writeFile(getRuntimeLockPath(NAME), 'held');

    expect(await stopRuntimeDaemons(NAME)).toEqual({ found: false, daemons: [], killed: [] });
    expect(await stopRuntime(NAME)).toBe(false);
    expect(existsSync(getRuntimeLockPath(NAME))).toBe(true);
  });

  it('waits for a host that is busy with a call to finish and stop itself, instead of terminating it mid-call', async () => {
    const markerPath = join(homeDir, 'sigterm-marker');
    const busyScript = join(homeDir, 'fake-busy-daemon.mjs');
    await writeFile(busyScript, FAKE_BUSY_DAEMON, 'utf-8');
    const busy = spawn(process.execPath, [busyScript, 'runtime', '_host', getRuntimeSocketPath(NAME), getRuntimeMetadataPath(NAME), markerPath], {
      detached: true,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    busy.unref();
    spawned.push(busy.pid!);
    await new Promise<void>((resolve) => busy.stdout!.once('data', () => resolve()));
    await recordFor(busy.pid!);

    const result = await stopRuntimeDaemons(NAME);

    expect(result).toEqual({ found: true, daemons: [busy.pid], killed: [] });
    expect(existsSync(markerPath)).toBe(false);
    expect(isProcessRunning(busy.pid!)).toBe(false);
  }, 30_000);
});
