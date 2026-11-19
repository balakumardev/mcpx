import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createSyncCommand } from './commands/sync.js';
import { addServer, getServer, removeServer, updateServer } from './config.js';
import { discoverForEntry } from './discover.js';
import { loadSchemaCache } from './schema-store.js';
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

function makeEntry(): ServerEntry {
  const now = new Date().toISOString();
  return {
    name: 'srv',
    transport: { type: 'stdio', command: 'node', args: ['server.js'] },
    toolCount: 5,
    agents: ['claude-code'],
    agentSelectionMode: 'explicit',
    createdAt: now,
    updatedAt: now,
  };
}

describe('sync that overlaps other commands', () => {
  const originalHome = process.env.HOME;
  let homeDir = '';

  /** Hold discovery open so the test can change the registry while sync is mid-flight. */
  function pendingDiscovery(): { release: () => void; started: Promise<void> } {
    let release = () => {};
    let markStarted = () => {};
    const started = new Promise<void>((resolve) => { markStarted = resolve; });
    vi.mocked(discoverForEntry).mockImplementationOnce(() => new Promise((resolve) => {
      markStarted();
      release = () => resolve({ tools, serverMeta: {} });
    }));
    return { release: () => release(), started };
  }

  beforeEach(async () => {
    homeDir = await mkdtemp(join(tmpdir(), 'mcpkit-sync-overlap-'));
    process.env.HOME = homeDir;
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
    await addServer(makeEntry());
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

  it('keeps an edit made while it discovered tools', async () => {
    const discovery = pendingDiscovery();

    const syncing = createSyncCommand().parseAsync(['srv', '--force'], { from: 'user' });
    await discovery.started;
    await updateServer('srv', (current) => { current.description = 'edited meanwhile'; });
    discovery.release();
    await syncing;

    const stored = await getServer('srv');
    expect(stored?.description).toBe('edited meanwhile');
    expect(stored?.toolCount).toBe(1);
    expect((await loadSchemaCache('srv'))?.tools).toEqual(tools);
  });

  it('does not bring back a server that was removed while it discovered tools', async () => {
    const discovery = pendingDiscovery();

    const syncing = createSyncCommand().parseAsync(['srv', '--force'], { from: 'user' });
    await discovery.started;
    await removeServer('srv');
    discovery.release();
    await syncing;

    expect(await getServer('srv')).toBeUndefined();
    expect(await loadSchemaCache('srv')).toBeNull();
  });
});
