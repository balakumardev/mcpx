import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ToolCallOutput } from '../client.js';
import type { SchemaCache } from '../schema-store.js';
import type { ServerEntry, ToolInfo } from '../types.js';
import { ErrorCode, McpError } from '@modelcontextprotocol/sdk/types.js';
import {
  BrokerError,
  CallBroker,
  listLiveTools,
  nearestNames,
  type BrokerDeps,
  type BrokerSession,
  type LiveTool,
} from './broker.js';
import { resolveAllowPatterns, type GatePolicy } from './gate.js';
import { MAX_CALL_RESULT_BYTES } from './limits.js';

function entry(name: string): ServerEntry {
  return {
    name,
    transport: { type: 'stdio', command: 'node', args: [] },
    toolCount: 0,
    agents: [],
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  };
}

function tool(name: string, annotations?: ToolInfo['annotations']): ToolInfo {
  return { name, description: '', inputSchema: { type: 'object' }, ...(annotations ? { annotations } : {}) };
}

function cacheOf(server: string, tools: ToolInfo[]): SchemaCache {
  return { version: 1, server, fetchedAt: '2026-02-02T00:00:00.000Z', tools };
}

function ok(value: unknown): ToolCallOutput {
  return { text: JSON.stringify(value), value, isError: false };
}

const policy = (overrides: Partial<GatePolicy> = {}): GatePolicy => ({
  allow: [],
  allowWrites: false,
  allowReadOnly: false,
  ...overrides,
});

/** `--allow` patterns as the gate receives them (resolved against a registry holding `fx`). */
const allowing = (...patterns: string[]) => resolveAllowPatterns(patterns, ['fx']).rules;

interface Rig {
  broker: CallBroker;
  deps: BrokerDeps;
  openSession: ReturnType<typeof vi.fn>;
  /** Every `tools/list` a session answered. */
  listTools: ReturnType<typeof vi.fn>;
  sessionCalls: Array<{ tool: string; args: Record<string, unknown> }>;
  closes: string[];
  /** Simulate the connection of `server`'s newest session closing. */
  dropConnection(server: string): void;
}

function rig(options: {
  policy?: Partial<GatePolicy>;
  servers?: string[];
  /** The schema cache files: for suggestions only, never for the gate. */
  caches?: Record<string, ToolInfo[]>;
  /** What the connected servers list now. */
  live?: Record<string, ToolInfo[]>;
  maxCalls?: number;
  /** Milliseconds from now until the run's deadline. */
  budgetMs?: number;
  callTool?: (server: string, name: string, args: Record<string, unknown>) => Promise<ToolCallOutput>;
} = {}): Rig {
  const servers = Object.fromEntries((options.servers ?? ['fx']).map((name) => [name, entry(name)]));
  const sessionCalls: Rig['sessionCalls'] = [];
  const closes: string[] = [];
  const closeHandlers = new Map<string, Array<() => void>>();
  const listTools = vi.fn(async (server: string): Promise<LiveTool[]> => options.live?.[server] ?? []);
  const openSession = vi.fn(async (opened: ServerEntry): Promise<BrokerSession> => ({
    callTool: async (name, args) => {
      sessionCalls.push({ tool: name, args });
      return options.callTool ? options.callTool(opened.name, name, args) : ok({ echoed: args });
    },
    listTools: () => listTools(opened.name),
    onClose: (handler) => {
      closeHandlers.set(opened.name, [...(closeHandlers.get(opened.name) ?? []), handler]);
    },
    close: async () => {
      closes.push(opened.name);
    },
  }));
  const deps: BrokerDeps = {
    loadServers: async () => servers,
    loadCache: async (server) => {
      const tools = options.caches?.[server];
      return tools ? cacheOf(server, tools) : null;
    },
    openSession,
  };
  const broker = new CallBroker({
    policy: policy(options.policy),
    maxCalls: options.maxCalls ?? 200,
    deadline: Date.now() + (options.budgetMs ?? 120_000),
    deps,
  });
  const dropConnection = (server: string): void => {
    for (const handler of closeHandlers.get(server)?.splice(-1) ?? []) handler();
  };
  return { broker, deps, openSession, listTools, sessionCalls, closes, dropConnection };
}

