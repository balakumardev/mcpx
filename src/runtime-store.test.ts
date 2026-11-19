import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync } from 'node:fs';
import { chmod, mkdir, mkdtemp, readdir, realpath, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import {
  deleteRuntimeArtifacts,
  ensureRuntimeDir,
  getRuntimeClaimPath,
  getRuntimeDir,
  getRuntimeLockPath,
  getRuntimeLogPath,
  getRuntimeMetadataPath,
  getRuntimeSocketPath,
  openRuntimeLog,
  readRuntimeRecord,
  type RuntimeRecord,
  writeRuntimeRecord,
} from './runtime-store.js';

const mode = async (path: string) => (await stat(path)).mode & 0o777;

describe('runtime store', () => {
  const originalHome = process.env.HOME;
  const scratch: string[] = [];

  async function useHome(path?: string): Promise<string> {
    const home = path ?? await mkdtemp(join(tmpdir(), 'mcpkit-store-'));
    scratch.push(home);
    process.env.HOME = home;
    return home;
  }

  beforeEach(async () => {
    await useHome();
  });

  afterEach(async () => {
    vi.unstubAllGlobals();
    if (originalHome === undefined) delete process.env.HOME;
    else process.env.HOME = originalHome;
    await Promise.all(scratch.splice(0).map((path) => rm(path, { recursive: true, force: true })));
  });

  describe('the socket path', () => {
    it('lives in the runtime directory when that is short enough', () => {
      // Nothing is created here: the path is only computed. (The temporary homes of the other tests are too deep on macOS.)
      process.env.HOME = '/h';

      expect(getRuntimeSocketPath('short')).toMatch(/^\/h\/\.mcpkit\/runtimes\/short-[0-9a-f]{10}\.sock$/);
    });

    it('falls back to the tmp dir when the runtime directory is too deep, and stays short enough for sun_path', async () => {
      const root = await mkdtemp(join(tmpdir(), 'mcpkit-long-'));
      scratch.push(root);
      await useHome(join(root, 'x'.repeat(70), 'home'));

      const socketPath = getRuntimeSocketPath('browsermcp');

      expect(dirname(socketPath)).toBe(tmpdir());
      expect(Buffer.byteLength(socketPath)).toBeLessThan(104);
    });

    it('does not share the fallback between two homes that are both too deep', async () => {
      const root = await mkdtemp(join(tmpdir(), 'mcpkit-long-'));
      scratch.push(root);
      const deep = 'y'.repeat(70);

      await useHome(join(root, deep, 'home-a'));
      const first = getRuntimeSocketPath('browsermcp');
      await useHome(join(root, deep, 'home-b'));
      const second = getRuntimeSocketPath('browsermcp');

      expect(dirname(first)).toBe(tmpdir());
      expect(dirname(second)).toBe(tmpdir());
      expect(first).not.toBe(second);
      // The same home keeps the same path from one call to the next.
      expect(getRuntimeSocketPath('browsermcp')).toBe(second);
      // And one home still tells its servers apart.
      expect(getRuntimeSocketPath('other')).not.toBe(second);
    });

    it('gives one home the same fallback however it is spelled (a symlink to it)', async () => {
      const root = await realpath(await mkdtemp(join(tmpdir(), 'mcpkit-link-')));
      scratch.push(root);
      const realHome = join(root, 'z'.repeat(70), 'home');
      await mkdir(realHome, { recursive: true });
      const alias = join(root, 'alias');
      await symlink(realHome, alias);

      await useHome(realHome);
      const viaRealPath = getRuntimeSocketPath('browsermcp');
      scratch.pop();
      await useHome(alias);
      const viaAlias = getRuntimeSocketPath('browsermcp');
      scratch.pop();

      expect(dirname(viaRealPath)).toBe(tmpdir());
      expect(viaAlias).toBe(viaRealPath);
    });

    it('also tells homes apart in the Windows pipe name, which is shared by every user of the machine', async () => {
      const first = await useHome();
      vi.stubGlobal('process', Object.create(process, { platform: { value: 'win32' } }));
      const pipeA = getRuntimeSocketPath('browsermcp');
      await useHome(`${first}-other`);
      const pipeB = getRuntimeSocketPath('browsermcp');

      expect(pipeA).toMatch(/^\\\\\.\\pipe\\mcpkit-[0-9a-f]{10}-browsermcp-[0-9a-f]{10}$/);
      expect(pipeB).not.toBe(pipeA);
    });
  });

  describe('permissions', () => {
    it('creates the runtime directory private to its owner and tightens one an older release left open', async () => {
      await ensureRuntimeDir();
      expect(await mode(getRuntimeDir())).toBe(0o700);

      await chmod(getRuntimeDir(), 0o755);
      await ensureRuntimeDir();
      expect(await mode(getRuntimeDir())).toBe(0o700);
    });

    it('creates the log readable by its owner only, and tightens an existing one without losing its content', async () => {
      const created = await openRuntimeLog('logged');
      await created.close();
      expect(await mode(getRuntimeLogPath('logged'))).toBe(0o600);

      await writeFile(getRuntimeLogPath('logged'), 'older release wrote this\n', { mode: 0o644 });
      await chmod(getRuntimeLogPath('logged'), 0o644);
      const reopened = await openRuntimeLog('logged');
      await reopened.appendFile('and this\n');
      await reopened.close();

      expect(await mode(getRuntimeLogPath('logged'))).toBe(0o600);
      expect(await (await import('node:fs/promises')).readFile(getRuntimeLogPath('logged'), 'utf-8')).toBe('older release wrote this\nand this\n');
    });

    it('writes the record privately and in one step, leaving no temporary file behind', async () => {
      await writeRuntimeRecord(record('recorded', 4242));
      await writeRuntimeRecord({ ...record('recorded', 4242), lastUsedAt: 'later' });

      expect(await mode(getRuntimeMetadataPath('recorded'))).toBe(0o600);
      expect((await readRuntimeRecord('recorded'))?.lastUsedAt).toBe('later');
      expect((await readdir(getRuntimeDir())).filter((file) => file.endsWith('.tmp'))).toEqual([]);
    });
  });

  describe('deleteRuntimeArtifacts', () => {
    it('leaves the start lock to whoever holds it', async () => {
      await ensureRuntimeDir();
      await writeFile(getRuntimeLockPath('locked'), 'held');
      await writeRuntimeRecord(record('locked', 4242));

      await deleteRuntimeArtifacts('locked', { pids: [4242] });

      expect(existsSync(getRuntimeMetadataPath('locked'))).toBe(false);
      expect(existsSync(getRuntimeLockPath('locked'))).toBe(true);
    });

    it('removes the record, claim and socket of the daemons it is given, and the log only on request', async () => {
      await ensureRuntimeDir();
      await writeRuntimeRecord(record('gone', 4242));
      await writeFile(getRuntimeClaimPath('gone'), JSON.stringify({ pid: 4242, startedAt: new Date().toISOString() }));
      await writeFile(getRuntimeSocketPath('gone'), '');
      await writeFile(getRuntimeLogPath('gone'), 'log');

      await deleteRuntimeArtifacts('gone', { pids: [4242] });

      expect(existsSync(getRuntimeMetadataPath('gone'))).toBe(false);
      expect(existsSync(getRuntimeClaimPath('gone'))).toBe(false);
      expect(existsSync(getRuntimeSocketPath('gone'))).toBe(false);
      expect(existsSync(getRuntimeLogPath('gone'))).toBe(true);

      await deleteRuntimeArtifacts('gone', { pids: [], removeLog: true });
      expect(existsSync(getRuntimeLogPath('gone'))).toBe(false);
    });

    it('keeps the socket for a host that is closing, which never owned one of its own to remove if it lost the claim', async () => {
      await ensureRuntimeDir();
      await writeFile(getRuntimeClaimPath('closing'), JSON.stringify({ pid: 4242, startedAt: new Date().toISOString() }));
      await writeFile(getRuntimeSocketPath('closing'), '');

      await deleteRuntimeArtifacts('closing', { pids: [4242], keepSocket: true });

      expect(existsSync(getRuntimeClaimPath('closing'))).toBe(false);
      expect(existsSync(getRuntimeSocketPath('closing'))).toBe(true);
    });

    it('never takes the files of a daemon it was not given, whose socket is then left alone as well', async () => {
      await ensureRuntimeDir();
      await writeRuntimeRecord(record('live', 5555));
      await writeFile(getRuntimeClaimPath('live'), JSON.stringify({ pid: 5555, startedAt: new Date().toISOString() }));
      await writeFile(getRuntimeSocketPath('live'), '');

      await deleteRuntimeArtifacts('live', { pids: [4242] });

      expect(existsSync(getRuntimeMetadataPath('live'))).toBe(true);
      expect(existsSync(getRuntimeClaimPath('live'))).toBe(true);
      expect(existsSync(getRuntimeSocketPath('live'))).toBe(true);
    });
  });
});

function record(serverName: string, pid: number): RuntimeRecord {
  const now = new Date().toISOString();
  return {
    serverName,
    pid,
    socketPath: getRuntimeSocketPath(serverName),
    logPath: getRuntimeLogPath(serverName),
    fingerprint: 'fingerprint',
    startedAt: now,
    lastUsedAt: now,
    idleTimeoutSec: 60,
    callTimeoutSec: 30,
  };
}
