import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  listSchemaCaches,
  loadSchemaCache,
  removeSchemaCache,
  saveSchemaCache,
  schemaCacheDir,
  schemaCachePath,
  trySaveSchemaCache,
} from './schema-store.js';
import type { ToolInfo } from './types.js';

const tools: ToolInfo[] = [
  {
    name: 'echo',
    title: 'Echo',
    description: 'Echo a message',
    inputSchema: { type: 'object', properties: { message: { type: 'string' } }, required: ['message'] },
    outputSchema: { type: 'object', properties: { echoed: { type: 'string' } } },
    annotations: { readOnlyHint: true },
  },
  { name: 'add', description: 'Add numbers', inputSchema: { type: 'object' } },
];

describe('schema-store', () => {
  const originalHome = process.env.HOME;
  let homeDir = '';

  beforeEach(async () => {
    homeDir = await mkdtemp(join(tmpdir(), 'mcpkit-schema-store-'));
    process.env.HOME = homeDir;
  });

  afterEach(async () => {
    if (originalHome === undefined) {
      delete process.env.HOME;
    } else {
      process.env.HOME = originalHome;
    }
    await rm(homeDir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it('keeps the cache under <home>/.mcpkit/schemas', () => {
    expect(schemaCacheDir()).toBe(join(homeDir, '.mcpkit', 'schemas'));
    expect(schemaCachePath('github')).toBe(join(homeDir, '.mcpkit', 'schemas', 'github.json'));
  });

  it('round-trips tools with every new field intact', async () => {
    const before = Date.now();
    await saveSchemaCache('demo', tools);

    const cache = await loadSchemaCache('demo');
    expect(cache).not.toBeNull();
    expect(cache!.version).toBe(1);
    expect(cache!.server).toBe('demo');
    expect(cache!.tools).toEqual(tools);
    expect(Date.parse(cache!.fetchedAt)).toBeGreaterThanOrEqual(before - 1000);
  });

  it('returns null when the cache does not exist', async () => {
    expect(await loadSchemaCache('missing')).toBeNull();
  });

  it('returns null for a corrupt file', async () => {
    await mkdir(schemaCacheDir(), { recursive: true });
    await writeFile(schemaCachePath('broken'), '{"version":1,"server":"broken","tools":[', 'utf-8');
    expect(await loadSchemaCache('broken')).toBeNull();
  });

  it('returns null for a different cache version', async () => {
    await mkdir(schemaCacheDir(), { recursive: true });
    await writeFile(
      schemaCachePath('old'),
      JSON.stringify({ version: 2, server: 'old', fetchedAt: new Date().toISOString(), tools }),
      'utf-8',
    );
    expect(await loadSchemaCache('old')).toBeNull();
  });

  it('returns null when the file shape is wrong', async () => {
    await mkdir(schemaCacheDir(), { recursive: true });
    const header = { version: 1, server: 'shape', fetchedAt: new Date().toISOString() };

    await writeFile(schemaCachePath('shape'), JSON.stringify({ ...header, tools: 'nope' }), 'utf-8');
    expect(await loadSchemaCache('shape')).toBeNull();

    await writeFile(schemaCachePath('shape'), JSON.stringify({ ...header, tools: [{ name: 'x' }] }), 'utf-8');
    expect(await loadSchemaCache('shape')).toBeNull();

    await writeFile(schemaCachePath('shape'), JSON.stringify(['not', 'an', 'object']), 'utf-8');
    expect(await loadSchemaCache('shape')).toBeNull();
  });

  it('returns null when the stored server name does not match the file', async () => {
    await saveSchemaCache('alpha', tools);
    await writeFile(schemaCachePath('beta'), await readFile(schemaCachePath('alpha')));
    expect(await loadSchemaCache('beta')).toBeNull();
    expect(await loadSchemaCache('alpha')).not.toBeNull();
  });

  it('writes atomically: no temp files are left behind and a replace never exposes a partial file', async () => {
    await saveSchemaCache('demo', tools);
    await saveSchemaCache('demo', [tools[1]]);

    expect(await readdir(schemaCacheDir())).toEqual(['demo.json']);
    expect((await loadSchemaCache('demo'))!.tools).toEqual([tools[1]]);
  });

  it('never lets a concurrent reader see a partial file while writers replace the cache', async () => {
    const big = (n: number): ToolInfo[] => Array.from({ length: 200 }, (_, i) => ({
      name: `tool_${n}_${i}`,
      description: 'x'.repeat(500),
      inputSchema: { type: 'object' },
    }));
    await saveSchemaCache('busy', big(0));

    const writes = Array.from({ length: 20 }, (_, n) => saveSchemaCache('busy', big(n + 1)));
    const reads = Array.from({ length: 40 }, () => loadSchemaCache('busy'));
    const results = await Promise.all([...reads, ...writes]);

    for (const result of results.slice(0, reads.length)) {
      expect(result).not.toBeNull();
    }
    expect(await readdir(schemaCacheDir())).toEqual(['busy.json']);
  });

  it('leaves the previous cache untouched and cleans up when a write fails', async () => {
    await saveSchemaCache('demo', tools);
    const unserialisable: ToolInfo = { name: 'loop', description: '', inputSchema: {} };
    unserialisable.inputSchema.self = unserialisable.inputSchema;

    await expect(saveSchemaCache('demo', [unserialisable])).rejects.toThrow();

    expect(await readdir(schemaCacheDir())).toEqual(['demo.json']);
    expect((await loadSchemaCache('demo'))!.tools).toEqual(tools);
  });

  it('restricts the cache files to the current user', async () => {
    await saveSchemaCache('demo', tools);
    expect((await stat(schemaCachePath('demo'))).mode & 0o777).toBe(0o600);
  });

  it('maps hostile server names to files inside the cache directory without collisions', async () => {
    const names = ['../escape', 'a/b', 'a%2Fb', '..', 'with space', 'ünï'];
    for (const name of names) {
      expect(schemaCachePath(name).startsWith(schemaCacheDir() + '/')).toBe(true);
      expect(schemaCachePath(name).slice(schemaCacheDir().length + 1)).not.toContain('/');
      await saveSchemaCache(name, [{ name, description: '', inputSchema: {} }]);
    }
    expect(new Set(names.map(schemaCachePath)).size).toBe(names.length);
    for (const name of names) {
      expect((await loadSchemaCache(name))!.tools[0].name).toBe(name);
    }
  });

  it('removes a cache and ignores a missing one', async () => {
    await saveSchemaCache('demo', tools);
    await removeSchemaCache('demo');
    expect(await loadSchemaCache('demo')).toBeNull();
    await expect(removeSchemaCache('demo')).resolves.toBeUndefined();
  });

  it('lists valid caches sorted by server and skips corrupt files and temp files', async () => {
    expect(await listSchemaCaches()).toEqual([]);

    await saveSchemaCache('zeta', tools);
    await saveSchemaCache('alpha', [tools[1]]);
    await writeFile(schemaCachePath('junk'), 'not json', 'utf-8');
    await writeFile(join(schemaCacheDir(), 'alpha.json.123.abcd.tmp'), '{}', 'utf-8');

    const caches = await listSchemaCaches();
    expect(caches.map((c) => c.server)).toEqual(['alpha', 'zeta']);
    expect(caches[1].tools).toEqual(tools);
  });

  describe('trySaveSchemaCache', () => {
    it('reports success without printing anything', async () => {
      const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      expect(await trySaveSchemaCache('demo', tools)).toBe(true);
      expect(errorSpy).not.toHaveBeenCalled();
      expect(await loadSchemaCache('demo')).not.toBeNull();
    });

    it('never throws: a failing write costs one stderr line', async () => {
      // A regular file where the directory should be makes mkdir fail.
      await mkdir(join(homeDir, '.mcpkit'), { recursive: true });
      await writeFile(schemaCacheDir(), 'in the way', 'utf-8');
      const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

      expect(await trySaveSchemaCache('demo', tools)).toBe(false);
      expect(errorSpy).toHaveBeenCalledTimes(1);
      expect(String(errorSpy.mock.calls[0][0])).toContain('could not cache tool schemas for "demo"');
    });
  });
});