async function failure(promise: Promise<unknown>): Promise<BrokerError> {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(BrokerError);
    return error as BrokerError;
  }
  throw new Error('expected the call to fail');
}

describe('CallBroker: servers', () => {
  it('names the registered servers when the server is unknown', async () => {
    const { broker } = rig({ servers: ['alpha', 'beta'], policy: { allowWrites: true } });
    const error = await failure(broker.call('gamma', 'x', '{}'));
    expect(error.kind).toBe('tool');
    expect(error.message).toBe('mcpkit: unknown server "gamma". Registered servers: alpha, beta.');
  });

  it('says so when nothing is registered', async () => {
    const { broker } = rig({ servers: [], policy: { allowWrites: true } });
    expect((await failure(broker.call('gamma', 'x', '{}'))).message).toContain('No servers are registered');
  });

  it('does not mistake inherited object properties for servers', async () => {
    const { broker } = rig({ policy: { allowWrites: true } });
    expect((await failure(broker.call('constructor', 'x', '{}'))).message).toContain('unknown server "constructor"');
    expect((await failure(broker.call('__proto__', 'x', '{}'))).message).toContain('unknown server');
  });

  it('opens one session per server, lazily, and reuses it', async () => {
    const { broker, openSession } = rig({ servers: ['a', 'b'], policy: { allowWrites: true } });
    expect(openSession).not.toHaveBeenCalled();
    await broker.call('a', 't1', '{}');
    await broker.call('a', 't2', '{}');
    await broker.call('b', 't1', '{}');
    expect(openSession).toHaveBeenCalledTimes(2);
    expect(openSession.mock.calls.map((call) => (call[0] as ServerEntry).name)).toEqual(['a', 'b']);
  });

  it('opens a session with what is left of the run as its call timeout', async () => {
    const { broker, openSession } = rig({ policy: { allowWrites: true }, budgetMs: 60_000 });
    await broker.call('fx', 't', '{}');
    const timeoutMs = openSession.mock.calls[0][1] as number;
    expect(timeoutMs).toBeLessThanOrEqual(60_000);
    expect(timeoutMs).toBeGreaterThan(50_000);
  });

  it('does not let one call outlive the deadline of the run', async () => {
    const { broker } = rig({
      policy: { allowWrites: true },
      budgetMs: 80,
      callTool: () => new Promise(() => undefined),
    });
    const started = Date.now();
    const error = await failure(broker.call('fx', 'slow', '{}'));
    expect(error.kind).toBe('timeout');
    expect(error.tool).toBe('fx.slow');
    expect(Date.now() - started).toBeLessThan(2000);
  });

  it('closes every session, including one that is still opening', async () => {
    const { broker, closes } = rig({ servers: ['a', 'b'], policy: { allowWrites: true } });
    await broker.call('a', 't', '{}');
    await broker.call('b', 't', '{}');
    await broker.close();
    expect(closes.sort()).toEqual(['a', 'b']);
    expect((await failure(broker.call('a', 't', '{}'))).message).toContain('run is over');
  });

  it('shrugs off a session that failed to open when closing', async () => {
    const failing = rig({ policy: { allowWrites: true } });
    failing.openSession.mockRejectedValueOnce(new Error('"fx" needs OAuth sign-in: run `mcpkit auth fx` first'));
    const error = await failure(failing.broker.call('fx', 't', '{}'));
    expect(error.message).toContain('mcpkit auth fx');
    expect(error.kind).toBe('tool');
    await expect(failing.broker.close()).resolves.toBe(true);
  });
});

