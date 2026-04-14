import { afterEach, describe, expect, it, vi } from 'vitest';

afterEach(() => {
  delete (globalThis as typeof globalThis & { __PKG_VERSION__?: string }).__PKG_VERSION__;
  vi.resetModules();
  vi.clearAllMocks();
  vi.restoreAllMocks();
});

describe('createCallCommand persistent runtime routing', () => {
  it('routes configured persistent stdio servers through the runtime manager', async () => {
    (globalThis as typeof globalThis & { __PKG_VERSION__?: string }).__PKG_VERSION__ = 'test';

    const entry = {
      name: 'browsermcp',
      transport: { type: 'stdio' as const, command: 'npx', args: [] },
      runtime: { mode: 'persistent' as const, idleTimeoutSec: 900 },
      toolCount: 1,
      agents: ['cursor'],
      createdAt: '2026-04-14T00:00:00.000Z',
      updatedAt: '2026-04-14T00:00:00.000Z',
    };

    const getServer = vi.fn().mockResolvedValue(entry);
    const callPersistentRuntime = vi.fn().mockResolvedValue(['runtime-result']);
    const stdoutWrite = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);

    vi.doMock('../config.js', () => ({
      getServer,
    }));
    vi.doMock('../client.js', () => ({
      callTool: vi.fn(),
      callToolsChained: vi.fn(),
      connectToolSession: vi.fn(),
    }));
    vi.doMock('../auth.js', () => ({
      authenticateIfNeeded: vi.fn(),
    }));
    vi.doMock('../runtime-config.js', async () => {
      const actual = await vi.importActual<typeof import('../runtime-config.js')>('../runtime-config.js');
      return {
        ...actual,
        isPersistentRuntimeEntry: vi.fn(() => true),
      };
    });
    vi.doMock('../runtime-manager.js', () => ({
      callPersistentRuntime,
    }));

    const { createCallCommand } = await import('./call.js');
    const command = createCallCommand();
    await command.parseAsync(['browsermcp', 'create_session', '{"browser":"chrome"}'], { from: 'user' });

    expect(callPersistentRuntime).toHaveBeenCalledWith('browsermcp', entry, [
      {
        toolName: 'create_session',
        params: { browser: 'chrome' },
      },
    ]);
    expect(stdoutWrite).toHaveBeenCalledWith('runtime-result');
  });
});
