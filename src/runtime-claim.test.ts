import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer, type Server } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  claimRuntime,
  isRuntimeStarting,
  RUNTIME_STARTUP_GRACE_MS,
  RuntimeAlreadyRunningError,
  socketAnswers,
} from './runtime-claim.js';
import {
  ensureRuntimeDir,
  getRuntimeClaimPath,
  getRuntimeSocketPath,
  readRuntimeClaim,
  writeRuntimeRecord,
} from './runtime-store.js';
import { runModuleScript, sourceUrl } from './test-utils.js';

function deadPid(): number {
  return spawnSync(process.execPath, ['-e', '']).pid;
}

describe('runtime claim', () => {
  const originalHome = process.env.HOME;
  let homeDir = '';
  const children: ChildProcess[] = [];
  const servers: Server[] = [];

  /** A live process that is not this one. */
  function liveForeignPid(): number {
    const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
    children.push(child);
    return child.pid!;
  }

  const writeClaim = (pid: number, startedAt = new Date().toISOString()) =>
    writeFile(getRuntimeClaimPath('claimed'), JSON.stringify({ pid, startedAt }));

  beforeEach(async () => {
    homeDir = await mkdtemp(join(tmpdir(), 'mcpkit-claim-'));
    process.env.HOME = homeDir;
    await ensureRuntimeDir();
  });

  afterEach(async () => {
    for (const child of children.splice(0)) child.kill('SIGKILL');
    await Promise.all(servers.splice(0).map((server) => new Promise((resolve) => server.close(resolve))));
    if (originalHome === undefined) delete process.env.HOME;
    else process.env.HOME = originalHome;
    await rm(homeDir, { recursive: true, force: true });
  });

  it('writes this process\'s pid and start time as the claim', async () => {
    await claimRuntime('claimed');

    expect(await readRuntimeClaim('claimed')).toEqual({ pid: process.pid, startedAt: expect.any(String) });
  });

  it('refuses when a live host started a moment ago holds the claim, and leaves its claim alone', async () => {
    const owner = liveForeignPid();
    await writeClaim(owner);
    const before = await readFile(getRuntimeClaimPath('claimed'), 'utf-8');

    const refusal = await claimRuntime('claimed').catch((error: unknown) => error);

    expect(refusal).toBeInstanceOf(RuntimeAlreadyRunningError);
    expect((refusal as RuntimeAlreadyRunningError).ownerPid).toBe(owner);
    expect(await readFile(getRuntimeClaimPath('claimed'), 'utf-8')).toBe(before);
  });

  it('replaces the claim of a host that died', async () => {
    await writeClaim(deadPid());

    await claimRuntime('claimed');

    expect((await readRuntimeClaim('claimed'))?.pid).toBe(process.pid);
  });

  it('replaces an unreadable claim', async () => {
    await writeFile(getRuntimeClaimPath('claimed'), '{not json');

    await claimRuntime('claimed');

    expect((await readRuntimeClaim('claimed'))?.pid).toBe(process.pid);
  });

  it('replaces a claim that carries its own pid: a process hosts one runtime, so it is a leftover', async () => {
    await writeClaim(process.pid);

    await expect(claimRuntime('claimed')).resolves.toBeUndefined();
  });

  describe('a claim older than the start-up allowance', () => {
    const old = () => new Date(Date.now() - RUNTIME_STARTUP_GRACE_MS - 1_000).toISOString();

    it('is replaced when its pid is alive but nothing answers on the socket (a reused pid, or a hung host)', async () => {
      await writeClaim(liveForeignPid(), old());

      await claimRuntime('claimed');

      expect((await readRuntimeClaim('claimed'))?.pid).toBe(process.pid);
    });

    it('is respected when the host answers on the socket', async () => {
      const owner = liveForeignPid();
      await writeClaim(owner, old());
      const server = createServer();
      servers.push(server);
      await new Promise<void>((resolve) => server.listen(getRuntimeSocketPath('claimed'), resolve));

      await expect(claimRuntime('claimed')).rejects.toBeInstanceOf(RuntimeAlreadyRunningError);
    });
  });

  it('lets exactly one of several processes started at the same instant own the runtime', async () => {
    const script = `
const { claimRuntime, RuntimeAlreadyRunningError } = await import(${JSON.stringify(sourceUrl('src/runtime-claim.ts'))});
try {
  await claimRuntime('contended');
  console.log('OWNED');
  // Stay alive: the others must find a live owner, not a dead one.
  await new Promise((resolve) => setTimeout(resolve, 2500));
} catch (error) {
  console.log(error instanceof RuntimeAlreadyRunningError ? 'REFUSED' : 'ERROR ' + error.message);
}
`;
    const outputs = await Promise.all(
      Array.from({ length: 8 }, (_, i) => runModuleScript(homeDir, `claim-${i}.mjs`, script, homeDir)),
    );

    expect(outputs.map((output) => output.trim().split('\n')[0]).sort()).toEqual([
      'OWNED', ...Array<string>(7).fill('REFUSED'),
    ]);
  }, 60_000);

  describe('isRuntimeStarting', () => {
    const record = async () => {
      const now = new Date().toISOString();
      await writeRuntimeRecord({
        serverName: 'claimed', pid: 1, socketPath: getRuntimeSocketPath('claimed'), logPath: join(homeDir, 'log'),
        fingerprint: 'f', startedAt: now, lastUsedAt: now, idleTimeoutSec: 1, callTimeoutSec: 1,
      });
    };

    it('is true for a live host that holds the claim, is young and has not written its record', async () => {
      await writeClaim(liveForeignPid());

      expect(await isRuntimeStarting('claimed')).toBe(true);
    });

    it.each([
      ['there is no claim', async () => undefined],
      ['the host died', async () => writeClaim(deadPid())],
      ['the host has been starting for longer than it is given', async () => writeClaim(liveForeignPid(), new Date(Date.now() - RUNTIME_STARTUP_GRACE_MS - 1_000).toISOString())],
      ['the host has written its record, so it is up', async () => { await writeClaim(liveForeignPid()); await record(); }],
    ])('is false when %s', async (_label, arrange) => {
      await arrange();

      expect(await isRuntimeStarting('claimed')).toBe(false);
    });
  });

  it('socketAnswers tells a listening socket from a leftover file and from nothing', async () => {
    const path = getRuntimeSocketPath('probe');
    expect(await socketAnswers(path)).toBe(false);

    const server = createServer();
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(path, resolve));
    expect(await socketAnswers(path)).toBe(true);

    await new Promise((resolve) => server.close(resolve));
    await writeFile(path, '');
    expect(await socketAnswers(path)).toBe(false);
    expect(existsSync(path)).toBe(true);
  });
});