describe('CallBroker: the write gate', () => {
  it('blocks by default, records the call once, and never starts the server', async () => {
    const { broker, openSession, listTools } = rig();
    for (let i = 0; i < 2; i++) {
      const error = await failure(broker.call('fx', 'write_note', '{"text":"x"}'));
      expect(error.kind).toBe('blocked');
      expect(error.tool).toBe('fx.write_note');
      expect(error.message).toBe(
        'mcpkit: blocked fx.write_note (not allowed). Re-run with --allow fx.write_note, '
          + '--allow-read-only (if the server marks it read-only) or --allow-writes.',
      );
    }
    expect(broker.blocked).toEqual(['fx.write_note']);
    expect(openSession).not.toHaveBeenCalled();
    expect(listTools).not.toHaveBeenCalled();
  });

  it('allows an exact pattern, a server wildcard, a tool wildcard and *', async () => {
    for (const patterns of [['fx.echo'], ['fx.*'], ['*.echo'], ['*']]) {
      const { broker } = rig({ policy: { allow: allowing(...patterns) } });
      expect(JSON.parse(await broker.call('fx', 'echo', '{"m":1}'))).toEqual({ echoed: { m: 1 } });
      expect(broker.blocked).toEqual([]);
    }
  });

  it('keeps blocking what the pattern does not name', async () => {
    const { broker } = rig({ policy: { allow: allowing('fx.echo') } });
    expect((await failure(broker.call('fx', 'write_note', '{}'))).kind).toBe('blocked');
  });

  it('allows everything with allowWrites', async () => {
    const { broker } = rig({ policy: { allowWrites: true } });
    await expect(broker.call('fx', 'write_note', '{}')).resolves.toBeDefined();
  });

  it('with allowReadOnly, runs only tools whose live annotations say readOnlyHint: true', async () => {
    const tools = [
      tool('echo', { readOnlyHint: true }),
      tool('write_note', { readOnlyHint: false, destructiveHint: true }),
      tool('unannotated'),
    ];
    const { broker, sessionCalls } = rig({ policy: { allowReadOnly: true }, live: { fx: tools } });
    await broker.call('fx', 'echo', '{}');
    expect((await failure(broker.call('fx', 'write_note', '{}'))).kind).toBe('blocked');
    expect((await failure(broker.call('fx', 'unannotated', '{}'))).kind).toBe('blocked');
    expect(sessionCalls.map((call) => call.tool)).toEqual(['echo']);
    expect(broker.blocked).toEqual(['fx.write_note', 'fx.unannotated']);
  });

  it('with allowReadOnly, takes the hint from the live tool list and never from the schema cache', async () => {
    // A cache left behind by a server that was replaced claims write_note is read-only.
    const { broker, sessionCalls } = rig({
      policy: { allowReadOnly: true },
      caches: { fx: [tool('write_note', { readOnlyHint: true }), tool('echo', { readOnlyHint: true })] },
      live: { fx: [tool('write_note', { readOnlyHint: false }), tool('echo')] },
    });
    expect((await failure(broker.call('fx', 'write_note', '{}'))).kind).toBe('blocked');
    expect((await failure(broker.call('fx', 'echo', '{}'))).kind).toBe('blocked');
    expect(sessionCalls).toEqual([]);
    expect(broker.blocked).toEqual(['fx.write_note', 'fx.echo']);
  });

  it('with allowReadOnly, lists the tools once per server for any number of concurrent calls, and opens one session', async () => {
    const { broker, openSession, listTools, sessionCalls } = rig({
      policy: { allowReadOnly: true },
      live: { fx: [tool('echo', { readOnlyHint: true })] },
    });
    const results = await Promise.all(Array.from({ length: 40 }, (_, index) => broker.call('fx', 'echo', JSON.stringify({ index }))));
    expect(results).toHaveLength(40);
    expect(openSession).toHaveBeenCalledTimes(1);
    expect(listTools).toHaveBeenCalledTimes(1);
    expect(sessionCalls).toHaveLength(40);
  });

  it('with allowReadOnly, keeps one tool list per server', async () => {
    const live = { a: [tool('t', { readOnlyHint: true })], b: [tool('t', { readOnlyHint: true })] };
    const { broker, openSession, listTools } = rig({ servers: ['a', 'b'], policy: { allowReadOnly: true }, live });
    await Promise.all([broker.call('a', 't', '{}'), broker.call('b', 't', '{}'), broker.call('a', 't', '{}'), broker.call('b', 't', '{}')]);
    expect(openSession).toHaveBeenCalledTimes(2);
    expect(listTools.mock.calls.map((call) => call[0]).sort()).toEqual(['a', 'b']);
  });

  it('explicit --allow and allowWrites need neither a tool list nor a lookup before the call', async () => {
    const { broker, listTools } = rig({ policy: { allowReadOnly: true, allow: allowing('fx.write_note') } });
    await broker.call('fx', 'write_note', '{}');
    const writes = rig({ policy: { allowWrites: true } });
    await writes.broker.call('fx', 'write_note', '{}');
    expect(listTools).not.toHaveBeenCalled();
    expect(writes.listTools).not.toHaveBeenCalled();
  });

  it('with allowReadOnly, names the nearest live tools for an unknown tool', async () => {
    const { broker, sessionCalls } = rig({ policy: { allowReadOnly: true }, live: { fx: [tool('echo', { readOnlyHint: true })] } });
    const error = await failure(broker.call('fx', 'ech0', '{}'));
    expect(error.kind).toBe('tool');
    expect(error.message).toBe('mcpkit: unknown tool fx.ech0. Did you mean: echo?');
    expect(sessionCalls).toEqual([]);
    expect(broker.blocked).toEqual([]);
  });

  it('reports a failing tool list as a tool error, and asks again on the next call', async () => {
    const { broker, listTools, openSession } = rig({
      policy: { allowReadOnly: true },
      live: { fx: [tool('echo', { readOnlyHint: true })] },
    });
    listTools.mockRejectedValueOnce(new Error('connection refused'));
    const error = await failure(broker.call('fx', 'echo', '{}'));
    expect(error.kind).toBe('tool');
    expect(error.message).toContain('could not look up the tools of fx: connection refused');
    await expect(broker.call('fx', 'echo', '{}')).resolves.toBeDefined();
    expect(listTools).toHaveBeenCalledTimes(2);
    expect(openSession).toHaveBeenCalledTimes(1);
  });

  it('forgets a session that failed to open: the next call opens a fresh one', async () => {
    const { broker, openSession } = rig({ policy: { allowWrites: true } });
    openSession.mockRejectedValueOnce(new Error('spawn failed'));
    expect((await failure(broker.call('fx', 't', '{}'))).message).toBe('fx.t failed: spawn failed');
    await expect(broker.call('fx', 't', '{}')).resolves.toBeDefined();
    expect(openSession).toHaveBeenCalledTimes(2);
  });
});

