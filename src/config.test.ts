import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { chmod, lstat, mkdir, mkdtemp, readFile, readdir, rm, stat, symlink, utimes, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { addServer, getRegistryPath, getServer, listServers, loadRegistry, removeServer, saveRegistry, updateRegistry, updateServer } from './config.js';
import { parse } from 'yaml';
import { runModuleScript, sourceUrl } from './test-utils.js';
import type { ServerEntry } from './types.js';

function parseServers(yaml: string): Record<string, unknown> {
  return (parse(yaml) as { servers: Record<string, unknown> }).servers;
}

function makeEntry(name: string): ServerEntry {
  return {
    name,
    transport: { type: 'stdio', command: 'node', args: [] },
    toolCount: 0,
    agents: ['cursor'],
    createdAt: '2026-04-04T00:00:00.000Z',
    updatedAt: '2026-04-04T00:00:00.000Z',
  };
}

describe('config', () => {
  const originalHome = process.env.HOME;
  let homeDir = '';

  beforeEach(async () => {
    homeDir = await mkdtemp(join(tmpdir(), 'mcpkit-config-'));
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

  it('accepts openclaw as a valid persisted agent', async () => {
    await mkdir(join(homeDir, '.mcpkit'), { recursive: true });
    await writeFile(getRegistryPath(), [
      'version: 1',
      'servers:',
      '  github:',
      '    name: github',
      '    transport:',
      '      type: stdio',
      '      command: npx',
      '      args: []',
      '    toolCount: 1',
      '    agents:',
      '      - openclaw',
      '    createdAt: 2026-04-04T00:00:00.000Z',
      '    updatedAt: 2026-04-04T00:00:00.000Z',
      '',
    ].join('\n'), 'utf-8');

    const registry = await loadRegistry();
    expect(registry.servers.github?.agents).toEqual(['openclaw']);
  });

  it('accepts persistent runtime config for stdio servers', async () => {
    await mkdir(join(homeDir, '.mcpkit'), { recursive: true });
    await writeFile(getRegistryPath(), [
      'version: 1',
      'servers:',
      '  browsermcp:',
      '    name: browsermcp',
      '    transport:',
      '      type: stdio',
      '      command: npx',
      '      args: []',
      '    runtime:',
      '      mode: persistent',
      '      idleTimeoutSec: 900',
      '      callTimeoutSec: 3600',
      '    toolCount: 1',
      '    agents:',
      '      - cursor',
      '    createdAt: 2026-04-04T00:00:00.000Z',
      '    updatedAt: 2026-04-04T00:00:00.000Z',
      '',
    ].join('\n'), 'utf-8');

    const registry = await loadRegistry();
    expect(registry.servers.browsermcp?.runtime).toEqual({
      mode: 'persistent',
      idleTimeoutSec: 900,
      callTimeoutSec: 3600,
    });
  });

  it('skips invalid persistent runtime config for non-stdio servers', async () => {
    await mkdir(join(homeDir, '.mcpkit'), { recursive: true });
    await writeFile(getRegistryPath(), [
      'version: 1',
      'servers:',
      '  remoteapi:',
      '    name: remoteapi',
      '    transport:',
      '      type: http',
      '      url: https://example.com/mcp',
      '    runtime:',
      '      mode: persistent',
      '    toolCount: 1',
      '    agents:',
      '      - cursor',
      '    createdAt: 2026-04-04T00:00:00.000Z',
      '    updatedAt: 2026-04-04T00:00:00.000Z',
      '',
    ].join('\n'), 'utf-8');

    const registry = await loadRegistry();
    expect(registry.servers.remoteapi).toBeUndefined();
  });

  describe('registry file permissions and symlinks', () => {
    const modeOfRegistry = async () => (await stat(getRegistryPath())).mode & 0o777;

    async function seedRegistry(mode: number): Promise<void> {
      await addServer(makeEntry('seed'));
      await chmod(getRegistryPath(), mode);
    }

    it.each([0o600, 0o644])('keeps a registry of mode %o at that mode when it is updated', async (mode) => {
      await seedRegistry(mode);

      await addServer(makeEntry('second'));
      await updateServer('seed', (entry) => { entry.toolCount = 3; });
      await removeServer('second');

      expect(await modeOfRegistry()).toBe(mode);
      expect((await loadRegistry()).servers.seed?.toolCount).toBe(3);
    });

    it('creates a new registry readable by its owner only, because it can hold literal env secrets', async () => {
      await addServer(makeEntry('first'));

      expect(await modeOfRegistry()).toBe(0o600);
    });

    it('writes through a symlinked registry: the link stays and its target receives the update', async () => {
      const target = join(homeDir, 'dotfiles', 'servers.yaml');
      await mkdir(join(homeDir, 'dotfiles'), { recursive: true });
      await mkdir(join(homeDir, '.mcpkit'), { recursive: true });
      await writeFile(target, 'version: 1\nservers: {}\n', { mode: 0o640 });
      await chmod(target, 0o640);
      await symlink(target, getRegistryPath());

      await addServer(makeEntry('through-link'));

      expect((await lstat(getRegistryPath())).isSymbolicLink()).toBe(true);
      expect(Object.keys(parseServers(await readFile(target, 'utf-8')))).toEqual(['through-link']);
      expect((await stat(target)).mode & 0o777).toBe(0o640);
      expect((await readdir(join(homeDir, 'dotfiles'))).sort()).toEqual(['servers.yaml']);
      expect((await readdir(join(homeDir, '.mcpkit'))).sort()).toEqual(['servers.yaml']);
    });
  });

  describe('a registry that cannot be read', () => {
    const REGISTRY_PROBLEMS: Array<[string, string, RegExp]> = [
      ['invalid YAML', 'version: 1\nservers: [unclosed\n  - : :\n', /invalid YAML/],
      ['a file that is not a mapping', '- one\n- two\n', /not a YAML mapping/],
      ['a scalar', 'just text\n', /not a YAML mapping/],
      ['an unsupported version', 'version: 2\nservers:\n  keep: {}\n', /unsupported version "2"/],
      ['servers that is not a mapping', 'version: 1\nservers:\n  - keep\n', /"servers" is not a mapping/],
    ];

    async function writeRaw(content: string): Promise<void> {
      await mkdir(join(homeDir, '.mcpkit'), { recursive: true });
      await writeFile(getRegistryPath(), content, 'utf-8');
    }

    it('reads a missing file, an empty file and a file without servers as an empty registry', async () => {
      vi.spyOn(console, 'warn').mockImplementation(() => {});
      expect((await loadRegistry()).servers).toEqual({});

      await writeRaw('');
      expect((await loadRegistry()).servers).toEqual({});

      await writeRaw('version: 1\n');
      expect((await loadRegistry()).servers).toEqual({});
    });

    it.each(REGISTRY_PROBLEMS)('loadRegistry throws for %s, naming the file and saying nothing was written', async (_label, content, reason) => {
      await writeRaw(content);

      const error = await loadRegistry().then(() => undefined, (err: Error) => err);

      expect(error?.message).toMatch(reason);
      expect(error?.message).toContain(getRegistryPath());
      expect(error?.message).toMatch(/Nothing was written/);
      expect(error?.message).toMatch(/fix or remove/i);
    });

    it('loadRegistry throws when the path cannot be read at all', async () => {
      await mkdir(getRegistryPath(), { recursive: true });

      const error = await loadRegistry().then(() => undefined, (err: Error) => err);

      expect(error?.message).toContain(`Cannot read ${getRegistryPath()}`);
      expect(error?.message).toMatch(/EISDIR/);
      expect(error?.message).toMatch(/Nothing was written/);
    });

    it.each(REGISTRY_PROBLEMS)('every registry write refuses to run over %s and leaves the file as it was', async (_label, content) => {
      await writeRaw(content);
      const before = await readFile(getRegistryPath(), 'utf-8');
      let mutated = false;

      const writes: Array<() => Promise<unknown>> = [
        () => addServer(makeEntry('new')),
        () => removeServer('keep'),
        () => updateServer('keep', () => { mutated = true; }),
        () => updateRegistry(() => { mutated = true; }),
      ];
      for (const write of writes) {
        await expect(write()).rejects.toThrow(/Nothing was written/);
      }

      expect(mutated).toBe(false);
      expect(await readFile(getRegistryPath(), 'utf-8')).toBe(before);
      expect(existsSync(`${getRegistryPath()}.lock`)).toBe(false);
      expect((await readdir(join(homeDir, '.mcpkit'))).sort()).toEqual(['servers.yaml']);
    });

    it('the read helpers fail the same way instead of showing an empty registry', async () => {
      await writeRaw('version: 1\nservers: [unclosed\n');

      await expect(listServers()).rejects.toThrow(/Nothing was written/);
      await expect(getServer('anything')).rejects.toThrow(/Nothing was written/);
    });

    it('still skips a single invalid entry with a warning and keeps the others', async () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      await writeRaw([
        'version: 1',
        'servers:',
        '  broken:',
        '    name: broken',
        '  fine:',
        '    name: fine',
        '    transport: { type: stdio, command: node, args: [] }',
        '    toolCount: 0',
        '    agents: [cursor]',
        '    createdAt: x',
        '    updatedAt: x',
        '',
      ].join('\n'));

      expect(Object.keys((await loadRegistry()).servers)).toEqual(['fine']);
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('skipping server "broken"'));
    });
  });

  describe('an entry that fails validation is skipped on read but never lost on write', () => {
    const GOOD = [
      '  good:',
      '    name: good',
      '    transport: { type: stdio, command: node, args: [] }',
      '    toolCount: 0',
      '    agents: [cursor]',
      '    createdAt: x',
      '    updatedAt: x',
    ];
    // An entry from a newer mcpkit, a hand edit gone wrong, a scalar and a null: none of them validates.
    const INVALID = [
      '  bad:',
      '    name: bad',
      '    transport: { type: websocket, url: "wss://example.test/x" }',
      '    futureField: { keep: [1, 2, 3], note: "from a newer version" }',
      '  scalar: 5',
      '  empty:',
    ];

    async function writeRaw(lines: string[]): Promise<void> {
      await mkdir(join(homeDir, '.mcpkit'), { recursive: true });
      await writeFile(getRegistryPath(), ['version: 1', 'servers:', ...lines, ''].join('\n'), 'utf-8');
    }

    async function storedServers(): Promise<Record<string, unknown>> {
      return parseServers(await readFile(getRegistryPath(), 'utf-8'));
    }

    async function setUp(): Promise<{ invalid: Record<string, unknown>; warn: ReturnType<typeof vi.spyOn> }> {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      await writeRaw([...GOOD, ...INVALID]);
      const stored = await storedServers();
      return { invalid: { bad: stored.bad, scalar: stored.scalar, empty: stored.empty }, warn };
    }

    async function expectInvalidKept(invalid: Record<string, unknown>): Promise<void> {
      const stored = await storedServers();
      for (const [name, raw] of Object.entries(invalid)) {
        expect(stored, `entry "${name}"`).toHaveProperty(name);
        expect(stored[name], `entry "${name}"`).toEqual(raw);
      }
    }

    it('reading still warns about the entry and skips it', async () => {
      const { warn } = await setUp();

      expect(Object.keys((await loadRegistry()).servers)).toEqual(['good']);
      expect((await listServers()).map((entry) => entry.name)).toEqual(['good']);
      expect(await getServer('bad')).toBeUndefined();
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('skipping server "bad"'));
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('skipping server "scalar"'));
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('skipping server "empty"'));
    });

    it.each<[string, () => Promise<unknown>]>([
      ['addServer of another name', () => addServer(makeEntry('other'))],
      ['updateServer of another name', () => updateServer('good', (entry) => { entry.toolCount = 7; })],
      ['removeServer of another name', () => removeServer('good')],
      ['updateRegistry that adds a server', () => updateRegistry((registry) => { registry.servers.extra = makeEntry('extra'); })],
      ['updateRegistry that changes nothing', () => updateRegistry(() => {})],
    ])('%s leaves the invalid entries as they were', async (_label, write) => {
      const { invalid } = await setUp();

      await write();

      await expectInvalidKept(invalid);
    });

    it('keeps the valid entries correct next to the kept ones', async () => {
      const { invalid } = await setUp();

      await addServer(makeEntry('other'));
      await updateServer('good', (entry) => { entry.toolCount = 7; });

      const stored = await storedServers();
      expect(Object.keys(stored).sort()).toEqual(['bad', 'empty', 'good', 'other', 'scalar']);
      expect(stored.good).toMatchObject({ name: 'good', toolCount: 7 });
      expect(stored.other).toMatchObject({ name: 'other' });
      await expectInvalidKept(invalid);
      expect(Object.keys((await loadRegistry()).servers).sort()).toEqual(['good', 'other']);
    });

    it('keeps the order of the file and appends new servers last', async () => {
      await setUp();

      await addServer(makeEntry('other'));

      expect(Object.keys(await storedServers())).toEqual(['good', 'bad', 'scalar', 'empty', 'other']);
    });

    it('survives many writers at once', async () => {
      const { invalid } = await setUp();

      await Promise.all(Array.from({ length: 10 }, (_, index) => addServer(makeEntry(`srv-${index}`))));

      await expectInvalidKept(invalid);
      expect(Object.keys((await loadRegistry()).servers)).toHaveLength(11);
    });

    it('removeServer of an invalid entry by name deletes just that one', async () => {
      const { invalid } = await setUp();

      await removeServer('bad');

      const stored = await storedServers();
      expect(stored).not.toHaveProperty('bad');
      expect(stored).toHaveProperty('good');
      expect(stored.scalar).toEqual(invalid.scalar);
      expect(stored).toHaveProperty('empty');
    });

    it('addServer under the name of an invalid entry replaces it', async () => {
      const { invalid } = await setUp();

      await addServer(makeEntry('bad'));

      const stored = await storedServers();
      expect(stored.bad).toMatchObject({ name: 'bad', transport: { type: 'stdio' } });
      expect(stored.scalar).toEqual(invalid.scalar);
      expect(Object.keys((await loadRegistry()).servers).sort()).toEqual(['bad', 'good']);
    });

    it('a mutator that throws still leaves the file untouched', async () => {
      await setUp();
      const before = await readFile(getRegistryPath(), 'utf-8');

      await expect(updateRegistry(() => { throw new Error('nope'); })).rejects.toThrow('nope');

      expect(await readFile(getRegistryPath(), 'utf-8')).toBe(before);
    });

    it('a registry that has only invalid entries keeps them all when the first server is added', async () => {
      vi.spyOn(console, 'warn').mockImplementation(() => {});
      await writeRaw(INVALID);
      const before = await storedServers();

      await addServer(makeEntry('first'));

      const stored = await storedServers();
      for (const name of Object.keys(before)) expect(stored[name]).toEqual(before[name]);
      expect(stored).toHaveProperty('first');
    });
  });

  describe('server names that collide with Object.prototype members', () => {
    // `__proto__` is not here: a name must start with a letter or a digit, so it cannot be registered (see "server names").
    const NAMES = ['constructor', 'toString', 'hasOwnProperty', 'valueOf'];

    it.each(NAMES)('getServer("%s") finds nothing in a registry that lacks it', async (name) => {
      await addServer(makeEntry('real'));

      expect(await getServer(name)).toBeUndefined();
    });

    it.each(NAMES)('updateServer("%s") reports a missing server and creates nothing', async (name) => {
      await addServer(makeEntry('real'));
      const mutator = vi.fn();

      expect(await updateServer(name, mutator)).toBe(false);

      expect(mutator).not.toHaveBeenCalled();
      expect(Object.keys((await loadRegistry()).servers)).toEqual(['real']);
    });

    it('removeServer of such a name changes nothing', async () => {
      await addServer(makeEntry('real'));

      await removeServer('constructor');
      await removeServer('__proto__');
      await removeServer('x/../../victim');

      expect(Object.keys((await loadRegistry()).servers)).toEqual(['real']);
    });

    it.each(NAMES)('a server really named "%s" can be stored, read back, updated and removed', async (name) => {
      await addServer(makeEntry('real'));
      await addServer(makeEntry(name));

      expect(await getServer(name)).toMatchObject({ name });
      expect((await listServers()).map((entry) => entry.name).sort()).toEqual(['real', name].sort());
      expect(await updateServer(name, (entry) => { entry.toolCount = 4; })).toBe(true);
      expect((await getServer(name))?.toolCount).toBe(4);

      await removeServer(name);

      expect(await getServer(name)).toBeUndefined();
      expect((await getServer('real'))?.name).toBe('real');
    });
  });

  describe('updateRegistry', () => {
    const lockPath = () => `${getRegistryPath()}.lock`;

    it('keeps every update when many writers run at once', async () => {
      const writers = Array.from({ length: 25 }, (_, index) => updateRegistry(async (registry) => {
        // Hold the loaded snapshot across an await: without serialisation the others' entries are lost.
        await new Promise((resolve) => setTimeout(resolve, 3));
        registry.servers[`srv-${index}`] = makeEntry(`srv-${index}`);
      }));

      await Promise.all(writers);

      const registry = await loadRegistry();
      expect(Object.keys(registry.servers).sort()).toEqual(
        Array.from({ length: 25 }, (_, index) => `srv-${index}`).sort(),
      );
      expect(existsSync(lockPath())).toBe(false);
    });

    it('keeps every update when separate processes write at once', async () => {
      const source = sourceUrl('src/config.ts');
      const script = `
        import { updateRegistry } from ${JSON.stringify(source)};
        const [prefix, count] = process.argv.slice(2);
        for (let i = 0; i < Number(count); i++) {
          await updateRegistry((registry) => {
            registry.servers[prefix + '-' + i] = {
              name: prefix + '-' + i,
              transport: { type: 'stdio', command: 'node', args: [] },
              toolCount: i,
              agents: ['cursor'],
              createdAt: 'x',
              updatedAt: 'x',
            };
          });
        }
      `;

      await Promise.all(['a', 'b', 'c', 'd', 'e'].map((prefix) => (
        runModuleScript(homeDir, `writer-${prefix}.mjs`, script, homeDir, [prefix, '8'])
      )));

      const registry = await loadRegistry();
      expect(Object.keys(registry.servers)).toHaveLength(40);
      expect(registry.servers['c-7']?.toolCount).toBe(7);
      expect(existsSync(lockPath())).toBe(false);
      expect((await readdir(join(homeDir, '.mcpkit'))).filter((file) => file.endsWith('.tmp'))).toEqual([]);
    }, 30_000);

    it('works on top of a registry that already has servers, and reloads it fresh', async () => {
      await addServer(makeEntry('existing'));

      const seen = await updateRegistry((registry) => {
        const before = Object.keys(registry.servers);
        registry.servers.added = makeEntry('added');
        return before;
      });

      expect(seen).toEqual(['existing']);
      expect(Object.keys((await loadRegistry()).servers).sort()).toEqual(['added', 'existing']);
    });

    it('saves nothing and releases the lock when the mutator throws', async () => {
      await addServer(makeEntry('keep'));

      await expect(updateRegistry((registry) => {
        delete registry.servers.keep;
        throw new Error('mutator failed');
      })).rejects.toThrow('mutator failed');

      expect(Object.keys((await loadRegistry()).servers)).toEqual(['keep']);
      expect(existsSync(lockPath())).toBe(false);
    });

    it('breaks a stale lock left by a crashed process', async () => {
      await mkdir(lockPath(), { recursive: true });
      const old = new Date(Date.now() - 60_000);
      await utimes(lockPath(), old, old);

      await addServer(makeEntry('after-crash'));

      expect(Object.keys((await loadRegistry()).servers)).toEqual(['after-crash']);
      expect(existsSync(lockPath())).toBe(false);
    });

    it('breaks a lock that is only a few seconds old: a crashed writer must not make every write time out', async () => {
      await mkdir(lockPath(), { recursive: true });
      const crashed = new Date(Date.now() - 12_000);
      await utimes(lockPath(), crashed, crashed);

      await addServer(makeEntry('after-crash'));
      await updateServer('after-crash', (entry) => { entry.description = 'edited'; });

      expect((await getServer('after-crash'))?.description).toBe('edited');
      expect(existsSync(lockPath())).toBe(false);
    });

    it('keeps every update when many writers meet a stale lock at the same moment', async () => {
      await mkdir(lockPath(), { recursive: true });
      const crashed = new Date(Date.now() - 12_000);
      await utimes(lockPath(), crashed, crashed);

      await Promise.all(Array.from({ length: 20 }, (_, index) => updateRegistry(async (registry) => {
        await new Promise((resolve) => setTimeout(resolve, 2));
        registry.servers[`srv-${index}`] = makeEntry(`srv-${index}`);
      })));

      expect(Object.keys((await loadRegistry()).servers)).toHaveLength(20);
      expect(existsSync(lockPath())).toBe(false);
    });

    it('writes the registry without leaving temp files', async () => {
      await addServer(makeEntry('one'));
      await removeServer('one');
      await addServer(makeEntry('two'));

      expect(Object.keys((await loadRegistry()).servers)).toEqual(['two']);
      expect((await readdir(join(homeDir, '.mcpkit'))).sort()).toEqual(['servers.yaml']);
    });

    it('updateServer patches the stored entry and reports a missing one without creating it', async () => {
      await addServer({ ...makeEntry('present'), description: 'kept' });

      expect(await updateServer('present', (entry) => { entry.toolCount = 9; })).toBe(true);
      expect(await updateServer('absent', (entry) => { entry.toolCount = 9; })).toBe(false);

      const registry = await loadRegistry();
      expect(registry.servers.present).toMatchObject({ toolCount: 9, description: 'kept' });
      expect(registry.servers.absent).toBeUndefined();
    });

    it('hands every writer its own empty registry when the file has no servers yet', async () => {
      vi.spyOn(console, 'warn').mockImplementation(() => {});
      await mkdir(join(homeDir, '.mcpkit'), { recursive: true });
      await writeFile(getRegistryPath(), 'version: 1\n', 'utf-8');

      const first = await loadRegistry();
      first.servers.leaked = makeEntry('leaked');

      expect((await loadRegistry()).servers).toEqual({});
    });
  });

  describe('server names', () => {
    const stdio = '    transport: { type: stdio, command: node, args: [] }\n    toolCount: 0\n    agents: [cursor]\n    createdAt: x\n    updatedAt: x\n';
    const entryYaml = (key: string, name: string | undefined) => (
      `  ${JSON.stringify(key)}:\n${name === undefined ? '' : `    name: ${JSON.stringify(name)}\n`}${stdio}`
    );

    async function writeRegistry(...entries: string[]): Promise<string> {
      await mkdir(join(homeDir, '.mcpkit'), { recursive: true });
      const content = `version: 1\nservers:\n${entries.join('')}`;
      await writeFile(getRegistryPath(), content, 'utf-8');
      return content;
    }

    it('skips an entry whose key is not a valid name, warning with the name escaped, and keeps it in the file', async () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const content = await writeRegistry(
        entryYaml('good', 'good'),
        entryYaml('x/../../../victim', 'x/../../../victim'),
        entryYaml('a\u0000b', 'a\u0000b'),
        entryYaml('.hidden', '.hidden'),
      );

      expect(Object.keys((await loadRegistry()).servers)).toEqual(['good']);

      const warnings = warn.mock.calls.map((call) => String(call[0]));
      expect(warnings.some((line) => line.includes('skipping server "x/../../../victim"') && /invalid server name/.test(line))).toBe(true);
      expect(warnings.some((line) => line.includes('"a\\u0000b"'))).toBe(true);
      expect(warnings.join('\n')).not.toContain('\0');

      await addServer(makeEntry('other'));
      const stored = parseServers(await readFile(getRegistryPath(), 'utf-8'));
      expect(Object.keys(stored)).toEqual(['good', 'x/../../../victim', 'a\u0000b', '.hidden', 'other']);
      expect(content).toContain('x/../../../victim');
    });

    it('skips an entry whose own name field is hostile, missing, or different from its key', async () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      await writeRegistry(
        entryYaml('good', 'good'),
        entryYaml('alias', '../../victim'),
        entryYaml('other-name', 'good'),
        entryYaml('nameless', undefined),
      );

      expect(Object.keys((await loadRegistry()).servers)).toEqual(['good']);
      await expect(listServers()).resolves.toHaveLength(1);
      const warnings = warn.mock.calls.map((call) => String(call[0])).join('\n');
      expect(warnings).toContain('skipping server "alias"');
      expect(warnings).toContain('skipping server "other-name"');
      expect(warnings).toContain('skipping server "nameless"');
    });

    it('keeps accepting every real name, and a name in the registry that is an inherited property name', async () => {
      for (const name of ['cloudinary', 'ticktick', 'obsidian-search', 'chrome-devtools', 'reddit', 'mailmodo', 'cloakbrowser',
        'composio', 'composio-personal', 'xcodebuildmcp', 'slack-me', 'postman', 'mysql-prod', 'constructor']) {
        await addServer(makeEntry(name));
      }

      expect(Object.keys((await loadRegistry()).servers)).toHaveLength(14);
    });

    it.each(['..', 'x/../../victim', 'a/b', 'a\\b', '.hidden', 'a\0b', 'a'.repeat(100), '', 'my server', '__proto__'])(
      'addServer refuses the name %j and writes nothing',
      async (name) => {
        await addServer(makeEntry('keep'));
        const before = await readFile(getRegistryPath(), 'utf-8');

        await expect(addServer(makeEntry(name))).rejects.toThrow(/Invalid server name/);

        expect(await readFile(getRegistryPath(), 'utf-8')).toBe(before);
        expect(existsSync(`${getRegistryPath()}.lock`)).toBe(false);
      },
    );

    it('getServer says "invalid name" rather than "not found", so a rename that checks the new name first learns it before deleting the old one', async () => {
      await addServer(makeEntry('old'));

      await expect(getServer('../x')).rejects.toThrow(/Invalid server name/);
      await expect(getServer('__proto__')).rejects.toThrow(/Invalid server name/);
      // The order the `edit --name` command uses: look the new name up, then remove, then add.
      await expect((async () => {
        await getServer('../x');
        await removeServer('old');
      })()).rejects.toThrow(/Invalid server name/);

      expect((await getServer('old'))?.name).toBe('old');
    });

    it('a rename through updateRegistry or updateServer is refused and saves nothing', async () => {
      await addServer(makeEntry('old'));
      const before = await readFile(getRegistryPath(), 'utf-8');

      await expect(updateRegistry((registry) => {
        const entry = registry.servers.old;
        delete registry.servers.old;
        entry.name = '../../victim';
        registry.servers[entry.name] = entry;
      })).rejects.toThrow(/Invalid server name/);
      await expect(updateServer('old', (entry) => { entry.name = 'valid-but-different'; })).rejects.toThrow(/does not match/);
      await expect(updateServer('old', (entry) => { entry.name = '../x'; })).rejects.toThrow(/Invalid server name/);

      expect(await readFile(getRegistryPath(), 'utf-8')).toBe(before);
    });

    it('saveRegistry refuses a registry holding an invalid name', async () => {
      const registry = await loadRegistry();
      registry.servers['a/b'] = makeEntry('a/b');

      await expect(saveRegistry(registry)).rejects.toThrow(/Invalid server name/);

      expect(existsSync(getRegistryPath())).toBe(false);
    });

    it('updateServer and removeServer of a name that cannot exist report a miss and change nothing', async () => {
      await addServer(makeEntry('real'));
      const before = await readFile(getRegistryPath(), 'utf-8');

      expect(await updateServer('__proto__', () => { throw new Error('must not run'); })).toBe(false);
      expect(await updateServer('../x', () => { throw new Error('must not run'); })).toBe(false);
      await removeServer('../x');

      expect(await readFile(getRegistryPath(), 'utf-8')).toBe(before);
    });
  });
});
