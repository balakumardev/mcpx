import { afterEach, describe, expect, it, vi } from 'vitest';
import { createRuntimeCommand } from './runtime.js';
import { getServer } from '../config.js';
import { getRuntimeStatus, listPersistentRuntimeStatuses, stopRuntime } from '../runtime-manager.js';

vi.mock('../config.js', () => ({
  getServer: vi.fn(),
}));

vi.mock('../runtime-manager.js', () => ({
  getRuntimeStatus: vi.fn(),
  listPersistentRuntimeStatuses: vi.fn(),
  stopRuntime: vi.fn(),
}));

vi.mock('../runtime-host.js', () => ({
  createRuntimeHostForServer: vi.fn(),
}));

afterEach(() => {
  vi.clearAllMocks();
  vi.restoreAllMocks();
});

describe('createRuntimeCommand', () => {
  it('shows status for a named runtime', async () => {
    vi.mocked(getServer).mockResolvedValue({
      name: 'browsermcp',
      transport: { type: 'stdio', command: 'npx', args: [] },
      runtime: { mode: 'persistent', idleTimeoutSec: 900, callTimeoutSec: 3600 },
      toolCount: 1,
      agents: ['cursor'],
      createdAt: '2026-04-14T00:00:00.000Z',
      updatedAt: '2026-04-14T00:00:00.000Z',
    });
    vi.mocked(getRuntimeStatus).mockResolvedValue({
      serverName: 'browsermcp',
      pid: 123,
      socketPath: '/tmp/browser.sock',
      logPath: '/tmp/browser.log',
      fingerprint: 'fingerprint',
      startedAt: '2026-04-14T00:00:00.000Z',
      lastUsedAt: '2026-04-14T00:05:00.000Z',
      idleTimeoutSec: 900,
      callTimeoutSec: 3600,
      running: true,
      configStatus: 'current',
    });
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    const command = createRuntimeCommand();
    await command.parseAsync(['status', 'browsermcp'], { from: 'user' });

    expect(getRuntimeStatus).toHaveBeenCalledWith('browsermcp', expect.any(Object));
    expect(logSpy).toHaveBeenCalled();
  });

  it('stops a named runtime', async () => {
    vi.mocked(stopRuntime).mockResolvedValue(true);
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    const command = createRuntimeCommand();
    await command.parseAsync(['stop', 'browsermcp'], { from: 'user' });

    expect(stopRuntime).toHaveBeenCalledWith('browsermcp');
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('Stopped runtime'));
  });

  it('lists active runtimes when no name is provided', async () => {
    vi.mocked(listPersistentRuntimeStatuses).mockResolvedValue([
      {
        serverName: 'browsermcp',
        pid: 123,
        socketPath: '/tmp/browser.sock',
        logPath: '/tmp/browser.log',
        fingerprint: 'fingerprint',
        startedAt: '2026-04-14T00:00:00.000Z',
        lastUsedAt: '2026-04-14T00:05:00.000Z',
        idleTimeoutSec: 900,
        callTimeoutSec: 3600,
        running: true,
        configStatus: 'current',
      },
    ]);
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    const command = createRuntimeCommand();
    await command.parseAsync(['status'], { from: 'user' });

    expect(listPersistentRuntimeStatuses).toHaveBeenCalledTimes(1);
    expect(logSpy).toHaveBeenCalled();
  });
});
