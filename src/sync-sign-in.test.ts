import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { MockInstance } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runSync } from './commands/sync.js';
import { addServer } from './config.js';
import { discoverForEntry } from './discover.js';
import { OAuthRequiredError } from './oauth-required-error.js';
import { reconcileSkillFiles } from './skill-sync.js';
import type { ServerEntry, ToolInfo } from './types.js';

vi.mock('./discover.js', () => ({
  discoverForEntry: vi.fn(),
}));

vi.mock('./skill-sync.js', () => ({
  reconcileSkillFiles: vi.fn(),
}));

vi.mock('./meta-skill.js', () => ({
  writeMetaSkill: vi.fn(),
}));

const tools: ToolInfo[] = [{ name: 'echo', description: 'Echo', inputSchema: { type: 'object' } }];

function makeEntry(name: string): ServerEntry {
  const now = new Date().toISOString();
  return {
    name,
    transport: { type: 'stdio', command: 'node', args: [`${name}.js`] },
    toolCount: 5,
    agents: ['claude-code'],
    agentSelectionMode: 'explicit',
    createdAt: now,
    updatedAt: now,
  };
}

describe('sync and servers that need OAuth sign-in', () => {
  const originalHome = process.env.HOME;
  let homeDir = '';
  let warnSpy: MockInstance<typeof console.warn>;
  let logSpy: MockInstance<typeof console.log>;
  const warnings = () => warnSpy.mock.calls.map((call) => call.map(String).join(' '));
  const printed = () => logSpy.mock.calls.map((call) => call.map(String).join(' ')).join('\n');

  beforeEach(async () => {
    homeDir = await mkdtemp(join(tmpdir(), 'mcpkit-sync-signin-'));
    process.env.HOME = homeDir;
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
    for (const name of ['first', 'needs-login', 'last']) await addServer(makeEntry(name));
    vi.mocked(discoverForEntry).mockImplementation(async (entry) => {
      if (entry.name === 'needs-login') throw new OAuthRequiredError(entry.name);
      return { tools, serverMeta: {} };
    });
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

  it('without a name never signs in, skips the server with one line and still syncs the rest', async () => {
    const result = await runSync(undefined, { force: true });

    expect(vi.mocked(discoverForEntry).mock.calls.map(([entry, opts]) => [entry.name, opts.interactiveAuth])).toEqual([
      ['first', false],
      ['needs-login', false],
      ['last', false],
    ]);
    expect(warnings()).toEqual(['  ⚠ needs-login: needs sign-in (mcpkit auth needs-login); skipped']);
    expect(result).toEqual({ synced: 2, skipped: 0, failed: [], needSignIn: ['needs-login'] });
    expect(vi.mocked(reconcileSkillFiles).mock.calls.map(([options]) => options.ctx.serverName)).toEqual(['first', 'last']);
  });

  it('counts the skipped server in its summary, also when nothing else was synced', async () => {
    await runSync(undefined, { force: true });
    expect(printed()).toContain('✓ Synced 2 server(s); 1 skipped, needs sign-in: needs-login');

    logSpy.mockClear();
    vi.mocked(discoverForEntry).mockImplementation(async (entry) => {
      throw new OAuthRequiredError(entry.name);
    });
    await runSync(undefined, { force: true });
    expect(printed()).toContain('3 skipped, needs sign-in: first, needs-login, last');
    expect(printed()).not.toContain('Synced');
  });

  it('a skipped server is not a failure, so a caller that exits 1 on `failed` does not', async () => {
    vi.mocked(discoverForEntry).mockImplementation(async (entry) => {
      if (entry.name === 'needs-login') throw new OAuthRequiredError(entry.name);
      if (entry.name === 'last') throw new Error('connect ECONNREFUSED');
      return { tools, serverMeta: {} };
    });

    const result = await runSync(undefined, { force: true });

    expect(result.needSignIn).toEqual(['needs-login']);
    expect(result.failed).toEqual(['last']);
  });

  it('with a name may sign in, because the user asked for that one server', async () => {
    await runSync('needs-login', { force: true });

    expect(vi.mocked(discoverForEntry).mock.calls.map(([, opts]) => opts)).toEqual([{ interactiveAuth: true }]);
  });
});
