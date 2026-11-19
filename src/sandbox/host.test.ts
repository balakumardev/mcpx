import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ToolCallOutput } from '../client.js';
import type { ServerEntry } from '../types.js';
import { CallBroker, type BrokerDeps, type BrokerSession } from './broker.js';
import type { AllowRule } from './gate.js';
import {
  buildWorkerEnv,
  buildWorkerExecArgv,
  runExec,
  type ExecRequest,
  type HostDeps,
  type WorkerHandle,
} from './host.js';
import { DEFAULT_LIMITS, KILL_GRACE_MS, MAX_ARGS_BYTES, REAP_GRACE_MS } from './limits.js';
import type { ParentMessage } from './protocol.js';

class FakeWorker implements WorkerHandle {
  sent: ParentMessage[] = [];
  killed = false;
  stderr = '';
  onRun: (worker: FakeWorker, message: Extract<ParentMessage, { type: 'run' }>) => void = () => undefined;
  private messageHandler: (raw: unknown) => void = () => undefined;
  private exitHandler: (description: string) => void = () => undefined;

  send(message: ParentMessage): void {
    this.sent.push(message);
    if (message.type === 'run') this.onRun(this, message);
  }
  onMessage(handler: (raw: unknown) => void): void {
    this.messageHandler = handler;
  }
  onExit(handler: (description: string) => void): void {
    this.exitHandler = handler;
  }
  stderrTail(): string {
    return this.stderr;
  }
  async kill(): Promise<void> {
    this.killed = true;
  }
  emit(raw: unknown): void {
    this.messageHandler(raw);
  }
  die(description: string): void {
    this.exitHandler(description);
  }
  results(): ParentMessage[] {
    return this.sent.filter((message) => message.type === 'call-result');
  }
}

function entry(name: string): ServerEntry {
  return {
    name,
    transport: { type: 'stdio', command: 'node', args: [] },
    toolCount: 0,
    agents: [],
    createdAt: '',
    updatedAt: '',
  };
}

const everything: AllowRule[] = [{ server: null, tool: null }];

function setup(options: { callTool?: (name: string, args: Record<string, unknown>) => Promise<ToolCallOutput> } = {}) {
  const worker = new FakeWorker();
  const closed: string[] = [];
  const broker: BrokerDeps = {
    loadServers: async () => ({ fx: entry('fx') }),
    loadCache: async () => null,
    openSession: async (opened): Promise<BrokerSession> => ({
      callTool: options.callTool
        ? (name, args) => options.callTool!(name, args)
        : async (_name, args) => ({ text: '', value: { echoed: args }, isError: false }),
      listTools: async () => [],
      onClose: () => undefined,
      close: async () => {
        closed.push(opened.name);
      },
    }),
  };
  const deps: HostDeps = { spawnWorker: () => worker, broker };
  return { worker, deps, closed };
}

const request = (overrides: Partial<ExecRequest> = {}): ExecRequest => ({
  code: 'return 1',
  policy: { allow: [], allowWrites: false, allowReadOnly: false },
  limits: { ...DEFAULT_LIMITS, timeoutMs: 1000 },
  ...overrides,
});

const done = (result: string, extra: Record<string, unknown> = {}) => ({
  type: 'done',
  ok: true,
  result,
  resultTruncated: false,
  resultBytes: Buffer.byteLength(result),
  ...extra,
});

afterEach(() => {
  vi.useRealTimers();
});

