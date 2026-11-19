import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runModuleScript, sourceUrl } from './test-utils.js';

const COMMANDS: Array<[file: string, factory: string]> = [
  ['call', 'createCallCommand'],
  ['list', 'createListCommand'],
  ['view', 'createViewCommand'],
  ['remove', 'createRemoveCommand'],
  ['update', 'createUpdateCommand'],
  ['sync', 'createSyncCommand'],
  ['auth', 'createAuthCommand'],
  ['runtime', 'createRuntimeCommand'],
];

/** The real command classes behind a stand-in entry point, run through tsx like the runtime tests do. */
const MINI_CLI = `
globalThis.__PKG_VERSION__ = 'test';
const { Command } = await import(${JSON.stringify(sourceUrl('node_modules/commander/esm.mjs'))});
const program = new Command().name('mcpkit');
${COMMANDS.map(([file, factory]) => (
  `program.addCommand((await import(${JSON.stringify(sourceUrl(`src/commands/${file}.ts`))})).${factory}());`
)).join('\n')}
program.parse();
`;

const SERVER_URL = 'https://remote.example.com/mcp';
const NOW = '2026-11-19T00:00:00.000Z';

const REGISTRY = [
  'version: 1',
  'servers:',
  '  real:',
  '    name: real',
  '    transport:',
  '      type: http',
  `      url: ${SERVER_URL}`,
  '      auth: oauth',
  '    toolCount: 1',
  '    agents: [cursor]',
  `    createdAt: ${NOW}`,
  `    updatedAt: ${NOW}`,
  '',
].join('\n');

describe('registry and credentials safety through the CLI commands', () => {
  let homeDir = '';
  const mcpkitFile = (name: string) => join(homeDir, '.mcpkit', name);

  const cli = (...args: string[]) => runModuleScript(homeDir, 'mini-cli.mjs', MINI_CLI, homeDir, args);

  /** Runs the command, expecting it to fail: resolves with its exit code and stderr. */
  async function failure(...args: string[]): Promise<{ code: number; stderr: string }> {
    try {
      await cli(...args);
    } catch (err) {
      const match = /exited with code (\d+): ([\s\S]*)$/.exec((err as Error).message);
      if (match) return { code: Number(match[1]), stderr: match[2] };
      throw err;
    }
    throw new Error(`mcpkit ${args.join(' ')} exited 0`);
  }

  beforeEach(async () => {
    homeDir = await mkdtemp(join(tmpdir(), 'mcpkit-store-safety-'));
    await mkdir(join(homeDir, '.mcpkit'), { recursive: true });
  });

  afterEach(async () => {
    await rm(homeDir, { recursive: true, force: true });
  });

  describe('a server name that is a property of every object', () => {
    // `__proto__` is also a property of every object, but as a name it is simply invalid (a name starts with a letter or a digit): see below.
    const NAMES = ['constructor', 'toString', 'hasOwnProperty'];
    const PER_SERVER_COMMANDS: Array<(name: string) => string[]> = [
      (name) => ['call', name, 'x'],
      (name) => ['view', name],
      (name) => ['list', name],
      (name) => ['remove', name],
      (name) => ['update', name],
      (name) => ['sync', name],
      (name) => ['auth', name],
      (name) => ['runtime', 'status', name],
    ];

    it('is reported as an unknown server, with exit code 1, by every command that takes a server', async () => {
      await writeFile(mcpkitFile('servers.yaml'), REGISTRY, 'utf-8');

      const runs = NAMES.flatMap((name) => PER_SERVER_COMMANDS.map((command) => ({ name, args: command(name) })));
      const results = await Promise.all(runs.map(async ({ name, args }) => ({ name, args, ...await failure(...args) })));

      for (const { name, args, code, stderr } of results) {
        expect({ args, code }).toEqual({ args, code: 1 });
        expect({ args, stderr: stderr.includes(`"${name}" not found`) }).toEqual({ args, stderr: true });
      }
      expect(await readFile(mcpkitFile('servers.yaml'), 'utf-8')).toBe(REGISTRY);
    }, 120_000);
  });

  describe('a server name that is not valid', () => {
    it('is refused with exit code 1 and the reason by every command that takes a server, changing nothing', async () => {
      await writeFile(mcpkitFile('servers.yaml'), REGISTRY, 'utf-8');
      const names = ['__proto__', 'x/../../victim', 'a b'];
      const perServer = [
        (name: string) => ['call', name, 'x'],
        (name: string) => ['view', name],
        (name: string) => ['list', name],
        (name: string) => ['remove', name],
        (name: string) => ['update', name],
        (name: string) => ['sync', name],
      ];

      const runs = names.flatMap((name) => perServer.map((command) => command(name)));
      const results = await Promise.all(runs.map(async (args) => ({ args, ...await failure(...args) })));

      for (const { args, code, stderr } of results) {
        expect({ args, code }).toEqual({ args, code: 1 });
        expect({ args, stderr: /Invalid server name/.test(stderr) }).toEqual({ args, stderr: true });
      }
      expect(await readFile(mcpkitFile('servers.yaml'), 'utf-8')).toBe(REGISTRY);
    }, 120_000);
  });

  describe('a registry or credentials file that cannot be parsed', () => {
    const BROKEN_REGISTRY = 'version: 1\nservers: [unclosed\n  - : :\n';
    const BROKEN_CREDENTIALS = '{"https://remote.example.com/mcp": {"tokens": ';

    it('every registry command exits 1 naming the file, and none writes anything', async () => {
      await writeFile(mcpkitFile('servers.yaml'), BROKEN_REGISTRY, 'utf-8');
      const commands = [
        ['list'],
        ['list', 'real'],
        ['view', 'real'],
        ['call', 'real', 'x'],
        ['remove', 'real'],
        ['update'],
        ['sync'],
        ['auth', 'real'],
      ];

      const results = await Promise.all(commands.map(async (args) => ({ args, ...await failure(...args) })));

      for (const { args, code, stderr } of results) {
        expect({ args, code }).toEqual({ args, code: 1 });
        expect({ args, stderr: stderr.includes(mcpkitFile('servers.yaml')) }).toEqual({ args, stderr: true });
        expect({ args, stderr: /Nothing was written/.test(stderr) }).toEqual({ args, stderr: true });
      }
      expect(await readFile(mcpkitFile('servers.yaml'), 'utf-8')).toBe(BROKEN_REGISTRY);
      expect(await readdir(join(homeDir, '.mcpkit'))).toEqual(['servers.yaml']);
    }, 120_000);

    it('auth exits 1 naming the credentials file and does not touch it', async () => {
      await writeFile(mcpkitFile('servers.yaml'), REGISTRY, 'utf-8');
      await writeFile(mcpkitFile('credentials.json'), BROKEN_CREDENTIALS, { encoding: 'utf-8', mode: 0o600 });

      const status = await failure('auth', 'real', '--status');
      const reset = await failure('auth', 'real', '--reset');

      for (const { code, stderr } of [status, reset]) {
        expect(code).toBe(1);
        expect(stderr).toContain(mcpkitFile('credentials.json'));
        expect(stderr).toMatch(/Nothing was written/);
      }
      expect(await readFile(mcpkitFile('credentials.json'), 'utf-8')).toBe(BROKEN_CREDENTIALS);
      expect((await readdir(join(homeDir, '.mcpkit'))).sort()).toEqual(['credentials.json', 'servers.yaml']);
    }, 60_000);
  });
});
