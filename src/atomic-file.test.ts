import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { chmod, lstat, mkdir, mkdtemp, readFile, readdir, readlink, rm, stat, symlink, utimes, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { withFileLock, writeFileAtomic } from './atomic-file.js';

describe('atomic-file', () => {
  let dir = '';

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'mcpkit-atomic-'));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  describe('withFileLock', () => {
    it('runs tasks one at a time and releases the lock afterwards', async () => {
      const lockPath = join(dir, 'state.lock');
      let active = 0;
      let maxActive = 0;

      await Promise.all(Array.from({ length: 12 }, () => withFileLock(lockPath, async () => {
        active += 1;
        maxActive = Math.max(maxActive, active);
        await new Promise((resolve) => setTimeout(resolve, 5));
        active -= 1;
      }, { retryMs: 2 })));

      expect(maxActive).toBe(1);
      expect(existsSync(lockPath)).toBe(false);
    });

    it('returns the task result and releases the lock when the task throws', async () => {
      const lockPath = join(dir, 'state.lock');

      expect(await withFileLock(lockPath, async () => 42)).toBe(42);
      await expect(withFileLock(lockPath, async () => { throw new Error('task failed'); })).rejects.toThrow('task failed');
      expect(existsSync(lockPath)).toBe(false);
    });

    it('creates the parent directory', async () => {
      const lockPath = join(dir, 'missing', 'parent', 'state.lock');

      await withFileLock(lockPath, async () => {});

      expect(existsSync(join(dir, 'missing', 'parent'))).toBe(true);
    });

    it('waits for a fresh lock and gives up with a clear error after the timeout', async () => {
      const lockPath = join(dir, 'state.lock');
      await mkdir(lockPath);
      let ran = false;

      await expect(withFileLock(lockPath, async () => { ran = true; }, { timeoutMs: 150, retryMs: 10 }))
        .rejects.toThrow(/Timed out after \d+s waiting for the lock .*state\.lock/);

      expect(ran).toBe(false);
      expect(existsSync(lockPath)).toBe(true);
    });

    it('proceeds once a held lock is released while it waits', async () => {
      const lockPath = join(dir, 'state.lock');
      await mkdir(lockPath);
      setTimeout(() => { void rm(lockPath, { recursive: true }); }, 60);

      expect(await withFileLock(lockPath, async () => 'got it', { timeoutMs: 5_000, retryMs: 10 })).toBe('got it');
    });

    it('breaks a lock older than the stale threshold, whose holder crashed', async () => {
      const lockPath = join(dir, 'state.lock');
      await mkdir(lockPath);
      const old = new Date(Date.now() - 60_000);
      await utimes(lockPath, old, old);

      const started = Date.now();
      expect(await withFileLock(lockPath, async () => 'ran')).toBe('ran');

      expect(Date.now() - started).toBeLessThan(2_000);
      expect(existsSync(lockPath)).toBe(false);
    });

    it('does not break a lock younger than the stale threshold', async () => {
      const lockPath = join(dir, 'state.lock');
      await mkdir(lockPath);

      await expect(withFileLock(lockPath, async () => {}, { timeoutMs: 100, retryMs: 10, staleMs: 30_000 }))
        .rejects.toThrow(/Timed out/);
    });

    it('breaks, with the default options, a lock that is several seconds old: the wait must outlast the stale threshold', async () => {
      const lockPath = join(dir, 'state.lock');
      await mkdir(lockPath);
      const crashed = new Date(Date.now() - 12_000);
      await utimes(lockPath, crashed, crashed);

      const started = Date.now();
      expect(await withFileLock(lockPath, async () => 'ran')).toBe('ran');

      expect(Date.now() - started).toBeLessThan(2_000);
    });

    it('lets only one of many waiters through at a time while breaking a stale lock', async () => {
      const lockPath = join(dir, 'state.lock');
      const counter = join(dir, 'counter');
      await writeFile(counter, '0', 'utf-8');
      await mkdir(lockPath);
      const crashed = new Date(Date.now() - 12_000);
      await utimes(lockPath, crashed, crashed);

      await Promise.all(Array.from({ length: 25 }, () => withFileLock(lockPath, async () => {
        const value = Number(await readFile(counter, 'utf-8'));
        await new Promise((resolve) => setTimeout(resolve, 2));
        await writeFile(counter, String(value + 1), 'utf-8');
      })));

      expect(await readFile(counter, 'utf-8')).toBe('25');
    });

    it('lets one breaker at a time remove a stale lock: it waits while a fresh break lock is held', async () => {
      const lockPath = join(dir, 'state.lock');
      await mkdir(lockPath);
      await mkdir(`${lockPath}.break`);
      const crashed = new Date(Date.now() - 12_000);
      await utimes(lockPath, crashed, crashed);

      await expect(withFileLock(lockPath, async () => {}, { timeoutMs: 150, retryMs: 10 })).rejects.toThrow(/Timed out/);

      expect(existsSync(lockPath)).toBe(true);
    });

    it('clears a break lock left by a process that crashed while breaking, then breaks the stale lock', async () => {
      const lockPath = join(dir, 'state.lock');
      await mkdir(lockPath);
      await mkdir(`${lockPath}.break`);
      const crashed = new Date(Date.now() - 12_000);
      await utimes(lockPath, crashed, crashed);
      await utimes(`${lockPath}.break`, crashed, crashed);

      expect(await withFileLock(lockPath, async () => 'ran')).toBe('ran');

      expect(existsSync(lockPath)).toBe(false);
      expect(existsSync(`${lockPath}.break`)).toBe(false);
    });

    it('never breaks the lock of a live holder, however long the holder keeps it', async () => {
      const lockPath = join(dir, 'state.lock');
      let release = () => {};
      let held = () => {};
      const holding = new Promise<void>((resolve) => { held = resolve; });
      const holder = withFileLock(lockPath, () => new Promise<void>((resolve) => {
        release = resolve;
        held();
      }), { staleMs: 600, retryMs: 10 });
      await holding;
      let waiterRan = false;

      // Three times the stale threshold: without a heartbeat the lock would count as abandoned long before.
      const waiter = withFileLock(lockPath, async () => { waiterRan = true; }, { staleMs: 600, retryMs: 10, timeoutMs: 1_800 });
      await expect(waiter).rejects.toThrow(/Timed out/);

      expect(waiterRan).toBe(false);
      expect(existsSync(lockPath)).toBe(true);
      release();
      await holder;
      expect(existsSync(lockPath)).toBe(false);
    });

    it('keeps the modification time of a held lock fresh and stops once the lock is released', async () => {
      const lockPath = join(dir, 'state.lock');
      let release = () => {};
      let held = () => {};
      const holding = new Promise<void>((resolve) => { held = resolve; });
      const holder = withFileLock(lockPath, () => new Promise<void>((resolve) => { release = resolve; held(); }), { staleMs: 400 });
      await holding;
      const first = (await stat(lockPath)).mtimeMs;

      await new Promise((resolve) => setTimeout(resolve, 350));
      const refreshed = (await stat(lockPath)).mtimeMs;
      release();
      await holder;
      await new Promise((resolve) => setTimeout(resolve, 250));

      expect(refreshed).toBeGreaterThan(first);
      expect(existsSync(lockPath)).toBe(false);
    });

    it('the timeout error names the lock and says how to remove it', async () => {
      const lockPath = join(dir, 'state.lock');
      await mkdir(lockPath);

      const error = await withFileLock(lockPath, async () => {}, { timeoutMs: 100, retryMs: 10, staleMs: 30_000 })
        .then(() => new Error('did not throw'), (err: Error) => err);

      expect(error.message).toContain(lockPath);
      expect(error.message).toContain(`rmdir "${lockPath}"`);
    });

    it('breaks the lock of a crashed holder once it passes the stale threshold, well inside the timeout', async () => {
      const lockPath = join(dir, 'state.lock');
      await mkdir(lockPath);

      const started = Date.now();
      expect(await withFileLock(lockPath, async () => 'ran', { staleMs: 300, retryMs: 20, timeoutMs: 2_000 })).toBe('ran');

      expect(Date.now() - started).toBeGreaterThanOrEqual(250);
    });
  });

  describe('writeFileAtomic', () => {
    it('replaces the target and leaves no temp file behind', async () => {
      const target = join(dir, 'data.txt');
      await writeFile(target, 'old', 'utf-8');

      await writeFileAtomic(target, 'new');

      expect(await readFile(target, 'utf-8')).toBe('new');
      expect(await readdir(dir)).toEqual(['data.txt']);
    });

    it('applies the requested mode, also over a file that was more permissive', async () => {
      const target = join(dir, 'secret.json');
      await writeFile(target, '{}', { mode: 0o644 });

      await writeFileAtomic(target, '{"a":1}', { mode: 0o600 });

      expect((await stat(target)).mode & 0o777).toBe(0o600);
    });

    describe('permissions', () => {
      const modeOf = async (path: string) => (await stat(path)).mode & 0o777;

      it.each([0o600, 0o640, 0o644])('keeps the mode %o of an existing file when no mode is requested', async (existing) => {
        const target = join(dir, 'data.txt');
        await writeFile(target, 'old', { mode: existing });
        await chmod(target, existing);

        await writeFileAtomic(target, 'new');

        expect(await modeOf(target)).toBe(existing);
        expect(await readFile(target, 'utf-8')).toBe('new');
      });

      it('gives a file that does not exist yet the newFileMode, and ignores it for one that does', async () => {
        const fresh = join(dir, 'fresh.txt');
        const existing = join(dir, 'existing.txt');
        await writeFile(existing, 'old', { mode: 0o644 });
        await chmod(existing, 0o644);

        await writeFileAtomic(fresh, 'a', { newFileMode: 0o600 });
        await writeFileAtomic(existing, 'b', { newFileMode: 0o600 });

        expect(await modeOf(fresh)).toBe(0o600);
        expect(await modeOf(existing)).toBe(0o644);
      });

      it('an explicit mode beats the existing mode and newFileMode', async () => {
        const target = join(dir, 'data.txt');
        await writeFile(target, 'old', { mode: 0o666 });
        await chmod(target, 0o666);

        await writeFileAtomic(target, 'new', { mode: 0o600, newFileMode: 0o644 });

        expect(await modeOf(target)).toBe(0o600);
      });
    });

    describe('symlinks', () => {
      it('writes through a symlink and keeps the link', async () => {
        await mkdir(join(dir, 'real'));
        const target = join(dir, 'real', 'registry.yaml');
        const link = join(dir, 'link.yaml');
        await writeFile(target, 'old', { mode: 0o600 });
        await symlink(target, link);

        await writeFileAtomic(link, 'new');

        expect((await lstat(link)).isSymbolicLink()).toBe(true);
        expect(await readlink(link)).toBe(target);
        expect(await readFile(target, 'utf-8')).toBe('new');
        expect((await stat(target)).mode & 0o777).toBe(0o600);
        expect(await readdir(dir)).toEqual(['link.yaml', 'real']);
        expect(await readdir(join(dir, 'real'))).toEqual(['registry.yaml']);
      });

      it('follows a relative link and a chain of links, creating the temp file next to the real file', async () => {
        await mkdir(join(dir, 'a'));
        await mkdir(join(dir, 'b'));
        await writeFile(join(dir, 'b', 'real.txt'), 'old');
        await symlink('../b/real.txt', join(dir, 'a', 'hop.txt'));
        await symlink('a/hop.txt', join(dir, 'entry.txt'));

        await writeFileAtomic(join(dir, 'entry.txt'), 'new');

        expect((await lstat(join(dir, 'entry.txt'))).isSymbolicLink()).toBe(true);
        expect((await lstat(join(dir, 'a', 'hop.txt'))).isSymbolicLink()).toBe(true);
        expect(await readFile(join(dir, 'b', 'real.txt'), 'utf-8')).toBe('new');
        expect(await readdir(join(dir, 'b'))).toEqual(['real.txt']);
        expect(await readdir(join(dir, 'a'))).toEqual(['hop.txt']);
      });

      it('creates the target of a dangling link, as a plain write would', async () => {
        await mkdir(join(dir, 'dotfiles'));
        const link = join(dir, 'link.yaml');
        await symlink(join(dir, 'dotfiles', 'registry.yaml'), link);

        await writeFileAtomic(link, 'created', { newFileMode: 0o600 });

        expect((await lstat(link)).isSymbolicLink()).toBe(true);
        expect(await readFile(join(dir, 'dotfiles', 'registry.yaml'), 'utf-8')).toBe('created');
        expect((await stat(link)).mode & 0o777).toBe(0o600);
      });

      it('gives up with a clear error on a link loop', async () => {
        await symlink(join(dir, 'b'), join(dir, 'a'));
        await symlink(join(dir, 'a'), join(dir, 'b'));

        await expect(writeFileAtomic(join(dir, 'a'), 'data')).rejects.toThrow(/too many levels of symbolic links/i);
      });
    });

    it('keeps the old content and removes the temp file when the write cannot complete', async () => {
      const target = join(dir, 'blocked');
      await mkdir(target);
      await writeFile(join(target, 'inside'), 'x', 'utf-8');

      await expect(writeFileAtomic(target, 'data')).rejects.toThrow();

      expect(await readdir(dir)).toEqual(['blocked']);
      expect(await readFile(join(target, 'inside'), 'utf-8')).toBe('x');
    });
  });
});