describe('runExec', () => {
  it('sends the run request and builds the ok envelope from logs, calls and the result', async () => {
    const { worker, deps, closed } = setup();
    worker.onRun = (w) => {
      w.emit({ type: 'log', line: 'hello' });
      w.emit({ type: 'call', id: 0, server: 'fx', tool: 'echo', args: '{"m":1}' });
      setTimeout(() => {
        w.emit({ type: 'log', line: '[warn] careful' });
        w.emit(done('{"answer":42}'));
      }, 20);
    };
    const envelope = await runExec(request({ policy: { allow: [{ server: 'fx', tool: 'echo' }], allowWrites: false, allowReadOnly: false } }), deps);

    expect(envelope).toEqual({
      ok: true,
      result: { answer: 42 },
      logs: ['hello', '[warn] careful'],
      calls: 1,
      blocked: [],
      truncated: false,
    });
    expect(Object.keys(envelope)).toEqual(['ok', 'result', 'logs', 'calls', 'blocked', 'truncated']);
    expect(worker.sent[0]).toMatchObject({ type: 'run', code: 'return 1' });
    expect(worker.results()).toEqual([{ type: 'call-result', id: 0, ok: true, json: '{"echoed":{"m":1}}' }]);
    expect(worker.killed).toBe(true);
    expect(closed).toEqual(['fx']);
  });

  it('answers a blocked call with an error and lists it in the envelope even though the script caught it', async () => {
    const { worker, deps, closed } = setup();
    worker.onRun = (w) => {
      w.emit({ type: 'call', id: 0, server: 'fx', tool: 'write_note', args: '{}' });
      w.emit({ type: 'call', id: 1, server: 'fx', tool: 'write_note', args: '{}' });
      setTimeout(() => w.emit(done('"caught"')), 20);
    };
    const envelope = await runExec(request(), deps);

    expect(envelope).toMatchObject({ ok: true, result: 'caught', calls: 2, blocked: ['fx.write_note'] });
    const replies = worker.results();
    expect(replies).toHaveLength(2);
    expect(replies[0]).toMatchObject({ ok: false, error: { kind: 'blocked', tool: 'fx.write_note' } });
    expect(closed).toEqual([]);
  });

  it('reports a script failure with its kind and still returns logs and counts', async () => {
    const { worker, deps } = setup();
    worker.onRun = (w) => {
      w.emit({ type: 'log', line: 'before' });
      w.emit({ type: 'done', ok: false, error: { kind: 'script', message: 'Error: x (script line 1, column 7)' } });
    };
    expect(await runExec(request(), deps)).toEqual({
      ok: false,
      error: { kind: 'script', message: 'Error: x (script line 1, column 7)' },
      logs: ['before'],
      calls: 0,
      blocked: [],
    });
  });

  it('marks the envelope truncated when the child cut the result, with a marker', async () => {
    const { worker, deps } = setup();
    worker.onRun = (w) => w.emit({ type: 'done', ok: true, result: '"aaaa', resultTruncated: true, resultBytes: 5000 });
    const envelope = await runExec(request({ limits: { ...DEFAULT_LIMITS, maxOutputBytes: 5 } }), deps);
    expect(envelope).toMatchObject({ ok: true, truncated: true });
    expect((envelope as { result: string }).result).toBe('"aaaa\n[truncated: the result is 5000 bytes, the limit is 5]');
  });

  it('enforces the log budget itself, whatever the child sends', async () => {
    const { worker, deps } = setup();
    worker.onRun = (w) => {
      for (let i = 0; i < 50; i++) w.emit({ type: 'log', line: 'y'.repeat(20) });
      w.emit(done('1'));
    };
    const envelope = await runExec(request({ limits: { ...DEFAULT_LIMITS, maxOutputBytes: 100 } }), deps);
    expect(envelope).toMatchObject({ ok: true, truncated: true });
    expect(envelope.logs.slice(0, 5)).toEqual(Array(5).fill('y'.repeat(20)));
    expect(envelope.logs).toHaveLength(6);
    expect(envelope.logs[5]).toContain('logs truncated');
  });

  it('marks a failure truncated only when the logs were cut', async () => {
    const { worker, deps } = setup();
    worker.onRun = (w) => {
      w.emit({ type: 'log', line: 'y'.repeat(50) });
      w.emit({ type: 'log', line: 'y'.repeat(50) });
      w.emit({ type: 'done', ok: false, error: { kind: 'script', message: 'x' } });
    };
    expect(await runExec(request({ limits: { ...DEFAULT_LIMITS, maxOutputBytes: 60 } }), deps)).toMatchObject({ ok: false, truncated: true });
  });

  it('turns a result that is not valid JSON into an internal error', async () => {
    const { worker, deps } = setup();
    worker.onRun = (w) => w.emit(done('{not json'));
    expect(await runExec(request(), deps)).toMatchObject({ ok: false, error: { kind: 'internal' } });
  });

  it('caps the clamp on a child-supplied error message', async () => {
    const { worker, deps } = setup();
    worker.onRun = (w) => w.emit({ type: 'done', ok: false, error: { kind: 'script', message: 'x'.repeat(10_000) } });
    const envelope = await runExec(request(), deps);
    expect(envelope.ok).toBe(false);
    expect((envelope as { error: { message: string } }).error.message.length).toBeLessThan(8300);
  });
});