describe('CallBroker: unknown tools', () => {
  const tools = [tool('echo'), tool('add'), tool('write_note'), tool('list_items'), tool('slow'), tool('big')];

  it('names the nearest tools instead of saying blocked, when the cache knows the server', async () => {
    const { broker, openSession } = rig({ caches: { fx: tools } });
    const error = await failure(broker.call('fx', 'ech0', '{}'));
    expect(error.kind).toBe('tool');
    expect(error.message).toContain('unknown tool fx.ech0.');
    expect(error.message).toContain('Did you mean: echo,');
    expect(error.message).toContain('mcpkit update fx');
    expect(broker.blocked).toEqual([]);
    expect(openSession).not.toHaveBeenCalled();
  });

  it('does the same under allowReadOnly, from the live tool list', async () => {
    const { broker } = rig({ policy: { allowReadOnly: true }, live: { fx: tools } });
    const error = await failure(broker.call('fx', 'writ_note', '{}'));
    expect(error.message).toContain('Did you mean: write_note');
  });

  it('adds the nearest tools when an allowed call fails and the cache lacks the tool', async () => {
    const { broker } = rig({
      policy: { allow: allowing('fx.*') },
      caches: { fx: tools },
      callTool: async () => ({ text: 'Unknown tool: ech0', value: 'Unknown tool: ech0', isError: true }),
    });
    const error = await failure(broker.call('fx', 'ech0', '{}'));
    expect(error.message).toContain('fx.ech0 failed: Unknown tool: ech0');
    expect(error.message).toContain('Did you mean: echo');
  });

  it('does not guess when the tool exists in the cache', async () => {
    const { broker } = rig({
      policy: { allow: allowing('fx.*') },
      caches: { fx: tools },
      callTool: async () => ({ text: 'boom', value: 'boom', isError: true }),
    });
    expect((await failure(broker.call('fx', 'echo', '{}'))).message).toBe('fx.echo failed: boom');
  });
});

