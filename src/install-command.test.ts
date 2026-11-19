import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { MockInstance } from 'vitest';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInstallCommand } from './commands/install.js';
import { getServer, listServers } from './config.js';
import { discoverForEntry } from './discover.js';
import type { ToolInfo } from './types.js';

vi.mock('./discover.js', () => ({
  discoverForEntry: vi.fn(),
}));

const tools: ToolInfo[] = [{ name: 'echo', description: 'Echo a message', inputSchema: { type: 'object' } }];

/** Every path under `dir`, files and directories, relative to it, with the size of each file. */
async function snapshot(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { recursive: true, withFileTypes: true });
  const lines = await Promise.all(entries.map(async (entry) => {
    const path = join(entry.parentPath, entry.name);
    return entry.isFile() ? `${path} ${(await readFile(path)).length}` : `${path}/`;
  }));
  return lines.sort();
}

describe('install', () => {
  const originalHome = process.env.HOME;
  let outer = '';
  let homeDir = '';
  let errorSpy: MockInstance<typeof console.error>;
  let exitSpy: MockInstance<typeof process.exit>;

  /** Run `mcpkit install <args>` in-process. */
  const install = (...args: string[]) => createInstallCommand()
    .parseAsync([...args, '-a', 'claude-code'], { from: 'user' });

  const stderr = () => errorSpy.mock.calls.map((call) => call.map(String).join(' ')).join('\n');

  beforeEach(async () => {
    // The home sits one level below `outer`, so a path that climbs out of it is still seen by a snapshot.
    outer = await mkdtemp(join(tmpdir(), 'mcpkit-install-'));
    homeDir = join(outer, 'home');
    await mkdir(homeDir);
    process.env.HOME = homeDir;
    vi.mocked(discoverForEntry).mockResolvedValue({ tools, serverMeta: { name: 'srv' } });
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never);
  });

  afterEach(async () => {
    if (originalHome === undefined) {
      delete process.env.HOME;
    } else {
      process.env.HOME = originalHome;
    }
    await rm(outer, { recursive: true, force: true });
    vi.restoreAllMocks();
    vi.clearAllMocks();
  });

  describe('server names', () => {
    const HOSTILE = [
      '..',
      'x/../../../victim',
      'x/../../../../victim',
      'a/b',
      'a\\b',
      '.hidden',
      'a\0b',
      'a'.repeat(100),
      '',
      'my server',
    ];

    /** Nothing may be created, anywhere under the outer directory, and nothing may be started. */
    async function expectRejected(before: string[], expected: RegExp = /Invalid server name/): Promise<void> {
      expect(exitSpy).toHaveBeenCalledWith(1);
      expect(stderr()).toMatch(expected);
      expect(discoverForEntry).not.toHaveBeenCalled();
      expect(await snapshot(outer)).toEqual(before);
    }

    it.each(HOSTILE)('rejects the --name %j before writing or connecting to anything', async (name) => {
      const before = await snapshot(outer);

      await install('node ./server.js', '-n', name);

      await expectRejected(before);
    });

    it('rejects a hostile name even when --dry-run is given', async () => {
      const before = await snapshot(outer);

      await install('node ./server.js', '-n', 'x/../../../victim', '--dry-run');

      await expectRejected(before);
    });

    it('rejects a hostile key of a JSON mcpServers spec', async () => {
      const before = await snapshot(outer);
      const spec = JSON.stringify({ mcpServers: { 'x/../../../victim': { command: 'node', args: [] } } });

      await install(spec);

      await expectRejected(before);
    });

    it('installs none of the servers of a JSON spec when one of the names is hostile', async () => {
      const before = await snapshot(outer);
      const spec = JSON.stringify({
        mcpServers: {
          fine: { command: 'node', args: [] },
          'x/../../../victim': { command: 'node', args: [] },
        },
      });

      await install(spec);

      await expectRejected(before);
      expect(await listServers()).toEqual([]);
    });

    it('rejects a hostile key of a .json spec file', async () => {
      const file = join(outer, 'servers.json');
      await writeFile(file, JSON.stringify({ mcpServers: { '../../victim': { url: 'https://example.com/mcp' } } }), 'utf-8');
      const before = await snapshot(outer);

      await install(file);

      await expectRejected(before);
    });

    it('rejects a name that cannot be derived from the spec and says to pass --name', async () => {
      const before = await snapshot(outer);

      await install('http://[::1]:9/mcp');

      await expectRejected(before, /pass a valid name with --name/);
    });

    it('names the rule and quotes a NUL or escape sequence instead of printing it', async () => {
      await install('node ./server.js', '-n', 'a\0b\u001b[31m');

      expect(stderr()).toContain('"a\\u0000b\\u001b[31m"');
      expect(stderr()).not.toContain('\0');
      expect(stderr()).not.toContain('\u001b');
      expect(stderr()).toContain('letters, digits');
    });

    it.each([
      'mysql-prod', 'slack-me', 'composio-personal', 'obsidian-search', 'chrome-devtools', 'xcodebuildmcp',
    ])('installs under the real name %s', async (name) => {
      await install('node ./server.js', '-n', name);

      expect(exitSpy).not.toHaveBeenCalled();
      expect((await getServer(name))?.name).toBe(name);
      expect(existsSync(join(homeDir, '.claude', 'skills', `mcpkit-${name}`, 'SKILL.md'))).toBe(true);
    });

    it('strips an @version from a derived package name', async () => {
      await install('npx -y @scope/mcp-server-bar@1.2.3');

      expect(exitSpy).not.toHaveBeenCalled();
      expect(await getServer('bar')).toBeDefined();
    });
  });

  describe('installing a name that is already registered', () => {
    it('warns about nothing on a first install', async () => {
      await install('node ./server.js', '-n', 'demo', '-e', 'API_KEY=one');

      expect(stderr()).not.toMatch(/already installed/);
    });

    it('names the description and the env variables it replaces, and never prints a value', async () => {
      await install('node ./server.js', '-n', 'demo', '-e', 'API_KEY=sentinel-secret-value', '-e', 'REGION=eu', '-d', 'My custom description');
      expect(stderr()).toBe('');

      await install('node ./server.js', '-n', 'demo');

      const warning = stderr();
      expect(warning).toMatch(/"demo" is already installed/);
      expect(warning).toContain('description');
      expect(warning).toContain('env (API_KEY, REGION)');
      expect(warning).toContain('-e/--env');
      expect(warning).not.toContain('sentinel-secret-value');
      const stored = await getServer('demo');
      expect(stored?.description).toBeUndefined();
      expect(stored?.transport).toEqual({ type: 'stdio', command: 'node', args: ['./server.js'] });
    });

    it('names the HTTP headers it replaces without printing their values', async () => {
      await install('https://example.com/mcp', '-n', 'web', '--header', 'Authorization: Bearer sentinel-token', '--header', 'X-Team: blue');

      await install('https://example.com/mcp', '-n', 'web');

      const warning = stderr();
      expect(warning).toContain('headers (Authorization, X-Team)');
      expect(warning).not.toContain('sentinel-token');
    });

    it('names the settings it replaces: an env variable whose value changed counts too', async () => {
      await install('node ./server.js', '-n', 'demo', '-e', 'MODE=old', '-e', 'KEEP=same');

      await install('node ./server.js', '-n', 'demo', '-e', 'MODE=new', '-e', 'KEEP=same');

      expect(stderr()).toContain('env (MODE)');
      expect(stderr()).not.toContain('KEEP');
    });

    it('names the param provider, the env hints and the runtime settings it replaces', async () => {
      await install(
        'node ./server.js', '-n', 'demo', '--param-provider', 'echo {}', '--env-hint', 'TOKEN=get one',
        '--runtime', 'persistent', '--auto-refresh',
      );

      await install('node ./server.js', '-n', 'demo');

      const warning = stderr();
      expect(warning).toContain('param provider');
      expect(warning).toContain('env hints (TOKEN)');
      expect(warning).toContain('runtime settings');
      expect(warning).toContain('auto-refresh');
    });

    it('still warns when it replaces an identical entry, and says nothing is lost', async () => {
      await install('node ./server.js', '-n', 'demo', '-e', 'API_KEY=one');

      await install('node ./server.js', '-n', 'demo', '-e', 'API_KEY=one');

      expect(stderr()).toMatch(/"demo" is already installed/);
      expect(stderr()).toContain('no custom setting is lost');
    });

    it('says "would replace" and changes nothing on --dry-run', async () => {
      await install('node ./server.js', '-n', 'demo', '-e', 'API_KEY=one');
      errorSpy.mockClear();

      await install('node ./server.js', '-n', 'demo', '--dry-run');

      expect(stderr()).toMatch(/would replace/);
      expect((await getServer('demo'))?.transport).toMatchObject({ env: { API_KEY: 'one' } });
    });
  });
});