describe('runExec: calls the script did not await', () => {
  it('lists an unawaited blocked call in blocked, though the script finished first', async () => {
    const { worker, deps } = setup();
    worker.onRun = (w) => {
      w.emit({ type: 'call', id: 0, server: 'fx', tool: 'write_note', args: '{}' });
      w.emit(done('1'));
    };
    const envelope = await runExec(request(), deps);
    expect(envelope).toMatchObject({ ok: true, result: 1, calls: 1, blocked: ['fx.write_note'] });
    expect(worker.results()).toEqual([]);
  });

  it('lets an unawaited allowed call finish and counts it, before the sessions are closed', async () => {
    const events: string[] = [];
    const { worker, deps } = setup({
      callTool: async (name) => {
        events.push(`start ${name}`);
        await new Promise((resolve) => setTimeout(resolve, 60));
        events.push(`end ${name}`);
        return { text: '', value: 'written', isError: false };
      },
    });
    const closeSession = deps.broker.openSession;
    deps.broker.openSession = async (opened, timeoutMs) => {
      const session = await closeSession(opened, timeoutMs);
      return {
        ...session,
        close: async () => {
          events.push('close');
          await session.close();
        },
      };
    };
    worker.onRun = (w) => {
      w.emit({ type: 'call', id: 0, server: 'fx', tool: 'write_note', args: '{}' });
      w.emit(done('1'));
    };
    const envelope = await runExec(request({ policy: { allow: everything, allowWrites: false, allowReadOnly: false } }), deps);
    expect(envelope).toMatchObject({ ok: true, result: 1, calls: 1, blocked: [] });
    expect(events).toEqual(['start write_note', 'end write_note', 'close']);
  });

  it('waits for every one of several unawaited calls, even when only some fit the eight slots at first', async () => {
    let finished = 0;
    const { worker, deps } = setup({
      callTool: async () => {
        await new Promise((resolve) => setTimeout(resolve, 20));
        finished++;
        return { text: '', value: 1, isError: false };
      },
    });
    worker.onRun = (w) => {
      for (let id = 0; id < 20; id++) w.emit({ type: 'call', id, server: 'fx', tool: 't', args: '{}' });
      w.emit(done('1'));
    };
    const envelope = await runExec(request({ policy: { allow: everything, allowWrites: false, allowReadOnly: false } }), deps);
    expect(envelope).toMatchObject({ ok: true, calls: 20 });
    expect(finished).toBe(20);
  });

  it('is the timeout failure when calls are still undecided at the end of the time limit', async () => {
    const { worker, deps } = setup();
    deps.broker.loadServers = () => new Promise(() => undefined);
    worker.onRun = (w) => {
      w.emit({ type: 'call', id: 0, server: 'fx', tool: 'write_note', args: '{}' });
      w.emit(done('1'));
    };
    const started = Date.now();
    const envelope = await runExec(request({ limits: { ...DEFAULT_LIMITS, timeoutMs: 100 } }), deps);
    expect(envelope).toMatchObject({
      ok: false,
      error: { kind: 'timeout', message: expect.stringContaining('1 call(s) it did not await were still running') },
      calls: 1,
    });
    expect(Date.now() - started).toBeLessThan(2000);
    expect(worker.killed).toBe(true);
  });

  it('keeps the original failure when the script failed, whatever the calls are doing', async () => {
    const { worker, deps } = setup();
    deps.broker.loadServers = () => new Promise(() => undefined);
    worker.onRun = (w) => {
      w.emit({ type: 'call', id: 0, server: 'fx', tool: 't', args: '{}' });
      w.emit({ type: 'done', ok: false, error: { kind: 'script', message: 'Error: boom' } });
    };
    const envelope = await runExec(request({ limits: { ...DEFAULT_LIMITS, timeoutMs: 100 } }), deps);
    expect(envelope).toMatchObject({ ok: false, error: { kind: 'script', message: 'Error: boom' }, calls: 1 });
  });

  it('stops waiting when the signal aborts', async () => {
    const { worker, deps } = setup();
    deps.broker.loadServers = () => new Promise(() => undefined);
    const controller = new AbortController();
    worker.onRun = (w) => {
      w.emit({ type: 'call', id: 0, server: 'fx', tool: 't', args: '{}' });
      w.emit(done('1'));
      setTimeout(() => controller.abort('SIGINT'), 30);
    };
    const envelope = await runExec(request({ signal: controller.signal }), deps);
    expect(envelope).toMatchObject({ ok: false, error: { kind: 'interrupted', message: 'interrupted by SIGINT' } });
  });
});