describe('nearestNames', () => {
  const names = ['echo', 'add', 'write_note', 'list_items', 'slow', 'big', 'read_note', 'delete_note'];

  it('puts the closest spelling first and returns at most the limit', () => {
    expect(nearestNames('ech', names)[0]).toBe('echo');
    expect(nearestNames('writenote', names)[0]).toBe('write_note');
    expect(nearestNames('x', names)).toHaveLength(5);
    expect(nearestNames('x', names, 2)).toHaveLength(2);
  });

  it('prefers names that contain the typed text', () => {
    expect(nearestNames('note', names).slice(0, 3).sort()).toEqual(['delete_note', 'read_note', 'write_note']);
  });

  it('copes with an empty list', () => {
    expect(nearestNames('x', [])).toEqual([]);
  });
});

describe('CallBroker: calls and results', () => {
  it('returns the JSON text of the normalised value', async () => {
    const { broker } = rig({
      policy: { allowWrites: true },
      callTool: async () => ok({ items: [1, 2, 3] }),
    });
    expect(await broker.call('fx', 'list_items', '{}')).toBe('{"items":[1,2,3]}');
  });

  it('returns null for a result with no value', async () => {
    const { broker } = rig({ policy: { allowWrites: true }, callTool: async () => ({ text: '', value: undefined, isError: false }) });
    expect(await broker.call('fx', 't', '{}')).toBe('null');
  });

  it('turns isError into a tool error carrying the server text', async () => {
    const { broker } = rig({
      policy: { allowWrites: true },
      callTool: async () => ({ text: 'deliberate failure', value: 'deliberate failure', isError: true }),
    });
    const error = await failure(broker.call('fx', 'fail', '{}'));
    expect(error.kind).toBe('tool');
    expect(error.tool).toBe('fx.fail');
    expect(error.message).toBe('fx.fail failed: deliberate failure');
  });

  it('turns an exception from the session into a tool error', async () => {
    const { broker } = rig({
      policy: { allowWrites: true },
      callTool: async () => {
        throw new Error('Connection closed');
      },
    });
    expect((await failure(broker.call('fx', 't', '{}'))).message).toBe('fx.t failed: Connection closed');
  });

  it('refuses arguments that are not a JSON object', async () => {
    const { broker, openSession } = rig({ policy: { allowWrites: true } });
    for (const bad of ['not json', '[1]', '"s"', 'null', '5']) {
      expect((await failure(broker.call('fx', 't', bad))).kind).toBe('tool');
    }
    expect(openSession).not.toHaveBeenCalled();
  });

  it('refuses a result larger than the cap', async () => {
    const { broker } = rig({
      policy: { allowWrites: true },
      callTool: async () => ok('x'.repeat(MAX_CALL_RESULT_BYTES)),
    });
    const error = await failure(broker.call('fx', 't', '{}'));
    expect(error.kind).toBe('limit');
    expect(error.message).toContain('larger than');
  });

  it('counts every call, blocked ones included, and refuses past max-calls', async () => {
    const { broker } = rig({ policy: { allow: allowing('fx.ok') }, maxCalls: 3 });
    await broker.call('fx', 'ok', '{}');
    await failure(broker.call('fx', 'no', '{}'));
    await broker.call('fx', 'ok', '{}');
    expect(broker.calls).toBe(3);
    const error = await failure(broker.call('fx', 'ok', '{}'));
    expect(error.kind).toBe('limit');
    expect(error.message).toContain('--max-calls');
    expect(broker.calls).toBe(3);
  });

  it('runs at most 8 calls at once and lets the rest wait', async () => {
    let inFlight = 0;
    let peak = 0;
    const releases: Array<() => void> = [];
    const { broker } = rig({
      policy: { allowWrites: true },
      callTool: async () => {
        inFlight++;
        peak = Math.max(peak, inFlight);
        await new Promise<void>((resolve) => releases.push(resolve));
        inFlight--;
        return ok(1);
      },
    });
    const all = Array.from({ length: 20 }, () => broker.call('fx', 't', '{}'));
    await vi.waitFor(() => expect(inFlight).toBe(8));
    expect(releases).toHaveLength(8);
    while (releases.length > 0 || inFlight > 0) {
      releases.splice(0).forEach((release) => release());
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
    await Promise.all(all);
    expect(peak).toBe(8);
  });
});

describe('CallBroker: a connection that closes', () => {
  it('forgets the session: the failing call says the connection closed and is not retried, the next call opens a fresh one', async () => {
    let attempts = 0;
    const { broker, openSession, sessionCalls, dropConnection } = rig({
      policy: { allowWrites: true },
      callTool: async () => {
        attempts++;
        if (attempts === 1) {
          dropConnection('fx');
          throw new McpError(ErrorCode.ConnectionClosed, 'Connection closed');
        }
        return ok('fresh');
      },
    });

    const error = await failure(broker.call('fx', 'write', '{"n":1}'));
    expect(error.kind).toBe('tool');
    expect(error.message).toContain('the connection to fx closed during the call');
    expect(error.message).toContain('not retried');
    expect(sessionCalls).toHaveLength(1);

    expect(JSON.parse(await broker.call('fx', 'write', '{"n":2}'))).toBe('fresh');
    expect(openSession).toHaveBeenCalledTimes(2);
    expect(sessionCalls.map((call) => call.args)).toEqual([{ n: 1 }, { n: 2 }]);
  });

  it('says the connection closed even when only the close callback told it (the call failed with another message)', async () => {
    const { broker, dropConnection } = rig({
      policy: { allowWrites: true },
      callTool: async () => {
        dropConnection('fx');
        throw new Error('Not connected');
      },
    });
    expect((await failure(broker.call('fx', 't', '{}'))).message).toContain('the connection to fx closed during the call');
  });

  it('lists the tools of the fresh session again for allowReadOnly', async () => {
    const { broker, listTools, openSession, dropConnection } = rig({
      policy: { allowReadOnly: true },
      live: { fx: [tool('echo', { readOnlyHint: true })] },
    });
    await broker.call('fx', 'echo', '{}');
    dropConnection('fx');
    await broker.call('fx', 'echo', '{}');
    expect(openSession).toHaveBeenCalledTimes(2);
    expect(listTools).toHaveBeenCalledTimes(2);
  });

  it('closes the dead session and still closes the live one at the end', async () => {
    const { broker, closes, dropConnection } = rig({ policy: { allowWrites: true } });
    await broker.call('fx', 't', '{}');
    dropConnection('fx');
    expect(closes).toEqual(['fx']);
    await broker.call('fx', 't', '{}');
    await broker.close();
    expect(closes).toEqual(['fx', 'fx']);
  });
});

describe('CallBroker: what a script may learn from a failure', () => {
  const secretEntry = (): ServerEntry => ({
    ...entry('fx'),
    transport: {
      type: 'http',
      url: 'https://user:FAKE-USERINFO-PW@host.example/mcp?api_key=FAKE-QUERY-KEY-1',
      headers: { Authorization: 'Bearer ${FAKE_HEADER_ENV}', 'X-Key': 'FAKE-RAW-HEADER-9' },
    },
    envHints: { FAKE_HEADER_ENV: 'mint it with: vault read FAKE-HINT-RECIPE' },
    paramProvider: { command: 'fake-helper', args: ['--token=FAKE-PROVIDER-ARG-3'] },
  });

  function failingRig(message: string) {
    vi.stubEnv('FAKE_HEADER_ENV', 'FAKE-RESOLVED-HEADER-7');
    const fx = secretEntry();
    const deps: BrokerDeps = {
      loadServers: async () => ({ fx }),
      loadCache: async () => null,
      openSession: async () => {
        throw new Error(message);
      },
    };
    return new CallBroker({ policy: policy({ allowWrites: true }), maxCalls: 10, deadline: Date.now() + 60_000, deps });
  }

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it.each([
    ['the URL with its credentials', 'Request cannot be constructed from a URL that includes credentials: https://user:FAKE-USERINFO-PW@host.example/mcp?api_key=FAKE-QUERY-KEY-1'],
    ['the query string', 'GET https://host.example/mcp?api_key=FAKE-QUERY-KEY-1 failed'],
    ['a resolved header value', 'sent Authorization: Bearer FAKE-RESOLVED-HEADER-7'],
    ['a literal header value', 'rejected header FAKE-RAW-HEADER-9'],
    ['a param provider argument', 'Command failed: fake-helper --token=FAKE-PROVIDER-ARG-3'],
    ['the hint of an environment variable', 'Environment variable "FAKE_HEADER_ENV" is not set.\n\nHint: mint it with: vault read FAKE-HINT-RECIPE'],
  ])('does not pass %s from a connection error to the script', async (_label, message) => {
    const error = await failure(failingRig(message).call('fx', 'echo', '{}'));
    expect(error.kind).toBe('tool');
    expect(error.message).toMatch(/^fx\.echo failed: /);
    for (const secret of ['FAKE-USERINFO-PW', 'FAKE-QUERY-KEY-1', 'FAKE-RESOLVED-HEADER-7', 'FAKE-RAW-HEADER-9', 'FAKE-PROVIDER-ARG-3', 'FAKE-HINT-RECIPE']) {
      expect(error.message).not.toContain(secret);
    }
  });

  it('keeps the useful part of the message', async () => {
    const error = await failure(failingRig('fetch failed (ECONNREFUSED) for https://host.example/mcp?api_key=FAKE-QUERY-KEY-1').call('fx', 'echo', '{}'));
    expect(error.message).toBe('fx.echo failed: fetch failed (ECONNREFUSED) for https://host.example/mcp<redacted>');
  });

  it('applies to the lookup of the tools too', async () => {
    vi.stubEnv('FAKE_HEADER_ENV', 'FAKE-RESOLVED-HEADER-7');
    const fx = secretEntry();
    const deps: BrokerDeps = {
      loadServers: async () => ({ fx }),
      loadCache: async () => null,
      openSession: async () => {
        throw new Error('401 for Bearer FAKE-RESOLVED-HEADER-7');
      },
    };
    const broker = new CallBroker({ policy: policy({ allowReadOnly: true }), maxCalls: 10, deadline: Date.now() + 60_000, deps });
    const error = await failure(broker.call('fx', 'echo', '{}'));
    expect(error.message).not.toContain('FAKE-RESOLVED-HEADER-7');
  });

  it('writes the original to stderr only with MCPKIT_DEBUG=1', async () => {
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    try {
      await failure(failingRig('boom FAKE-QUERY-KEY-1').call('fx', 'echo', '{}'));
      expect(stderr).not.toHaveBeenCalled();
      vi.stubEnv('MCPKIT_DEBUG', '1');
      await failure(failingRig('boom FAKE-QUERY-KEY-1').call('fx', 'echo', '{}'));
      expect(stderr.mock.calls.map((call) => String(call[0])).join('')).toContain('boom FAKE-QUERY-KEY-1');
    } finally {
      stderr.mockRestore();
    }
  });

  it('gives the script a fixed sentence when the registry cannot be read', async () => {
    const deps: BrokerDeps = {
      loadServers: async () => {
        throw new Error('bad YAML near "Authorization: Bearer FAKE-YAML-SECRET-6"');
      },
      loadCache: async () => null,
      openSession: async () => {
        throw new Error('unreachable');
      },
    };
    const broker = new CallBroker({ policy: policy({ allowWrites: true }), maxCalls: 10, deadline: Date.now() + 60_000, deps });
    const error = await failure(broker.call('fx', 'echo', '{}'));
    expect(error.message).toBe('mcpkit: could not read the server registry (`mcpkit list` shows why)');
  });
});

describe('listLiveTools', () => {
  it('follows the pagination cursor and keeps the annotations', async () => {
    const pages = [
      { tools: [{ name: 'a', annotations: { readOnlyHint: true } }], nextCursor: 'c1' },
      { tools: [{ name: 'b' }], nextCursor: 'c2' },
      { tools: [{ name: 'c' }] },
    ];
    const listTools = vi.fn(async (_request?: { cursor: string }) => pages.shift()!);
    const tools = await listLiveTools({ listTools } as never);
    expect(tools.map((candidate) => candidate.name)).toEqual(['a', 'b', 'c']);
    expect(tools[0].annotations).toEqual({ readOnlyHint: true });
    expect(listTools.mock.calls.map((call) => call[0])).toEqual([undefined, { cursor: 'c1' }, { cursor: 'c2' }]);
  });

  it('stops at a cursor it has seen', async () => {
    const listTools = vi.fn(async (_request?: { cursor: string }) => ({ tools: [{ name: 'a' }], nextCursor: 'same' }));
    await listLiveTools({ listTools } as never);
    expect(listTools).toHaveBeenCalledTimes(2);
  });
});

describe('CallBroker: credentials in a URL too short for the length cut-off', () => {
  it('hides a short user:password and a short query from a connection error', async () => {
    const fx: ServerEntry = {
      ...entry('fx'),
      transport: { type: 'http', url: 'https://bob:pw123@host.example/mcp?k=ab12' },
    };
    const deps: BrokerDeps = {
      loadServers: async () => ({ fx }),
      loadCache: async () => null,
      openSession: async () => {
        throw new Error('Request cannot be constructed from a URL that includes credentials: https://bob:pw123@host.example/mcp?k=ab12');
      },
    };
    const broker = new CallBroker({ policy: policy({ allowWrites: true }), maxCalls: 10, deadline: Date.now() + 60_000, deps });
    const error = await failure(broker.call('fx', 'echo', '{}'));
    expect(error.message).toBe(
      'fx.echo failed: Request cannot be constructed from a URL that includes credentials: https://<redacted>@host.example/mcp<redacted>',
    );
    for (const secret of ['bob', 'pw123', 'ab12']) expect(error.message).not.toContain(secret);
  });

  it('hides a username with no password, and percent-encoded credentials as decoded', async () => {
    const fx: ServerEntry = {
      ...entry('fx'),
      transport: { type: 'http', url: 'https://tok%40en:p%3Aw@host.example/mcp' },
    };
    const deps: BrokerDeps = {
      loadServers: async () => ({ fx }),
      loadCache: async () => null,
      openSession: async () => {
        throw new Error('failed for https://tok%40en:p%3Aw@host.example/mcp and tok@en:p:w@host.example');
      },
    };
    const broker = new CallBroker({ policy: policy({ allowWrites: true }), maxCalls: 10, deadline: Date.now() + 60_000, deps });
    const error = await failure(broker.call('fx', 'echo', '{}'));
    expect(error.message).toBe('fx.echo failed: failed for https://<redacted>@host.example/mcp and <redacted>@host.example');
  });
});
