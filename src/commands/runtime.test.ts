import { afterEach, describe, expect, it, vi } from 'vitest';
import { createRuntimeCommand } from './runtime.js';
import { getServer } from '../config.js';
import { RuntimeAlreadyRunningError } from '../runtime-claim.js';
import { createRuntimeHostForServer } from '../runtime-host.js';
import { getRuntimeStatus, listPersistentRuntimeStatuses, stopRuntimeDaemons } from '../runtime-manager.js';

vi.mock('../config.js', () => ({
  getServer: vi.fn(),
}));

vi.mock('../runtime-manager.js', () => ({
  getRuntimeStatus: vi.fn(),
  listPersistentRuntimeStatuses: vi.fn(),
  stopRuntimeDaemons: vi.fn(),
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

  describe('stop', () => {
    const printed = (spy: { mock: { calls: unknown[][] } }) => spy.mock.calls.map((call) => String(call[0])).join('\n');

    it('stops a named runtime', async () => {
      vi.mocked(stopRuntimeDaemons).mockResolvedValue({ found: true, daemons: [123], killed: [] });
      const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

      const command = createRuntimeCommand();
      await command.parseAsync(['stop', 'browsermcp'], { from: 'user' });

      expect(stopRuntimeDaemons).toHaveBeenCalledWith('browsermcp');
      expect(printed(logSpy)).toContain('Stopped runtime');
      expect(printed(logSpy)).not.toContain('Warning');
    });

    it('says so when nothing was running', async () => {
      vi.mocked(stopRuntimeDaemons).mockResolvedValue({ found: false, daemons: [], killed: [] });
      const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

      await createRuntimeCommand().parseAsync(['stop', 'browsermcp'], { from: 'user' });

      expect(printed(logSpy)).toContain('No persistent runtime is active for "browsermcp"');
    });

    it('reports every daemon it had to stop when the server was running more than once, and any it had to kill', async () => {
      vi.mocked(stopRuntimeDaemons).mockResolvedValue({ found: true, daemons: [11, 22], killed: [22] });
      const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

      await createRuntimeCommand().parseAsync(['stop', 'browsermcp'], { from: 'user' });

      expect(printed(logSpy)).toContain('Stopped runtime');
      expect(printed(logSpy)).toContain('2 daemon processes were running for "browsermcp" (pid 11, 22); all of them were stopped');
      expect(printed(logSpy)).toContain('pid 22 did not exit when asked and was killed with its process group');
    });
  });

  it('warns on status when more than one daemon is recorded for the server', async () => {
    vi.mocked(getServer).mockResolvedValue(undefined);
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
      otherPids: [456],
    });
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    await createRuntimeCommand().parseAsync(['status', 'browsermcp'], { from: 'user' });

    const output = logSpy.mock.calls.map((call) => String(call[0])).join('\n');
    expect(output).toContain('1 more daemon process(es) are recorded for this server (pid 456)');
    expect(output).toContain('mcpkit runtime stop browsermcp');
  });

  describe('a name that is not a valid server name', () => {
    const orphan = {
      serverName: 'my server',
      pid: 123,
      socketPath: '/tmp/orphan.sock',
      logPath: '/tmp/orphan.log',
      fingerprint: 'fingerprint',
      startedAt: '2026-04-14T00:00:00.000Z',
      lastUsedAt: '2026-04-14T00:05:00.000Z',
      idleTimeoutSec: 900,
      callTimeoutSec: 3600,
      running: true,
      orphaned: true,
    };
    const printed = (spy: { mock: { calls: unknown[][] } }) => spy.mock.calls.map((call) => String(call[0])).join('\n');

    it('lists an orphaned runtime with an odd name next to the others, escaped and marked as an orphan', async () => {
      vi.mocked(listPersistentRuntimeStatuses).mockResolvedValue([
        { ...orphan, serverName: 'my\u001b[31m server' },
        { ...orphan, serverName: 'browsermcp', orphaned: undefined, configStatus: 'current' },
      ]);
      const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

      await createRuntimeCommand().parseAsync(['status'], { from: 'user' });

      const output = printed(logSpy);
      expect(output).toContain('"my\\u001b[31m server"');
      expect(output).not.toContain('\u001b[31m server');
      expect(output).toContain('orphaned');
      expect(output).toContain('browsermcp');
    });

    it('shows the runtime recorded under an odd name when it is asked for by that name, without looking it up in the registry', async () => {
      vi.mocked(getRuntimeStatus).mockResolvedValue(orphan);
      const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

      await createRuntimeCommand().parseAsync(['status', 'my server'], { from: 'user' });

      expect(getServer).not.toHaveBeenCalled();
      expect(printed(logSpy)).toContain('orphaned');
    });

    it('prints a clear error and exits 1 when status is asked for an invalid name that has no runtime', async () => {
      vi.mocked(getRuntimeStatus).mockResolvedValue(undefined);
      const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      vi.spyOn(process, 'exit').mockImplementation((() => { throw new Error('exit'); }) as never);

      await expect(createRuntimeCommand().parseAsync(['status', '../etc'], { from: 'user' })).rejects.toThrow('exit');

      expect(printed(errorSpy)).toContain('Invalid server name "../etc"');
      expect(printed(errorSpy)).toContain('No runtime metadata exists under that name either');
      expect(process.exit).toHaveBeenCalledWith(1);
      expect(getServer).not.toHaveBeenCalled();
    });

    it('prints a clear error and exits 1 when stop is given an invalid name with nothing recorded under it', async () => {
      vi.mocked(stopRuntimeDaemons).mockResolvedValue({ found: false, daemons: [], killed: [] });
      const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      vi.spyOn(process, 'exit').mockImplementation((() => { throw new Error('exit'); }) as never);

      await expect(createRuntimeCommand().parseAsync(['stop', 'my server'], { from: 'user' })).rejects.toThrow('exit');

      expect(printed(errorSpy)).toContain('Invalid server name "my server"');
      expect(process.exit).toHaveBeenCalledWith(1);
    });

    it('still stops the orphaned daemon recorded under an odd name', async () => {
      vi.mocked(stopRuntimeDaemons).mockResolvedValue({ found: true, daemons: [123], killed: [] });
      const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

      await createRuntimeCommand().parseAsync(['stop', 'my server'], { from: 'user' });

      expect(stopRuntimeDaemons).toHaveBeenCalledWith('my server');
      expect(printed(logSpy)).toContain('Stopped runtime for "my server"');
    });
  });

  describe('the hidden _host command', () => {
    it('exits 0, with one line in the log and no error, when another host already owns the server', async () => {
      vi.mocked(createRuntimeHostForServer).mockRejectedValue(new RuntimeAlreadyRunningError('browsermcp', 4242));
      const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
      const exit = vi.spyOn(process, 'exit').mockImplementation((() => { throw new Error('exit'); }) as never);
      const signals = vi.spyOn(process, 'on').mockImplementation((() => process) as never);

      await expect(createRuntimeCommand().parseAsync(['_host', 'browsermcp'], { from: 'user' })).rejects.toThrow('exit');

      expect(exit).toHaveBeenCalledWith(0);
      expect(logSpy.mock.calls[0][0]).toMatch(/already running \(pid 4242\)/);
      expect(signals).toHaveBeenCalledWith('SIGTERM', expect.any(Function));
    });

    it('lets any other start-up failure surface, so it ends up in the log with a non-zero exit', async () => {
      vi.mocked(createRuntimeHostForServer).mockRejectedValue(new Error('spawn ENOENT'));
      vi.spyOn(process, 'on').mockImplementation((() => process) as never);

      await expect(createRuntimeCommand().parseAsync(['_host', 'browsermcp'], { from: 'user' })).rejects.toThrow('spawn ENOENT');
    });
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