describe('runExec: what the script may learn from a failing call', () => {
  it('gets a fixed sentence for an unexpected exception, and the original only on stderr with MCPKIT_DEBUG=1', async () => {
    const call = vi.spyOn(CallBroker.prototype, 'call').mockRejectedValue(new Error('parse error near "Bearer FAKE-YAML-SECRET-6"'));
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    try {
      const { worker, deps } = setup();
      worker.onRun = (w) => {
        w.emit({ type: 'call', id: 0, server: 'fx', tool: 'echo', args: '{}' });
        setTimeout(() => w.emit(done('1')), 20);
      };
      await runExec(request(), deps);
      const reply = worker.results()[0];
      expect(reply).toMatchObject({ ok: false, error: { kind: 'tool', message: 'fx.echo failed unexpectedly (set MCPKIT_DEBUG=1 for details on stderr)' } });
      expect(JSON.stringify(reply)).not.toContain('FAKE-YAML-SECRET-6');
      expect(stderr).not.toHaveBeenCalled();

      vi.stubEnv('MCPKIT_DEBUG', '1');
      const again = setup();
      again.worker.onRun = (w) => {
        w.emit({ type: 'call', id: 0, server: 'fx', tool: 'echo', args: '{}' });
        setTimeout(() => w.emit(done('1')), 20);
      };
      await runExec(request(), again.deps);
      expect(stderr.mock.calls.map((args) => String(args[0])).join('')).toContain('FAKE-YAML-SECRET-6');
    } finally {
      call.mockRestore();
      stderr.mockRestore();
      vi.unstubAllEnvs();
    }
  });
});

describe('runExec: the child is untrusted', () => {
  const malformed: Array<[string, unknown]> = [
    ['a string', 'drop table'],
    ['null', null],
    ['an unknown type', { type: 'shell', command: 'id' }],
    ['a call with a non-string tool', { type: 'call', id: 1, server: 'fx', tool: { a: 1 }, args: '{}' }],
    ['a call with a negative id', { type: 'call', id: -5, server: 'fx', tool: 't', args: '{}' }],
    ['a call with oversized args', { type: 'call', id: 1, server: 'fx', tool: 't', args: 'x'.repeat(MAX_ARGS_BYTES + 1) }],
    ['a done message with an unknown error kind', { type: 'done', ok: false, error: { kind: 'root', message: 'x' } }],
    ['a done message with an oversized result', { type: 'done', ok: true, result: 'x'.repeat(2000), resultTruncated: false, resultBytes: 2000 }],
  ];

  it.each(malformed)('ends the run with an internal error and kills the child on %s', async (_label, raw) => {
    const { worker, deps } = setup();
    worker.onRun = (w) => w.emit(raw);
    const envelope = await runExec(request({ limits: { ...DEFAULT_LIMITS, maxOutputBytes: 1000 } }), deps);
    expect(envelope).toMatchObject({ ok: false, error: { kind: 'internal' } });
    expect((envelope as { error: { message: string } }).error.message).toContain('invalid message');
    expect(worker.killed).toBe(true);
    expect(worker.results()).toEqual([]);
  });

  it('ignores whatever the child says after it is done', async () => {
    const { worker, deps } = setup();
    worker.onRun = (w) => {
      w.emit(done('1'));
      w.emit({ type: 'call', id: 0, server: 'fx', tool: 'write_note', args: '{}' });
      w.emit('garbage');
    };
    const envelope = await runExec(request(), deps);
    expect(envelope).toMatchObject({ ok: true, result: 1, calls: 0 });
  });

  it('does not answer calls past max-calls', async () => {
    const { worker, deps } = setup();
    worker.onRun = (w) => {
      for (let id = 0; id < 4; id++) w.emit({ type: 'call', id, server: 'fx', tool: 'echo', args: '{}' });
      setTimeout(() => w.emit(done('1')), 20);
    };
    const envelope = await runExec(
      request({
        policy: { allow: everything, allowWrites: false, allowReadOnly: false },
        limits: { ...DEFAULT_LIMITS, maxCalls: 2, timeoutMs: 1000 },
      }),
      deps,
    );
    expect(envelope).toMatchObject({ calls: 2 });
    const replies = worker.results();
    expect(replies.filter((reply) => reply.type === 'call-result' && reply.ok)).toHaveLength(2);
    expect(replies.filter((reply) => reply.type === 'call-result' && !reply.ok && reply.error.kind === 'limit')).toHaveLength(2);
  });
});

