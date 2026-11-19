import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Wrap the two calls the atomic write is built on, so a test can watch the temp file being
// created and make the final rename fail the way some file systems do.
vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return { ...actual, open: vi.fn(actual.open), rename: vi.fn(actual.rename) };
});

const fs = await import('node:fs/promises');
const { writeFileAtomic } = await import('./atomic-file.js');

function errno(code: string): NodeJS.ErrnoException {
  return Object.assign(new Error(`${code}: simulated`), { code });
}

describe('writeFileAtomic on a file system that refuses part of it', () => {
  let dir = '';

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'mcpkit-atomic-fs-'));
    vi.mocked(fs.open).mockClear();
    vi.mocked(fs.rename).mockClear();
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('creates the temp file with the final mode, so a secret is never readable by others', async () => {
    const target = join(dir, 'credentials.json');
    await writeFile(target, '{}', { mode: 0o644 });

    await writeFileAtomic(target, '{"token":"x"}', { mode: 0o600 });

    const [tmpPath, flags, createMode] = vi.mocked(fs.open).mock.calls[0] as unknown as [string, string, number];
    expect(tmpPath).toMatch(/credentials\.json\..*\.tmp$/);
    expect(flags).toBe('wx');
    expect(createMode).toBe(0o600);
    expect((await stat(target)).mode & 0o777).toBe(0o600);
  });

  it('creates the temp file of a new registry with newFileMode', async () => {
    await writeFileAtomic(join(dir, 'servers.yaml'), 'version: 1\n', { newFileMode: 0o600 });

    expect((vi.mocked(fs.open).mock.calls[0] as unknown as [string, string, number])[2]).toBe(0o600);
    expect((await stat(join(dir, 'servers.yaml'))).mode & 0o777).toBe(0o600);
  });

  it.each(['EXDEV', 'EBUSY'])(
    'falls back to writing the file in place when the rename fails with %s, and leaves no temp file',
    async (code) => {
      const target = join(dir, 'servers.yaml');
      await writeFile(target, 'old', { mode: 0o600 });
      vi.mocked(fs.rename).mockRejectedValueOnce(errno(code));

      await writeFileAtomic(target, 'new');

      expect(await readFile(target, 'utf-8')).toBe('new');
      expect((await stat(target)).mode & 0o777).toBe(0o600);
      expect(await readdir(dir)).toEqual(['servers.yaml']);
    },
  );

  it('applies an explicit mode in the in-place fallback too', async () => {
    const target = join(dir, 'credentials.json');
    await writeFile(target, '{}', { mode: 0o644 });
    vi.mocked(fs.rename).mockRejectedValueOnce(errno('EXDEV'));

    await writeFileAtomic(target, '{"a":1}', { mode: 0o600 });

    expect((await stat(target)).mode & 0o777).toBe(0o600);
    expect(await readFile(target, 'utf-8')).toBe('{"a":1}');
  });

  it('does not fall back for any other rename failure: the old content stays and the temp file goes', async () => {
    const target = join(dir, 'servers.yaml');
    await writeFile(target, 'old');
    vi.mocked(fs.rename).mockRejectedValueOnce(errno('EACCES'));

    await expect(writeFileAtomic(target, 'new')).rejects.toThrow('EACCES');

    expect(await readFile(target, 'utf-8')).toBe('old');
    expect(await readdir(dir)).toEqual(['servers.yaml']);
  });

  it('removes the temp file when writing its content fails', async () => {
    const target = join(dir, 'servers.yaml');
    await writeFile(target, 'old');
    const realOpen = (await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises')).open;
    vi.mocked(fs.open).mockImplementationOnce((async (...args: Parameters<typeof realOpen>) => {
      const handle = await realOpen(...args);
      vi.spyOn(handle, 'writeFile').mockRejectedValueOnce(errno('ENOSPC'));
      return handle;
    }) as typeof fs.open);

    await expect(writeFileAtomic(target, 'new')).rejects.toThrow('ENOSPC');

    expect(await readFile(target, 'utf-8')).toBe('old');
    expect(await readdir(dir)).toEqual(['servers.yaml']);
  });
});
