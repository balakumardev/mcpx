import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { MockInstance } from 'vitest';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createUpdateCommand } from './commands/update.js';
import { addServer, getServer } from './config.js';
import { discoverForEntry } from './discover.js';
import { OAuthRequiredError } from './oauth-required-error.js';
import { loadSchemaCache, saveSchemaCache, schemaCachePath } from './schema-store.js';
import type { ServerEntry, ToolInfo } from './types.js';

vi.mock('./discover.js', () => ({
  discoverForEntry: vi.fn(),
}));

const OLD_TOOLS: ToolInfo[] = [{ name: 'old_tool', description: 'Old', inputSchema: { type: 'object' } }];
const NEW_TOOLS: ToolInfo[] = [
  { name: 'new_one', description: 'New one', inputSchema: { type: 'object' } },
  { name: 'new_two', description: 'New two', inputSchema: { type: 'object' } },
];

function makeEntry(name: string): ServerEntry {
  return {
    name,
    transport: { type: 'stdio', command: 'node', args: [`${name}.js`] },
    toolCount: 1,
    agents: ['claude-code'],
    agentSelectionMode: 'explicit',
    createdAt: '2026-04-04T00:00:00.000Z',
    updatedAt: '2026-04-04T00:00:00.000Z',
  };
}

describe('update', () => {
  const originalHome = process.env.HOME;
  let homeDir = '';
  let logSpy: MockInstance<typeof console.log>;
  let errorSpy: MockInstance<typeof console.error>;
  let warnSpy: MockInstance<typeof console.warn>;
  let exitSpy: MockInstance<typeof process.exit>;

  const skillFile = (name: string) => join(homeDir, '.claude', 'skills', `mcpkit-${name}`, 'SKILL.md');
  const stdout = () => logSpy.mock.calls.map((call) => call.map(String).join(' ')).join('\n');
  const stderr = () => errorSpy.mock.calls.map((call) => call.map(String).join(' ')).join('\n');
  const warnings = () => warnSpy.mock.calls.map((call) => call.map(String).join(' ')).join('\n');
  const update = (...args: string[]) => createUpdateCommand().parseAsync(args, { from: 'user' });

  /** The servers named in `unreachable` fail to connect; every other one answers with NEW_TOOLS. */
  function serversDown(...unreachable: string[]): void {
    vi.mocked(discoverForEntry).mockImplementation(async (entry) => {
      if (unreachable.includes(entry.name)) throw new Error(`connect ECONNREFUSED for ${entry.name}\n    at some stack frame`);
      return { tools: NEW_TOOLS, serverMeta: {} };
    });
  }

  /** A registered server with a skill file and a schema cache from an earlier run. */
  async function registerWithOldFiles(name: string): Promise<void> {
    await addServer(makeEntry(name));
    await mkdir(join(skillFile(name), '..'), { recursive: true });
    await writeFile(skillFile(name), `old skill of ${name}`, 'utf-8');
    await saveSchemaCache(name, OLD_TOOLS);
  }

  beforeEach(async () => {
    homeDir = await mkdtemp(join(tmpdir(), 'mcpkit-update-'));
    process.env.HOME = homeDir;
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never);
  });

  afterEach(async () => {
    if (originalHome === undefined) {
      delete process.env.HOME;
    } else {
      process.env.HOME = originalHome;
    }
    await rm(homeDir, { recursive: true, force: true });
    vi.restoreAllMocks();
    vi.clearAllMocks();
  });

  describe('with no name, when the first server cannot be reached', () => {
    beforeEach(async () => {
      for (const name of ['dead', 'second', 'third', 'fourth']) await registerWithOldFiles(name);
    });

    it('still refreshes every later server', async () => {
      serversDown('dead');

      await update();

      for (const name of ['second', 'third', 'fourth']) {
        expect(await readFile(skillFile(name), 'utf-8'), name).toContain('new_one');
        expect((await loadSchemaCache(name))?.tools, name).toEqual(NEW_TOOLS);
        expect((await getServer(name))?.toolCount, name).toBe(2);
      }
      expect(discoverForEntry).toHaveBeenCalledTimes(4);
    });

    it('leaves the unreachable server with exactly the skill, cache and registry entry it had', async () => {
      const cacheBefore = await readFile(schemaCachePath('dead'), 'utf-8');
      const entryBefore = await getServer('dead');
      serversDown('dead');

      await update();

      expect(await readFile(skillFile('dead'), 'utf-8')).toBe('old skill of dead');
      expect(await readFile(schemaCachePath('dead'), 'utf-8')).toBe(cacheBefore);
      expect(await getServer('dead')).toEqual(entryBefore);
    });

    it('prints one line for every server and a summary naming the failure, and exits 1', async () => {
      serversDown('dead');

      await update();

      expect(stderr()).toMatch(/✗ dead: connect ECONNREFUSED for dead/);
      expect(stderr()).not.toContain('some stack frame');
      for (const name of ['second', 'third', 'fourth']) {
        expect(stdout()).toMatch(new RegExp(`✓ ${name}: 2 tool\\(s\\)`));
      }
      expect(stderr()).toMatch(/Updated 3 of 4 server\(s\); 1 failed: dead/);
      expect(exitSpy).toHaveBeenCalledTimes(1);
      expect(exitSpy).toHaveBeenCalledWith(1);
    });

    it('does not print a credential of the server that the failure quotes', async () => {
      await addServer({
        ...makeEntry('keyed'),
        transport: { type: 'http', url: 'https://host.example/mcp', headers: { 'X-Api-Key': 'HEADERkey-0123456789' } },
      });
      vi.mocked(discoverForEntry).mockRejectedValue(new Error('POST /mcp rejected x-api-key HEADERkey-0123456789'));

      await update('keyed');

      expect(stderr()).toContain('✗ keyed: POST /mcp rejected x-api-key <redacted>');
      expect(stderr()).not.toContain('HEADERkey');
    });

    it('lists every failure when several servers are down, in the order they were tried', async () => {
      serversDown('dead', 'third');

      await update();

      expect(stderr()).toMatch(/Updated 2 of 4 server\(s\); 2 failed: dead, third/);
      expect(exitSpy).toHaveBeenCalledWith(1);
      expect(await readFile(skillFile('third'), 'utf-8')).toBe('old skill of third');
      expect(await readFile(skillFile('second'), 'utf-8')).toContain('new_one');
    });

    it('writes the mcpkit-cli guide for the agents of the servers that were refreshed', async () => {
      serversDown('dead');

      await update();

      expect(existsSync(join(homeDir, '.claude', 'skills', 'mcpkit-cli', 'SKILL.md'))).toBe(true);
    });
  });

  describe('when every server answers', () => {
    it('says so, exits normally and reports each server', async () => {
      await registerWithOldFiles('one');
      await registerWithOldFiles('two');
      serversDown();

      await update();

      expect(stdout()).toMatch(/✓ one: 2 tool\(s\)/);
      expect(stdout()).toMatch(/✓ two: 2 tool\(s\)/);
      expect(stdout()).toMatch(/✓ Updated 2 server\(s\)/);
      expect(stderr()).toBe('');
      expect(exitSpy).not.toHaveBeenCalled();
    });
  });

  describe('a server that needs OAuth sign-in', () => {
    /** The servers named in `needSignIn` throw what a connection without usable tokens throws; the rest answer. */
    function signInNeeded(...needSignIn: string[]): void {
      vi.mocked(discoverForEntry).mockImplementation(async (entry) => {
        if (needSignIn.includes(entry.name)) throw new OAuthRequiredError(entry.name);
        return { tools: NEW_TOOLS, serverMeta: {} };
      });
    }

    it('without a name never signs in: every server is discovered non-interactively', async () => {
      for (const name of ['one', 'two']) await registerWithOldFiles(name);
      signInNeeded();

      await update();

      expect(vi.mocked(discoverForEntry).mock.calls.map(([, opts]) => opts)).toEqual([
        { interactiveAuth: false },
        { interactiveAuth: false },
      ]);
    });

    it('with a name may sign in, because the user asked for that one server', async () => {
      await registerWithOldFiles('one');
      signInNeeded();

      await update('one');

      expect(vi.mocked(discoverForEntry).mock.calls.map(([, opts]) => opts)).toEqual([{ interactiveAuth: true }]);
    });

    it('is skipped with one line and no stack, the later servers are still updated, and the exit code stays 0', async () => {
      for (const name of ['first', 'needs-login', 'last']) await registerWithOldFiles(name);
      signInNeeded('needs-login');

      await update();

      expect(warnings()).toBe('  ⚠ needs-login: needs sign-in (mcpkit auth needs-login); skipped');
      expect(stderr()).not.toContain('needs-login');
      for (const name of ['first', 'last']) {
        expect(stdout(), name).toMatch(new RegExp(`✓ ${name}: 2 tool\\(s\\)`));
        expect(await readFile(skillFile(name), 'utf-8'), name).toContain('new_one');
      }
      expect(stdout()).toContain('✓ Updated 2 of 3 server(s); 1 skipped, needs sign-in: needs-login');
      expect(exitSpy).not.toHaveBeenCalled();
    });

    it('keeps the skill files, schema cache and registry entry it had', async () => {
      await registerWithOldFiles('needs-login');
      const entryBefore = await getServer('needs-login');
      signInNeeded('needs-login');

      await update();

      expect(await readFile(skillFile('needs-login'), 'utf-8')).toBe('old skill of needs-login');
      expect((await loadSchemaCache('needs-login'))?.tools).toEqual(OLD_TOOLS);
      expect(await getServer('needs-login')).toEqual(entryBefore);
    });

    it('does not hide a real failure: the exit code is 1 and the summary counts both', async () => {
      for (const name of ['needs-login', 'dead', 'fine']) await registerWithOldFiles(name);
      vi.mocked(discoverForEntry).mockImplementation(async (entry) => {
        if (entry.name === 'needs-login') throw new OAuthRequiredError(entry.name);
        if (entry.name === 'dead') throw new Error('connect ECONNREFUSED');
        return { tools: NEW_TOOLS, serverMeta: {} };
      });

      await update();

      expect(stderr()).toContain('Updated 1 of 3 server(s); 1 failed: dead; 1 skipped, needs sign-in: needs-login');
      expect(exitSpy).toHaveBeenCalledWith(1);
    });

    it('when it is the only server, nothing is updated and the exit code is still 0', async () => {
      await registerWithOldFiles('needs-login');
      signInNeeded('needs-login');

      await update();

      expect(stdout()).toContain('✓ Updated 0 of 1 server(s); 1 skipped, needs sign-in: needs-login');
      expect(exitSpy).not.toHaveBeenCalled();
    });
  });

  describe('with a name', () => {
    it('exits 1 and keeps the old files when that server cannot be reached', async () => {
      await registerWithOldFiles('dead');
      serversDown('dead');

      await update('dead');

      expect(stderr()).toMatch(/✗ dead: connect ECONNREFUSED/);
      expect(stderr()).toMatch(/Updated 0 of 1 server\(s\); 1 failed: dead/);
      expect(exitSpy).toHaveBeenCalledWith(1);
      expect(await readFile(skillFile('dead'), 'utf-8')).toBe('old skill of dead');
      expect((await loadSchemaCache('dead'))?.tools).toEqual(OLD_TOOLS);
    });

    it('reports an unknown server and exits 1', async () => {
      await update('missing');

      expect(stderr()).toMatch(/"missing" not found/);
      expect(exitSpy).toHaveBeenCalledWith(1);
      expect(discoverForEntry).not.toHaveBeenCalled();
    });
  });
});