describe('runExec: the child dies, hangs or is interrupted', () => {
  it('reports a child that exited early, with its stderr', async () => {
    const { worker, deps, closed } = setup();
    worker.stderr = 'RangeError: something broke\n';
    worker.onRun = (w) => w.die('signal SIGSEGV');
    const envelope = await runExec(request(), deps);
    expect(envelope).toMatchObject({ ok: false, error: { kind: 'internal' } });
    const message = (envelope as { error: { message: string } }).error.message;
    expect(message).toContain('signal SIGSEGV');
    expect(message).toContain('RangeError: something broke');
    expect(worker.killed).toBe(true);
    expect(closed).toEqual([]);
  });

  it('kills a child that outlives the timeout plus the grace period', async () => {
    vi.useFakeTimers();
    const { worker, deps } = setup();
    const running = runExec(request({ limits: { ...DEFAULT_LIMITS, timeoutMs: 1000 } }), deps);
    await vi.advanceTimersByTimeAsync(1000 + KILL_GRACE_MS - 1);
    expect(worker.killed).toBe(false);
    await vi.advanceTimersByTimeAsync(2);
    const envelope = await running;
    expect(envelope).toMatchObject({ ok: false, error: { kind: 'timeout' } });
    expect(worker.killed).toBe(true);
  });

  it('keeps the logs streamed before the child was killed', async () => {
    vi.useFakeTimers();
    const { worker, deps } = setup();
    worker.onRun = (w) => w.emit({ type: 'log', line: 'progress' });
    const running = runExec(request({ limits: { ...DEFAULT_LIMITS, timeoutMs: 10 } }), deps);
    await vi.advanceTimersByTimeAsync(10 + KILL_GRACE_MS + 1);
    expect(await running).toMatchObject({ ok: false, logs: ['progress'] });
  });

  it('ends as a failure when the signal aborts, and cleans up', async () => {
    const { worker, deps, closed } = setup();
    const controller = new AbortController();
    worker.onRun = (w) => {
      w.emit({ type: 'call', id: 0, server: 'fx', tool: 'echo', args: '{}' });
      setTimeout(() => controller.abort('SIGINT'), 20);
    };
    const envelope = await runExec(
      request({ policy: { allow: everything, allowWrites: false, allowReadOnly: false }, signal: controller.signal }),
      deps,
    );
    expect(envelope).toMatchObject({ ok: false, error: { kind: 'interrupted', message: 'interrupted by SIGINT' }, calls: 1 });
    expect(worker.killed).toBe(true);
    expect(closed).toEqual(['fx']);
  });

  it('does not start work for a signal that is already aborted', async () => {
    const { worker, deps } = setup();
    const controller = new AbortController();
    controller.abort('SIGTERM');
    const envelope = await runExec(request({ signal: controller.signal }), deps);
    expect(envelope).toMatchObject({ ok: false, error: { message: 'interrupted by SIGTERM' } });
    expect(worker.killed).toBe(true);
  });

  it('returns an internal error when the child cannot be started', async () => {
    const deps: HostDeps = {
      spawnWorker: () => {
        throw new Error('spawn ENOENT');
      },
      broker: setup().deps.broker,
    };
    expect(await runExec(request(), deps)).toMatchObject({
      ok: false,
      error: { kind: 'internal', message: 'could not start the sandbox: spawn ENOENT' },
    });
  });
});

