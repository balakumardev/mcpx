import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, readdir, rm, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createFileExclusive, removeStaleFile, withRuntimeStartLock } from './runtime-lock.js';
import { deleteRuntimeArtifacts, ensureRuntimeDir, getRuntimeDir, getRuntimeLockPath } from './runtime-store.js';

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** A pid that belonged to a process which has exited. */
function deadPid(): number {
  const child = spawnSync(process.execPath, ['-e', '']);
  return child.pid;
}

describe('runtime start lock', () => {
  const originalHome = process.env.HOME;
  let homeDir = '';

  beforeEach(async () => {
    homeDir = await mkdtemp(join(tmpdir(), 'mcpkit-lock-'));
    process.env.HOME = homeDir;
    await ensureRuntimeDir();
  });

  afterEach(async () => {
    if (originalHome === undefined) delete process.env.HOME;
    else process.env.HOME = originalHome;
    await rm(homeDir, { recursive: true, force: true });
  });

  const holder = (pid: number, at = Date.now()) => JSON.stringify({ pid, at, nonce: 'other' });

  describe('createFileExclusive', () => {
    it('lets exactly one of many racing callers create the file, which is never seen empty', async () => {
      const path = join(getRuntimeDir(), 'race.pid');
      const contents = Array.from({ length: 25 }, (_, i) => JSON.stringify({ owner: i, padding: 'p'.repeat(200) }));
      const seenEmpty: string[] = [];
      const watcher = setInterval(() => {
        void readFile(path, 'utf-8').then((text) => { if (text === '') seenEmpty.push(text); }, () => undefined);
      }, 1);

      const results = await Promise.all(contents.map((content) => createFileExclusive(path, content)));
      clearInterval(watcher);

      expect(results.filter(Boolean)).toHaveLength(1);
      expect(contents).toContain(await readFile(path, 'utf-8'));
      expect(seenEmpty).toEqual([]);
      expect((await readdir(getRuntimeDir())).filter((file) => file.endsWith('.tmp'))).toEqual([]);
    });
  });

  describe('removeStaleFile', () => {
    it('removes the file it was told is stale', async () => {
      const path = join(getRuntimeDir(), 'stale.pid');
      await writeFile(path, 'dead owner');

      await removeStaleFile(path, 'dead owner');

      expect(existsSync(path)).toBe(false);
      expect(await readdir(getRuntimeDir())).toEqual([]);
    });

    it('puts back a live owner\'s file that replaced the stale one in the meantime', async () => {
      const path = join(getRuntimeDir(), 'replaced.pid');
      await writeFile(path, 'live owner');

      await removeStaleFile(path, 'dead owner');

      expect(await readFile(path, 'utf-8')).toBe('live owner');
      expect(await readdir(getRuntimeDir())).toEqual(['replaced.pid']);
    });

    it('does nothing when the file is already gone', async () => {
      await expect(removeStaleFile(join(getRuntimeDir(), 'missing.pid'), 'x')).resolves.toBeUndefined();
    });
  });

  describe('withRuntimeStartLock', () => {
    it('runs one task at a time for many callers of the same server, and one server does not block another', async () => {
      let running = 0;
      let overlap = 0;
      const task = async () => {
        running += 1;
        overlap = Math.max(overlap, running);
        await sleep(20);
        running -= 1;
      };

      await Promise.all(Array.from({ length: 8 }, () => withRuntimeStartLock('one', task)));
      expect(overlap).toBe(1);

      let otherServerRan = false;
      await withRuntimeStartLock('one', async () => {
        await withRuntimeStartLock('two', async () => { otherServerRan = true; });
      });
      expect(otherServerRan).toBe(true);
      expect(existsSync(getRuntimeLockPath('one'))).toBe(false);
    });

    it('stays held while the runtime\'s other files are cleaned up (the lock used to be one of them)', async () => {
      await withRuntimeStartLock('held', async () => {
        await deleteRuntimeArtifacts('held', { pids: [process.pid], removeLog: true });
        expect(existsSync(getRuntimeLockPath('held'))).toBe(true);

        // So a second caller still has to wait.
        await expect(withRuntimeStartLock('held', async () => 'second', { timeoutMs: 300 }))
          .rejects.toThrow(/Timed out waiting for another mcpkit process to start the runtime for "held"/);
      });
      expect(existsSync(getRuntimeLockPath('held'))).toBe(false);
    });

    it('releases the lock when the task fails', async () => {
      await expect(withRuntimeStartLock('failing', async () => { throw new Error('boom'); })).rejects.toThrow('boom');

      expect(existsSync(getRuntimeLockPath('failing'))).toBe(false);
    });

    it('does not remove a lock that has been taken over from it', async () => {
      const takenOver = holder(process.pid);
      await withRuntimeStartLock('taken-over', async () => {
        await writeFile(getRuntimeLockPath('taken-over'), takenOver);
      });

      expect(await readFile(getRuntimeLockPath('taken-over'), 'utf-8')).toBe(takenOver);
    });

    it('takes over, at once, a lock whose holder has died', async () => {
      await writeFile(getRuntimeLockPath('crashed'), holder(deadPid()));

      const started = Date.now();
      const result = await withRuntimeStartLock('crashed', async () => 'ran');

      expect(result).toBe('ran');
      expect(Date.now() - started).toBeLessThan(1_000);
    });

    it('never breaks the lock of a live holder, however briefly it has been held', async () => {
      const content = holder(process.pid);
      await writeFile(getRuntimeLockPath('busy'), content);

      await expect(withRuntimeStartLock('busy', async () => 'stolen', { timeoutMs: 400, staleMs: 60_000 }))
        .rejects.toThrow(/Timed out/);

      expect(await readFile(getRuntimeLockPath('busy'), 'utf-8')).toBe(content);
    });

    it('breaks a lock that a live pid has held for longer than any start can take', async () => {
      await writeFile(getRuntimeLockPath('wedged'), holder(process.pid, Date.now() - 5_000));

      expect(await withRuntimeStartLock('wedged', async () => 'ran', { staleMs: 1_000, timeoutMs: 2_000 })).toBe('ran');
    });

    it('treats the empty lock file of the previous release as held while it is young and as stale after that', async () => {
      await writeFile(getRuntimeLockPath('legacy'), '');
      await expect(withRuntimeStartLock('legacy', async () => 'ran', { timeoutMs: 300 })).rejects.toThrow(/Timed out/);

      const old = new Date(Date.now() - 60_000);
      await utimes(getRuntimeLockPath('legacy'), old, old);
      expect(await withRuntimeStartLock('legacy', async () => 'ran', { timeoutMs: 2_000 })).toBe('ran');
    });

    it('hands a waiting caller the answer that appears meanwhile, without running its task', async () => {
      let answer: string | undefined;
      let ran = false;
      let released!: () => void;
      const hold = new Promise<void>((resolve) => { released = resolve; });
      const holderDone = withRuntimeStartLock('shared', async () => {
        await hold;
        return 'holder';
      });
      await sleep(50);
      setTimeout(() => { answer = 'from the host that came up'; }, 150);

      const waiter = await withRuntimeStartLock('shared', async () => { ran = true; return 'waiter'; }, {
        whileWaiting: async () => answer,
      });

      expect(waiter).toBe('from the host that came up');
      expect(ran).toBe(false);
      released();
      await holderDone;
    });
  });
});
