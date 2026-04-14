import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { getRegistryPath, loadRegistry } from './config.js';

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
});