describe('runExec: the deadline is authoritative', () => {
  const timed = (timeoutMs: number) => request({ limits: { ...DEFAULT_LIMITS, timeoutMs } });

  it('sends the sandbox the deadline, so both sides count from the same instant', async () => {
    const { worker, deps } = setup();
    worker.onRun = (w) => w.emit(done('1'));
    const before = Date.now();
    await runExec(timed(5000), deps);
    const run = worker.sent[0] as Extract<ParentMessage, { type: 'run' }>;
    expect(run.deadline).toBeGreaterThanOrEqual(before + 5000);
    expect(run.deadline).toBeLessThanOrEqual(Date.now() + 5000);
  });

  it('turns a result that arrives after the deadline into a timeout, whatever the script did', async () => {
    vi.useFakeTimers();
    const { worker, deps } = setup();
    worker.onRun = (w) => {
      // A script that caught the timeout error of a slow call and went on to finish.
      setTimeout(() => w.emit(done('"carried on"')), 1100);
    };
    const running = runExec(timed(1000), deps);
    await vi.advanceTimersByTimeAsync(1200);
    const envelope = await running;
    expect(envelope).toMatchObject({ ok: false, error: { kind: 'timeout', message: 'the script ran past the time limit of 1000 ms' } });
    expect(envelope).not.toHaveProperty('result');
  });

  it('turns a script error that arrives after the deadline into a timeout too', async () => {
    vi.useFakeTimers();
    const { worker, deps } = setup();
    worker.onRun = (w) => {
      setTimeout(() => w.emit({ type: 'done', ok: false, error: { kind: 'tool', message: 'fx.slow failed' } }), 1100);
    };
    const running = runExec(timed(1000), deps);
    await vi.advanceTimersByTimeAsync(1200);
    expect(await running).toMatchObject({ ok: false, error: { kind: 'timeout' } });
  });

  it('keeps a result that arrives before the deadline', async () => {
    vi.useFakeTimers();
    const { worker, deps } = setup();
    worker.onRun = (w) => {
      setTimeout(() => w.emit(done('"in time"')), 900);
    };
    const running = runExec(timed(1000), deps);
    await vi.advanceTimersByTimeAsync(1000);
    expect(await running).toMatchObject({ ok: true, result: 'in time' });
  });

  it('lets the sandbox report its own timeout inside the grace period', async () => {
    vi.useFakeTimers();
    const { worker, deps } = setup();
    worker.onRun = (w) => {
      setTimeout(() => w.emit({ type: 'done', ok: false, error: { kind: 'timeout', message: 'the script ran past the time limit of 1000 ms' } }), 1050);
    };
    const running = runExec(timed(1000), deps);
    await vi.advanceTimersByTimeAsync(1100);
    expect(await running).toMatchObject({ ok: false, error: { kind: 'timeout', message: 'the script ran past the time limit of 1000 ms' } });
    expect(worker.killed).toBe(true);
  });
});

