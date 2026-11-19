import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getRuntimeStatus, listPersistentRuntimeStatuses, stopRuntimeDaemons } from './runtime-manager.js';
import {
  ensureRuntimeDir,
  getRuntimeLogPath,
  getRuntimeMetadataPath,
  getRuntimeSocketPath,
  isProcessRunning,
  writeRuntimeRecord,
} from './runtime-store.js';

/** Looks to `ps` like the host the old CLI started for a server with a space in its name. */
const ODD_DAEMON = 'setInterval(() => {}, 1000)';

describe('runtime records whose server name is not a valid one', () => {
  const originalHome = process.env.HOME;
  let homeDir = '';
  const spawned: ChildProcess[] = [];

  async function recordNamed(serverName: string, pid: number): Promise<void> {
    const now = new Date().toISOString();
    await writeRuntimeRecord({
      serverName,
      pid,
      socketPath: getRuntimeSocketPath(serverName),
      logPath: getRuntimeLogPath(serverName),
      fingerprint: 'fingerprint',
      startedAt: now,
      lastUsedAt: now,
      idleTimeoutSec: 60,
      callTimeoutSec: 30,
    });
  }

  async function registerServer(name: string): Promise<void> {
    const now = new Date().toISOString();
    await mkdir(join(homeDir, '.mcpkit'), { recursive: true });
    await writeFile(join(homeDir, '.mcpkit', 'servers.yaml'), [
      'version: 1',
      'servers:',
      `  ${name}:`,
      `    name: ${name}`,
      '    transport:',
      '      type: stdio',
      '      command: node',
      '      args: []',
      '    runtime:',
      '      mode: persistent',
      '    toolCount: 1',
      '    agents: [cursor]',
      `    createdAt: ${now}`,
      `    updatedAt: ${now}`,
      '',
    ].join('\n'), 'utf-8');
  }

  beforeEach(async () => {
    homeDir = await mkdtemp(join(tmpdir(), 'mcpkit-orphan-'));
    process.env.HOME = homeDir;
    await ensureRuntimeDir();
  });

  afterEach(async () => {
    for (const child of spawned.splice(0)) child.kill('SIGKILL');
    if (originalHome === undefined) delete process.env.HOME;
    else process.env.HOME = originalHome;
    await rm(homeDir, { recursive: true, force: true });
  });

  it('lists every runtime, the orphan among them, instead of failing the whole listing', async () => {
    await registerServer('registered');
    await recordNamed('registered', process.pid);
    await recordNamed('my server', process.pid);

    const statuses = await listPersistentRuntimeStatuses();

    expect(statuses.map((status) => status.serverName).sort()).toEqual(['my server', 'registered']);
    expect(statuses.find((status) => status.serverName === 'my server')).toMatchObject({ orphaned: true });
    expect(statuses.find((status) => status.serverName === 'registered')?.orphaned).toBeUndefined();
  });

  it('also marks a runtime whose valid name is no longer registered, as an orphan', async () => {
    await recordNamed('removed-server', process.pid);

    expect(await listPersistentRuntimeStatuses()).toEqual([expect.objectContaining({ serverName: 'removed-server', orphaned: true })]);
  });

  it('reports the status of an odd-named runtime by its exact name', async () => {
    await recordNamed('my server', process.pid);

    expect(await getRuntimeStatus('my server')).toMatchObject({ serverName: 'my server', pid: process.pid });
  });

  it('stops an orphaned daemon whose record has an odd name, by the pid in the record', async () => {
    const daemon = spawn(process.execPath, ['-e', ODD_DAEMON, 'runtime', '_host', 'my server'], { detached: true, stdio: 'ignore' });
    daemon.unref();
    spawned.push(daemon);
    await recordNamed('my server', daemon.pid!);

    const result = await stopRuntimeDaemons('my server');

    expect(result).toEqual({ found: true, daemons: [daemon.pid], killed: [] });
    expect(isProcessRunning(daemon.pid!)).toBe(false);
    expect(existsSync(getRuntimeMetadataPath('my server'))).toBe(false);
  }, 30_000);
});