describe('runExec: ending the processes', () => {
  function instrumented() {
    const rig = setup();
    const events: string[] = [];
    const kill = rig.worker.kill.bind(rig.worker);
    rig.worker.kill = async () => {
      events.push('kill sandbox');
      await kill();
    };
    const broker = rig.deps.broker;
    const openSession = broker.openSession.bind(broker);
    broker.openSession = async (opened, timeoutMs) => {
      const session = await openSession(opened, timeoutMs);
      const close = session.close.bind(session);
      session.close = async () => {
        events.push('close session');
        await close();
      };
      return session;
    };
    rig.deps.processes = {
      refresh: () => {
        events.push('refresh');
      },
      killAllSync: () => undefined,
      reap: async (graceMs) => {
        events.push(`reap ${graceMs}`);
      },
    };
    return { ...rig, events };
  }

  const callThenFinish = (w: FakeWorker, finish: () => void): void => {
    w.emit({ type: 'call', id: 0, server: 'fx', tool: 'echo', args: '{}' });
    setTimeout(finish, 20);
  };
  const allowAll = { allow: everything, allowWrites: false, allowReadOnly: false };

  it('ends the processes first and closes the sessions after, when the run fails', async () => {
    const { worker, deps, events } = instrumented();
    worker.onRun = (w) => callThenFinish(w, () => w.emit({ type: 'done', ok: false, error: { kind: 'script', message: 'x' } }));
    await runExec(request({ policy: allowAll }), deps);
    expect(events).toEqual(['refresh', 'kill sandbox', `reap ${REAP_GRACE_MS}`, 'close session', 'reap 0']);
  });

  it('ends the processes first when the signal aborts, so the interrupt does not wait for a server to close', async () => {
    const { worker, deps, events } = instrumented();
    const controller = new AbortController();
    worker.onRun = (w) => callThenFinish(w, () => controller.abort('SIGINT'));
    await runExec(request({ policy: allowAll, signal: controller.signal }), deps);
    expect(events).toEqual(['refresh', 'kill sandbox', `reap ${REAP_GRACE_MS}`, 'close session', 'reap 0']);
  });

  it('ends the processes first after a timeout', async () => {
    const { worker, deps, events } = instrumented();
    worker.onRun = (w) => w.emit({ type: 'call', id: 0, server: 'fx', tool: 'echo', args: '{}' });
    const envelope = await runExec(request({ policy: allowAll, limits: { ...DEFAULT_LIMITS, timeoutMs: 100 } }), deps);
    expect(envelope).toMatchObject({ ok: false, error: { kind: 'timeout' } });
    expect(events.slice(0, 3)).toEqual(['refresh', 'kill sandbox', `reap ${REAP_GRACE_MS}`]);
  });

  it('lets the servers exit on their own after a clean success, then sweeps up what is left', async () => {
    const { worker, deps, events } = instrumented();
    worker.onRun = (w) => callThenFinish(w, () => w.emit(done('1')));
    expect(await runExec(request({ policy: allowAll }), deps)).toMatchObject({ ok: true });
    expect(events).toEqual(['refresh', 'kill sandbox', 'close session', 'reap 0']);
  });

  it('does not wait for ever on a server whose session never closes', async () => {
    vi.useFakeTimers();
    const { worker, deps, events } = instrumented();
    deps.broker.openSession = async () => ({
      callTool: async () => ({ text: '', value: {}, isError: false }),
      listTools: async () => [],
      onClose: () => undefined,
      close: () => new Promise<void>(() => undefined),
    });
    worker.onRun = (w) => callThenFinish(w, () => w.emit(done('1')));
    const running = runExec(request({ policy: allowAll }), deps);
    await vi.advanceTimersByTimeAsync(3000);
    expect(await running).toMatchObject({ ok: true });
    expect(events).toEqual(['refresh', 'kill sandbox', 'reap 0']);
  });
});

describe('runExec: what was cut from the logs', () => {
  it('marks the envelope truncated and ends the logs with a marker when the sandbox dropped lines', async () => {
    const { worker, deps } = setup();
    worker.onRun = (w) => {
      w.emit({ type: 'log', line: 'kept' });
      w.emit({ type: 'logs-cut' });
      w.emit(done('1', { logs: { droppedLines: 299_990, shortenedLines: 1, removedBytes: 2_500_000 } }));
    };
    const envelope = await runExec(request(), deps);
    expect(envelope).toMatchObject({ ok: true, truncated: true });
    expect(envelope.logs[0]).toBe('kept');
    expect(envelope.logs.at(-1)).toBe(
      `[logs truncated: the limit is ${DEFAULT_LIMITS.maxOutputBytes} bytes; 299990 line(s) dropped, 1 line(s) shortened, about 2500000 byte(s) removed in all]`,
    );
  });

  it('still says the logs were cut when the sandbox is killed before it could count', async () => {
    vi.useFakeTimers();
    const { worker, deps } = setup();
    worker.onRun = (w) => {
      w.emit({ type: 'log', line: 'kept' });
      w.emit({ type: 'logs-cut' });
    };
    const running = runExec(request({ limits: { ...DEFAULT_LIMITS, timeoutMs: 100 } }), deps);
    await vi.advanceTimersByTimeAsync(100 + KILL_GRACE_MS + 1);
    const envelope = await running;
    expect(envelope).toMatchObject({ ok: false, error: { kind: 'timeout' }, truncated: true });
    expect(envelope.logs.at(-1)).toContain('some lines were cut before the sandbox could count them');
  });

  it('adds nothing when nothing was cut', async () => {
    const { worker, deps } = setup();
    worker.onRun = (w) => w.emit(done('1', { logs: { droppedLines: 0, shortenedLines: 0, removedBytes: 0 } }));
    const envelope = await runExec(request(), deps);
    expect(envelope).toMatchObject({ ok: true, truncated: false, logs: [] });
  });
});

describe('runExec: warnings', () => {
  it('puts the sandbox\'s warnings in the envelope, and only when there are some', async () => {
    const { worker, deps } = setup();
    worker.onRun = (w) => w.emit(done('1', { warnings: ['mcp.fx.y() was called after the script returned, so it was not run'] }));
    const envelope = await runExec(request(), deps);
    expect(envelope).toMatchObject({ ok: true, warnings: ['mcp.fx.y() was called after the script returned, so it was not run'] });

    const quiet = setup();
    quiet.worker.onRun = (w) => w.emit(done('1', { warnings: [] }));
    expect(await runExec(request(), quiet.deps)).not.toHaveProperty('warnings');
  });

  it('keeps them on a failure too', async () => {
    const { worker, deps } = setup();
    worker.onRun = (w) => w.emit({ type: 'done', ok: false, error: { kind: 'tool', message: 'x' }, warnings: ['w'] });
    expect(await runExec(request(), deps)).toMatchObject({ ok: false, warnings: ['w'] });
  });
});

describe('runExec: blocked calls are announced', () => {
  it('calls onBlocked for every blocked call, even when the script caught the error, while blocked lists each tool once', async () => {
    const { worker, deps } = setup();
    worker.onRun = (w) => {
      w.emit({ type: 'call', id: 0, server: 'fx', tool: 'write_note', args: '{}' });
      w.emit({ type: 'call', id: 1, server: 'fx', tool: 'write_note', args: '{}' });
      w.emit({ type: 'call', id: 2, server: 'fx', tool: 'other', args: '{}' });
      setTimeout(() => w.emit(done('"caught"')), 20);
    };
    const onBlocked = vi.fn();
    const envelope = await runExec(request({ onBlocked }), deps);
    expect(envelope).toMatchObject({ ok: true, blocked: ['fx.write_note', 'fx.other'] });
    expect(onBlocked.mock.calls).toEqual([['fx', 'write_note'], ['fx', 'write_note'], ['fx', 'other']]);
  });

  it('does not call onBlocked for an allowed call', async () => {
    const { worker, deps } = setup();
    worker.onRun = (w) => {
      w.emit({ type: 'call', id: 0, server: 'fx', tool: 'echo', args: '{}' });
      setTimeout(() => w.emit(done('1')), 20);
    };
    const onBlocked = vi.fn();
    await runExec(request({ policy: { allow: everything, allowWrites: false, allowReadOnly: false }, onBlocked }), deps);
    expect(onBlocked).not.toHaveBeenCalled();
  });
});

describe('the child process environment', () => {
  it('carries nothing from the parent, secrets included', () => {
    const env = buildWorkerEnv({
      MCPKIT_TEST_SECRET: 'hunter2',
      PATH: '/usr/bin',
      HOME: '/home/x',
      NODE_OPTIONS: '--require /tmp/evil.js',
      GITHUB_TOKEN: 'ghp_secret',
    });
    expect(env).toEqual({});
    expect(JSON.stringify(env)).not.toContain('hunter2');
  });

  it('keeps the parent loader flags but drops the inspector', () => {
    expect(buildWorkerExecArgv(['--import', 'tsx', '--inspect=9229', '--inspect-brk', '--max-old-space-size=512'])).toEqual([
      '--import',
      'tsx',
      '--max-old-space-size=512',
    ]);
  });
});
