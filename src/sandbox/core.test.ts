import { describe, expect, it } from 'vitest';
import { HostCallError, runSandbox, type HostCall, type SandboxOutcome } from './core.js';
import { DEFAULT_LIMITS, type SandboxLimits } from './limits.js';

const noCalls: HostCall = async () => {
  throw new Error('no host call expected');
};

function run(code: string, options: { limits?: Partial<SandboxLimits>; hostCall?: HostCall } = {}): Promise<SandboxOutcome> {
  return runSandbox({
    code,
    limits: { ...DEFAULT_LIMITS, timeoutMs: 10_000, ...options.limits },
    hostCall: options.hostCall ?? noCalls,
  });
}

function result(outcome: SandboxOutcome): unknown {
  if (!outcome.ok) throw new Error(`expected ok, got ${JSON.stringify(outcome.error)}`);
  return JSON.parse(outcome.result);
}

function failure(outcome: SandboxOutcome) {
  if (outcome.ok) throw new Error(`expected a failure, got ${outcome.result}`);
  return outcome.error;
}

describe('sandbox core: running code', () => {
  it('returns the value of the async function body', async () => {
    expect(result(await run('return 1 + 1'))).toBe(2);
    expect(result(await run('return { a: [1, 2, { b: "x" }], c: null }'))).toEqual({ a: [1, 2, { b: 'x' }], c: null });
  });

  it('returns null when the script returns nothing or something that has no JSON form', async () => {
    expect(result(await run('const x = 1;'))).toBeNull();
    expect(result(await run('return undefined'))).toBeNull();
    expect(result(await run('return () => 1'))).toBeNull();
  });

  it('allows a top-level await', async () => {
    expect(result(await run('const v = await Promise.resolve(41); return v + 1'))).toBe(42);
  });

  it('strips TypeScript annotations, interfaces, generics, assertions and enums', async () => {
    const outcome = await run(`
      interface Point { x: number; y: number }
      type Id = string | number;
      enum Color { Red = 1, Green }
      function norm<T extends Point>(p: T): number { return Math.hypot(p.x, p.y); }
      const id: Id = 'a';
      const p = { x: 3, y: 4 } as Point;
      return { n: norm(p), c: Color.Green, id, raw: (<unknown>p) as Point };
    `);
    expect(result(outcome)).toEqual({ n: 5, c: 2, id: 'a', raw: { x: 3, y: 4 } });
  });

  it('keeps the wrapper intact when the script uses return and await together with types', async () => {
    const outcome = await run('const f = async (n: number): Promise<number> => n * 2; return await f(21);');
    expect(result(outcome)).toBe(42);
  });
});

describe('sandbox core: the sandbox has no ambient authority', () => {
  it('has none of the Node or browser globals', async () => {
    const outcome = await run(`
      return [typeof process, typeof require, typeof fetch, typeof setTimeout, typeof setInterval,
        typeof queueMicrotask, typeof XMLHttpRequest, typeof WebAssembly, typeof Buffer, typeof module,
        typeof globalThis.process, typeof std, typeof os];
    `);
    expect(result(outcome)).toEqual(Array(13).fill('undefined'));
  });

  it('exposes only its own Function constructor, which reaches no host object', async () => {
    const outcome = await run(`
      const Fn = (function () {}).constructor;
      return [
        typeof globalThis.constructor,
        Fn('return typeof process')(),
        Fn('return typeof require')(),
        Fn('return typeof this.fetch')(),
        typeof eval('typeof process'),
      ];
    `);
    expect(result(outcome)).toEqual(['function', 'undefined', 'undefined', 'undefined', 'string']);
  });

  it('does not leak the host functions onto the global object', async () => {
    const outcome = await run(`
      return Object.getOwnPropertyNames(globalThis).filter((name) => /host|call|log$/i.test(name) && name !== 'console');
    `);
    expect(result(outcome)).toEqual([]);
  });

  it('cannot see the environment of the process that runs it', async () => {
    const previous = process.env.MCPKIT_TEST_SECRET;
    process.env.MCPKIT_TEST_SECRET = 'hunter2';
    try {
      const outcome = await run(`
        let seen = 'none';
        try { seen = process.env.MCPKIT_TEST_SECRET; } catch (e) { seen = 'blocked: ' + e.name; }
        return seen;
      `);
      expect(result(outcome)).toBe('blocked: ReferenceError');
    } finally {
      if (previous === undefined) delete process.env.MCPKIT_TEST_SECRET;
      else process.env.MCPKIT_TEST_SECRET = previous;
    }
  });
});

describe('sandbox core: console', () => {
  it('captures log, info, debug, warn and error in order, formatting values', async () => {
    const lines: string[] = [];
    const outcome = await runSandbox({
      code: `
        console.log('a', 1, { b: 2 }, [3]);
        console.info('info');
        console.debug('debug');
        console.warn('careful');
        console.error(new TypeError('bad'));
        console.log(undefined, null, 10n, Symbol('s'), () => 1);
        const loop = {}; loop.self = loop;
        console.log(loop);
        return 'done';
      `,
      limits: DEFAULT_LIMITS,
      hostCall: noCalls,
      onLog: (line) => lines.push(line),
    });
    expect(result(outcome)).toBe('done');
    const logs = outcome.ok ? outcome.logs : [];
    expect(logs).toEqual([
      'a 1 {"b":2} [3]',
      'info',
      'debug',
      '[warn] careful',
      '[error] TypeError: bad',
      'undefined null 10n Symbol(s) [Function]',
      '[object Object]',
    ]);
    expect(lines).toEqual(logs);
  });

  it('keeps the logs of a script that then fails', async () => {
    const outcome = await run("console.log('before'); throw new Error('after');");
    expect(outcome.ok).toBe(false);
    expect(outcome.logs).toEqual(['before']);
  });

  it('truncates the total logs at the output limit and says so', async () => {
    const outcome = await run(
      "for (let i = 0; i < 100; i++) console.log('line-' + i + '-' + 'x'.repeat(40)); return 1",
      { limits: { maxOutputBytes: 300 } },
    );
    expect(result(outcome)).toBe(1);
    const logs = outcome.logs;
    expect(outcome.logsTruncated).toBe(true);
    expect(logs.at(-1)).toMatch(/^\[logs truncated: the limit is 300 bytes; \d+ line\(s\) dropped, \d+ line\(s\) shortened, about \d+ byte\(s\) removed in all\]$/);
    expect(logs.slice(0, -1).join('').length).toBeLessThanOrEqual(300);
  });

  it('cuts one enormous line before it leaves the VM', async () => {
    const outcome = await run("console.log('y'.repeat(5 * 1024 * 1024)); return 1", { limits: { maxOutputBytes: 10_000_000 } });
    expect(outcome.logs[0].length).toBe(65_536);
  });
});

describe('sandbox core: tool calls', () => {
  it('bridges async host calls, with both mcp["server"].tool and mcp.server.tool', async () => {
    const seen: Array<[string, string, string]> = [];
    const hostCall: HostCall = async (server, tool, args) => {
      seen.push([server, tool, args]);
      return JSON.stringify({ server, tool, echoed: JSON.parse(args) });
    };
    const outcome = await run(
      `
      const a = await mcp["my-server"].echo({ message: 'hi' });
      const b = await mcp.fixture.add({ a: 1, b: 2 });
      const c = await mcp.fixture.noargs();
      return [a, b, c];
    `,
      { hostCall },
    );
    expect(seen).toEqual([
      ['my-server', 'echo', '{"message":"hi"}'],
      ['fixture', 'add', '{"a":1,"b":2}'],
      ['fixture', 'noargs', '{}'],
    ]);
    expect(result(outcome)).toEqual([
      { server: 'my-server', tool: 'echo', echoed: { message: 'hi' } },
      { server: 'fixture', tool: 'add', echoed: { a: 1, b: 2 } },
      { server: 'fixture', tool: 'noargs', echoed: {} },
    ]);
  });

  it('runs Promise.all calls concurrently', async () => {
    let inFlight = 0;
    let peak = 0;
    const hostCall: HostCall = async (_server, _tool, args) => {
      inFlight++;
      peak = Math.max(peak, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 30));
      inFlight--;
      return args;
    };
    const outcome = await run(
      'return await Promise.all([1, 2, 3, 4, 5].map((n) => mcp.fixture.echo({ n })))',
      { hostCall },
    );
    expect(result(outcome)).toEqual([1, 2, 3, 4, 5].map((n) => ({ n })));
    expect(peak).toBe(5);
  });

  it('turns a failed call into a catchable Error carrying kind and tool', async () => {
    const hostCall: HostCall = async () => {
      throw new HostCallError('tool', 'fixture.fail failed: boom', 'fixture.fail');
    };
    const outcome = await run(
      `
      try { await mcp.fixture.fail({}); } catch (e) { return [e instanceof Error, e.message, e.kind, e.tool]; }
    `,
      { hostCall },
    );
    expect(result(outcome)).toEqual([true, 'fixture.fail failed: boom', 'tool', 'fixture.fail']);
  });

  it('reports an uncaught call failure with its kind and tool', async () => {
    const hostCall: HostCall = async () => {
      throw new HostCallError('blocked', 'mcpkit: blocked fixture.write_note (not allowed).', 'fixture.write_note');
    };
    const error = failure(await run('await mcp.fixture.write_note({ text: "x" })', { hostCall }));
    expect(error).toEqual({
      kind: 'blocked',
      message: 'mcpkit: blocked fixture.write_note (not allowed).',
      tool: 'fixture.write_note',
    });
  });

  it('reports a call that ran past the deadline of the run as a timeout', async () => {
    const hostCall: HostCall = async () => {
      throw new HostCallError('timeout', 'mcpkit: fixture.slow did not answer within the time limit of the run', 'fixture.slow');
    };
    const error = failure(await run('await mcp.fixture.slow({ ms: 1e9 })', { hostCall }));
    expect(error).toEqual({
      kind: 'timeout',
      message: 'mcpkit: fixture.slow did not answer within the time limit of the run',
      tool: 'fixture.slow',
    });
  });

  it('treats an unexpected host failure as a tool-less internal error the script can still catch', async () => {
    const hostCall: HostCall = async () => {
      throw new Error('socket closed');
    };
    const outcome = await run("try { await mcp.a.b({}); } catch (e) { return [e.kind, e.message]; }", { hostCall });
    expect(result(outcome)).toEqual(['internal', 'socket closed']);
  });

  it('rejects arguments that are not an object without calling the host', async () => {
    const outcome = await run(
      `
      const out = [];
      for (const bad of ['text', 5, null, [1]]) {
        try { await mcp.a.b(bad); out.push('called'); } catch (e) { out.push(e.name); }
      }
      return out;
    `,
    );
    expect(result(outcome)).toEqual(['TypeError', 'TypeError', 'TypeError', 'TypeError']);
  });

  it('does not hang when a proxy is awaited or serialised', async () => {
    const outcome = await run(`
      const server = await mcp.fixture;
      const root = await mcp;
      return [typeof server, typeof root, JSON.stringify(mcp.fixture), typeof mcp.fixture.then, typeof mcp.then];
    `);
    expect(result(outcome)).toEqual(['object', 'object', '{}', 'undefined', 'undefined']);
  });

  it('stops the run, even if the script catches the error, once max-calls is exceeded', async () => {
    let calls = 0;
    const hostCall: HostCall = async () => {
      calls++;
      return '1';
    };
    const outcome = await run(
      `
      let n = 0;
      try { for (;;) { await mcp.a.b({}); n++; } } catch (e) { console.log('caught', e.kind); }
      return n;
    `,
      { hostCall, limits: { maxCalls: 3 } },
    );
    expect(failure(outcome)).toMatchObject({ kind: 'limit' });
    expect(failure(outcome).message).toContain('--max-calls');
    expect(calls).toBe(3);
  });

  it('stops a script that floods calls without awaiting them', async () => {
    const hostCall: HostCall = () => new Promise(() => undefined);
    const outcome = await run('for (;;) { mcp.a.b({}); }', { hostCall, limits: { maxCalls: 50 } });
    expect(failure(outcome).kind).toBe('limit');
  });
});

describe('sandbox core: errors', () => {
  it('reports a thrown Error with the line of the script', async () => {
    const error = failure(await run('const a = 1;\nfunction f() { throw new RangeError("nope"); }\nf();'));
    expect(error.kind).toBe('script');
    expect(error.message).toMatch(/^RangeError: nope \(script line 2, column \d+\)$/);
  });

  it('reports thrown non-Error values', async () => {
    // The value is the message: it is not dressed up as an Error ("Error: plain text").
    expect(failure(await run("throw 'plain text'"))).toEqual({ kind: 'script', message: 'plain text' });
    expect(failure(await run('throw { code: 7 }')).message).toBe('{"code":7}');
    expect(failure(await run('throw null')).message).toBe('null');
    expect(failure(await run('throw 42')).message).toBe('42');
    expect(failure(await run("throw new Error('real')")).message).toMatch(/^Error: real /);
  });

  it('reports a syntax error with its line, shifted back by the wrapper', async () => {
    const error = failure(await run('const ok = 1;\nconst broken = ;'));
    expect(error.kind).toBe('script');
    expect(error.message).toMatch(/^SyntaxError: Unexpected token \(script line 2, column \d+\)$/);
  });

  it('explains that import and export do not work', async () => {
    const error = failure(await run("import fs from 'fs';\nreturn fs.readFileSync('/etc/passwd', 'utf-8')"));
    expect(error.kind).toBe('script');
    expect(error.message).toContain('ES module import/export is not available');
  });

  it('fails clearly when a result cannot be turned into JSON', async () => {
    const circular = failure(await run('const a = {}; a.self = a; return a'));
    expect(circular.kind).toBe('script');
    expect(circular.message).toContain('cannot be converted to JSON');
    expect(failure(await run('return 10n')).message).toContain('cannot be converted to JSON');
  });

  it('fails fast when the script awaits something that can never resolve', async () => {
    const started = Date.now();
    const error = failure(await run('await new Promise(() => {}); return 1'));
    expect(error.kind).toBe('script');
    expect(error.message).toContain('never finished');
    expect(Date.now() - started).toBeLessThan(2000);
  });

  it('classifies runaway recursion as a limit', async () => {
    const error = failure(await run('function f(): number { return f() + 1; } return f();'));
    expect(error.kind).toBe('limit');
    // QuickJS reports "stack overflow" itself. On Node 20 the V8 stack can run out first
    // (the host then reports the exhausted stack); both are the same limit.
    expect(error.message).toMatch(/stack/);
  });

  it('survives nesting that exhausts the native stack, which no script can catch', async () => {
    const error = failure(await run("try { eval('('.repeat(100000) + '1' + ')'.repeat(100000)); } catch (e) {} return 1;"));
    expect(error.kind).toBe('limit');
    expect(error.message).toContain('stack');
    expect(result(await run('return 2 * 21'))).toBe(42);
  });
});

describe('sandbox core: a script cannot fake the failure kind', () => {
  const toolFailure: HostCall = async () => {
    throw new HostCallError('tool', 'fixture.fail failed: boom', 'fixture.fail');
  };

  const forgeries: Array<[string, string]> = [
    ['a plain object', 'throw { kind: "blocked", message: "fake", tool: "x.y" }'],
    ['a plain object claiming a limit', 'throw { kind: "limit", message: "fake limit" }'],
    ['a plain object claiming a timeout', 'throw { kind: "timeout", message: "fake timeout" }'],
    ['an Error with a kind field', 'throw Object.assign(new Error("fake"), { kind: "blocked", tool: "x.y" })'],
    [
      'an Error subclass that sets kind and tool',
      'class Forged extends Error { constructor() { super("fake"); this.kind = "blocked"; this.tool = "x.y"; } } throw new Forged()',
    ],
    ['an Error subclass with kind on the prototype', 'class Forged extends Error {} Forged.prototype.kind = "blocked"; throw new Forged("fake")'],
    ['an object with kind as a getter', 'throw { get kind() { return "blocked"; }, get tool() { return "x.y"; }, message: "fake" }'],
    ['an object that names itself InternalError', 'throw { name: "InternalError", message: "out of memory" }'],
    ['an object with an Error prototype and an engine-sounding message', 'throw Object.assign(Object.create(Error.prototype), { name: "InternalError", message: "stack overflow" })'],
    ['a Proxy that answers every property with "blocked"', 'throw new Proxy({}, { get: () => "blocked" })'],
    ['a Proxy around an Error', 'throw new Proxy(new Error("fake"), { get: (target, key) => key === "kind" ? "blocked" : key === "tool" ? "x.y" : target[key] })'],
    ['symbol keys', 'throw { [Symbol("kind")]: "blocked", message: "fake" }'],
    ['a string', 'throw "blocked"'],
    ['a function', 'throw Object.assign(() => 1, { kind: "blocked" })'],
  ];

  it.each(forgeries)('reports %s as a script error', async (_label, code) => {
    const error = failure(await run(code));
    expect(error.kind).toBe('script');
    expect(error.tool).toBeUndefined();
  });

  it('cannot build an engine InternalError: the constructor is not on the global object', async () => {
    const error = failure(await run('throw new InternalError("out of memory")'));
    expect(error.kind).toBe('script');
    expect(error.message).toContain('ReferenceError');
  });

  it('keeps the kind, tool and message of a real host error when the script rewrites or wraps it', async () => {
    const mutate = `
      try { await mcp.fixture.fail({}); } catch (e) {
        e.kind = 'blocked'; e.tool = 'x.y'; e.message = 'rewritten';
        Object.defineProperty(e, 'kind', { get: () => 'limit' });
        throw e;
      }
    `;
    expect(failure(await run(mutate, { hostCall: toolFailure }))).toEqual({
      kind: 'tool',
      message: 'fixture.fail failed: boom',
      tool: 'fixture.fail',
    });

    const proxied = `
      try { await mcp.fixture.fail({}); } catch (e) {
        throw new Proxy(e, { get: (target, key) => key === 'kind' ? 'blocked' : target[key] });
      }
    `;
    expect(failure(await run(proxied, { hostCall: toolFailure })).kind).toBe('script');
  });

  it('is not fooled by a script that patches the built-ins the host relies on', async () => {
    const poisoned = `
      WeakMap.prototype.get = () => ({ kind: 'blocked', tool: 'x.y', message: 'fake' });
      WeakMap.prototype.has = () => true;
      Function.prototype.call = () => ({ kind: 'blocked', tool: 'x.y', message: 'fake' });
      Function.prototype.bind = () => () => ({ kind: 'blocked' });
      Object.getPrototypeOf = () => null;
      JSON.parse = () => ({ kind: 'blocked', message: 'fake', tool: 'x.y' });
      JSON.stringify = () => '{"kind":"blocked"}';
      globalThis.Error = function () { return { kind: 'blocked', message: 'fake' }; };
      throw { kind: 'blocked', message: 'fake', tool: 'x.y' };
    `;
    expect(failure(await run(poisoned)).kind).toBe('script');
  });

  it('still trusts a real host error after the script patched Error and WeakMap', async () => {
    const outcome = await run(
      `
      WeakMap.prototype.get = () => undefined;
      globalThis.Error = function () { return {}; };
      await mcp.fixture.fail({});
    `,
      { hostCall: toolFailure },
    );
    expect(failure(outcome)).toEqual({ kind: 'tool', message: 'fixture.fail failed: boom', tool: 'fixture.fail' });
  });

  it('still reports the engine\'s own errors as limits', async () => {
    expect(failure(await run('function f(): number { return f() + 1; } return f();')).kind).toBe('limit');
    expect(failure(await run("const big = 'x'.repeat(300 * 1024 * 1024); return big.length", { limits: { memoryMb: 64 } })).kind).toBe('limit');
  });
});

describe('sandbox core: the process that started the sandbox goes away', () => {
  it('ends a script that spins without yielding, from the interrupt handler', async () => {
    let checks = 0;
    const started = Date.now();
    const outcome = await runSandbox({
      code: 'while (true) {}',
      limits: { ...DEFAULT_LIMITS, timeoutMs: 60_000 },
      hostCall: noCalls,
      parentGone: () => ++checks > 3,
    });
    expect(failure(outcome)).toEqual({ kind: 'internal', message: 'the process that started the sandbox is gone' });
    expect(checks).toBeGreaterThan(3);
    expect(Date.now() - started).toBeLessThan(5000);
  });

  it('does nothing while the parent is there', async () => {
    const outcome = await runSandbox({
      code: 'let n = 0; for (let i = 0; i < 2_000_000; i++) n += i; return n > 0',
      limits: { ...DEFAULT_LIMITS, timeoutMs: 10_000 },
      hostCall: noCalls,
      parentGone: () => false,
    });
    expect(result(outcome)).toBe(true);
  });
});

describe('sandbox core: limits', () => {
  it('interrupts an endless loop at the timeout', async () => {
    const started = Date.now();
    const outcome = await run('while (true) {}', { limits: { timeoutMs: 300 } });
    const elapsed = Date.now() - started;
    expect(failure(outcome).kind).toBe('timeout');
    expect(elapsed).toBeGreaterThanOrEqual(250);
    expect(elapsed).toBeLessThan(3000);
  });

  it('interrupts a loop that only runs in promise jobs', async () => {
    const outcome = await run('for (;;) { await null; }', { limits: { timeoutMs: 300 } });
    expect(failure(outcome).kind).toBe('timeout');
  });

  it('times out while waiting for a call that never answers', async () => {
    const started = Date.now();
    const hostCall: HostCall = () => new Promise(() => undefined);
    const outcome = await run('await mcp.fixture.slow({ ms: 1e9 })', { hostCall, limits: { timeoutMs: 300 } });
    expect(failure(outcome).kind).toBe('timeout');
    expect(Date.now() - started).toBeLessThan(3000);
  });

  it('cannot catch a timeout', async () => {
    const outcome = await run('try { while (true) {} } catch (e) { return "caught"; } return "after"', { limits: { timeoutMs: 300 } });
    expect(failure(outcome).kind).toBe('timeout');
  });

  it('stops a runaway allocation at the memory limit', async () => {
    const outcome = await run("const big = 'x'.repeat(300 * 1024 * 1024); return big.length", { limits: { memoryMb: 64 } });
    expect(failure(outcome).kind).toBe('limit');
    expect(failure(outcome).message).toContain('out of memory');
  });

  it('stops object growth at the memory limit', async () => {
    const outcome = await run('const keep = []; for (;;) keep.push({ a: 1, b: [1, 2, 3] });', { limits: { memoryMb: 32, timeoutMs: 20_000 } });
    expect(failure(outcome).kind).toBe('limit');
  });

  it('gives a script that finished a fresh window to serialise, and kills a hostile toJSON', async () => {
    const started = Date.now();
    const outcome = await run('return { toJSON() { while (true) {} } }', { limits: { timeoutMs: 60_000 } });
    expect(failure(outcome).kind).toBe('timeout');
    expect(Date.now() - started).toBeLessThan(6000);
  });

  it('truncates a result at the output limit and reports its full size', async () => {
    const outcome = await run("return 'a'.repeat(5000)", { limits: { maxOutputBytes: 1000 } });
    if (!outcome.ok) throw new Error('expected ok');
    expect(outcome.resultTruncated).toBe(true);
    expect(outcome.resultBytes).toBe(5002);
    expect(Buffer.byteLength(outcome.result)).toBe(1000);
    expect(outcome.result.startsWith('"aaa')).toBe(true);
  });

  it('keeps a multi-byte character whole when truncating', async () => {
    const outcome = await run("return 'é'.repeat(600)", { limits: { maxOutputBytes: 501 } });
    if (!outcome.ok) throw new Error('expected ok');
    expect(outcome.resultTruncated).toBe(true);
    expect(outcome.result).not.toContain('�');
    expect(Buffer.byteLength(outcome.result)).toBeLessThanOrEqual(501);
  });

  it('does not truncate a result that fits exactly', async () => {
    const outcome = await run("return 'abc'", { limits: { maxOutputBytes: 5 } });
    if (!outcome.ok) throw new Error('expected ok');
    expect(outcome.resultTruncated).toBe(false);
    expect(outcome.result).toBe('"abc"');
  });
});

describe('sandbox core: the memory limit holds for every kind of allocation', () => {
  const growers: Array<[string, string]> = [
    ['strings built from a repeat and a counter', 'const a = []; for (let i = 0; i < 512; i++) a.push("x".repeat(1 << 20) + i); return a.length'],
    ['numbers pushed into one array', 'const a = []; for (let i = 0; i < 1e8; i++) a.push(i); return a.length'],
    ['small objects with nested arrays', 'const a = []; for (let i = 0; i < 1e7; i++) a.push({ i, j: [i] }); return a.length'],
    ['typed arrays', 'const a = []; for (let i = 0; i < 512; i++) a.push(new Uint8Array(1 << 20)); return a.length'],
    ['one huge ArrayBuffer', 'return new ArrayBuffer(2 ** 30).byteLength'],
    ['one huge array', 'return new Array(1e9).fill(0).length'],
    ['a Map that keeps growing', 'const m = new Map(); for (let i = 0; i < 1e8; i++) m.set(i, "v" + i); return m.size'],
    ['objects nested inside each other', 'let o = {}; for (let i = 0; i < 1e8; i++) o = { o }; return 1'],
  ];

  describe.each([8, 64])('with --memory-mb %i', (memoryMb) => {
    it.each(growers)('stops %s as a limit that names the limit', async (_label, code) => {
      const started = Date.now();
      const error = failure(await run(code, { limits: { memoryMb, timeoutMs: 30_000 } }));
      expect(error.kind).toBe('limit');
      expect(error.message).toContain(`${memoryMb} MiB`);
      expect(error.message).toContain('--memory-mb');
      expect(Date.now() - started).toBeLessThan(15_000);
    });
  });

  it('ends the run as a limit even when the script catches the out-of-memory error and carries on', async () => {
    const outcome = await run(
      'let caught = 0; try { const a = []; for (;;) a.push("x".repeat(1 << 20) + a.length); } catch (e) { caught = 1; } return caught',
      { limits: { memoryMb: 16 } },
    );
    expect(failure(outcome).kind).toBe('limit');
  });

  it('holds the cap close to the requested size instead of far above it', async () => {
    const mebibytes = (n: number) => `const a = []; for (let i = 0; i < ${n}; i++) a.push("x".repeat(1 << 20) + i); return a.length`;
    expect(failure(await run(mebibytes(24), { limits: { memoryMb: 16 } })).kind).toBe('limit');
    expect(result(await run(mebibytes(40), { limits: { memoryMb: 64 } }))).toBe(40);
  });

  it('lets a small script run at the smallest limit the CLI accepts', async () => {
    expect(result(await run('return 1', { limits: { memoryMb: 8 } }))).toBe(1);
    expect(result(await run('const a = []; for (let i = 0; i < 20000; i++) a.push({ i }); return a.length', { limits: { memoryMb: 8 } }))).toBe(20_000);
  });

  it('does not touch the limit of a script that stays small', async () => {
    expect(result(await run('const a = []; for (let i = 0; i < 1e5; i++) a.push({ i }); return a.length', { limits: { memoryMb: 16 } }))).toBe(100_000);
  });
});

describe('sandbox core: the deadline is authoritative', () => {
  it('ends as a timeout when the script catches the timeout error of a slow call and finishes after the limit', async () => {
    const started = Date.now();
    const hostCall: HostCall = () => new Promise((_resolve, reject) => {
      setTimeout(() => reject(new HostCallError('timeout', 'mcpkit: fx.slow did not answer within the time limit of the run', 'fx.slow')), 300);
    });
    const outcome = await run(
      'try { await mcp.fx.slow({ ms: 10000 }); } catch (e) { console.log("caught", e.kind); } return "carried on";',
      { hostCall, limits: { timeoutMs: 300 } },
    );
    expect(failure(outcome)).toEqual({ kind: 'timeout', message: 'the script ran past the time limit of 300 ms' });
    expect(Date.now() - started).toBeLessThan(3000);
  });

  it('counts from a deadline the caller started, not from the moment the VM starts', async () => {
    const started = Date.now();
    const outcome = await runSandbox({
      code: 'await mcp.fx.slow({})',
      limits: { ...DEFAULT_LIMITS, timeoutMs: 60_000 },
      deadline: Date.now() + 250,
      hostCall: () => new Promise(() => undefined),
    });
    expect(failure(outcome).kind).toBe('timeout');
    expect(Date.now() - started).toBeLessThan(3000);
  });

  it('keeps a script that finishes before the limit', async () => {
    expect(result(await run('return "in time"', { limits: { timeoutMs: 5000 } }))).toBe('in time');
  });
});

describe('sandbox core: what the logs lose is counted', () => {
  it('reports a dropped line once, when it first happens, and the totals at the end', async () => {
    let notices = 0;
    const outcome = await runSandbox({
      code: 'for (let i = 0; i < 100; i++) console.log("line-" + i + "-" + "x".repeat(40)); return 1',
      limits: { ...DEFAULT_LIMITS, maxOutputBytes: 300, timeoutMs: 10_000 },
      hostCall: noCalls,
      onLogsCut: () => {
        notices++;
      },
    });
    expect(notices).toBe(1);
    // Every line is either kept (the last one possibly shortened to the budget) or counted as dropped.
    const kept = outcome.logs.length - 1;
    expect(kept + outcome.logAccount.droppedLines).toBe(100);
    expect(outcome.logs.at(-1)).toMatch(/^\[logs truncated: the limit is 300 bytes; /);
  });

  it('counts a very long line cut before it left the VM', async () => {
    let notices = 0;
    const outcome = await runSandbox({
      code: "console.log('y'.repeat(5 * 1024 * 1024)); return 1",
      limits: { ...DEFAULT_LIMITS, maxOutputBytes: 10_000_000, timeoutMs: 10_000 },
      hostCall: noCalls,
      onLogsCut: () => {
        notices++;
      },
    });
    expect(notices).toBe(1);
    expect(outcome.logsTruncated).toBe(true);
    expect(outcome.logAccount).toEqual({ droppedLines: 0, shortenedLines: 1, removedBytes: 5 * 1024 * 1024 - 65_536 });
    expect(outcome.logs.at(-1)).toContain('1 line(s) shortened');
  });

  it('reports nothing when every line fits', async () => {
    let notices = 0;
    const outcome = await runSandbox({
      code: "console.log('a'); console.log('b'); return 1",
      limits: { ...DEFAULT_LIMITS, timeoutMs: 10_000 },
      hostCall: noCalls,
      onLogsCut: () => {
        notices++;
      },
    });
    expect(notices).toBe(0);
    expect(outcome.logsTruncated).toBe(false);
    expect(outcome.logAccount).toEqual({ droppedLines: 0, shortenedLines: 0, removedBytes: 0 });
  });
});

describe('sandbox core: arguments and names the parent would refuse', () => {
  it('rejects arguments over the limit with a catchable error of kind limit, and does not count the call', async () => {
    let hostCalls = 0;
    const hostCall: HostCall = async () => {
      hostCalls++;
      return '1';
    };
    const outcome = await run(
      'try { await mcp.fx.echo({ message: "x".repeat(2 * 1024 * 1024) }); } catch (e) { return { kind: e.kind, tool: e.tool, message: e.message }; }',
      { hostCall },
    );
    expect(result(outcome)).toEqual({
      kind: 'limit',
      tool: 'fx.echo',
      message: 'mcpkit: the arguments of fx.echo are larger than 1048576 bytes; send less',
    });
    expect(hostCalls).toBe(0);
  });

  it('measures the arguments in bytes, not characters', async () => {
    const outcome = await run('return await mcp.fx.echo({ message: "é".repeat(600 * 1024) })');
    expect(failure(outcome).kind).toBe('limit');
  });

  it('ends the run as a limit when the script does not catch it', async () => {
    const outcome = await run('await mcp.fx.echo({ message: "x".repeat(2 * 1024 * 1024) })');
    expect(failure(outcome)).toMatchObject({ kind: 'limit', tool: 'fx.echo' });
  });

  it('rejects an empty or very long server or tool name as a tool error instead of a protocol violation', async () => {
    const outcome = await run(
      `const out = [];
       for (const [server, tool] of [['', 'x'], ['fx', ''], ['s'.repeat(2000), 'x'], ['fx', 't'.repeat(2000)]]) {
         try { await mcp[server][tool]({}); out.push('ran'); } catch (e) { out.push(e.kind); }
       }
       return out;`,
    );
    expect(result(outcome)).toEqual(['tool', 'tool', 'tool', 'tool']);
  });
});

describe('sandbox core: failures nothing handled (like an unhandled rejection in Node)', () => {
  const failing: HostCall = async (_server, tool) => {
    throw new HostCallError(tool === 'write_note' ? 'blocked' : 'tool', `${tool} did not work`, `fx.${tool}`);
  };
  const succeeding: HostCall = async () => '{"ok":1}';

  it.each([
    ['an unawaited call that fails', 'mcp.fx.fail({}); return "done"', 'tool'],
    ['an unawaited call the gate blocked', 'mcp.fx.write_note({}); return "done"', 'blocked'],
    ['a chain on a failing call that has no catch', 'mcp.fx.fail({}).then(() => 1); return "done"', 'tool'],
    ['a call with a finally and no catch', 'mcp.fx.fail({}).finally(() => 1); return "done"', 'tool'],
    ['an invalid argument that nobody awaited', 'mcp.fx.echo(5); return "done"', 'script'],
  ])('ends the run for %s', async (_label, code, kind) => {
    const outcome = await run(code, { hostCall: failing });
    expect(failure(outcome).kind).toBe(kind);
  });

  it('names the call, and says why the run failed', async () => {
    const error = failure(await run('mcp.fx.write_note({}); return "done"', { hostCall: failing }));
    expect(error).toEqual({
      kind: 'blocked',
      message: 'write_note did not work [the call was not awaited and its failure was not caught, so it ended the run]',
      tool: 'fx.write_note',
    });
  });

  it.each([
    ['an await in try/catch', 'try { await mcp.fx.fail({}); } catch (e) {} return "done"'],
    ['.catch', 'mcp.fx.fail({}).catch(() => {}); return "done"'],
    ['.then with a second argument', 'mcp.fx.fail({}).then(() => 1, () => 2); return "done"'],
    ['.then(f).catch(g)', 'mcp.fx.fail({}).then(() => 1).catch(() => 2); return "done"'],
    ['.finally and .catch', 'mcp.fx.fail({}).finally(() => 1).catch(() => 2); return "done"'],
    ['Promise.all', 'try { await Promise.all([mcp.fx.fail({}), mcp.fx.fail({})]); } catch (e) {} return "done"'],
    ['Promise.allSettled', 'await Promise.allSettled([mcp.fx.fail({}), mcp.fx.fail({})]); return "done"'],
    ['Promise.race', 'try { await Promise.race([mcp.fx.fail({})]); } catch (e) {} return "done"'],
    ['an async function that awaits it, caught outside', 'const f = async () => { await mcp.fx.fail({}); }; try { await f(); } catch (e) {} return "done"'],
    ['a promise kept and awaited later', 'const p = mcp.fx.fail({}); await mcp.fx.echo({}).catch(() => 0); try { await p; } catch (e) {} return "done"'],
    ['Promise.all inside .catch', 'await Promise.all([mcp.fx.fail({})]).catch(() => 0); return "done"'],
  ])('lets %s through', async (_label, code) => {
    const outcome = await run(code, { hostCall: failing });
    expect(result(outcome)).toBe('done');
  });

  it('does not mind an unawaited call that succeeds', async () => {
    const outcome = await run('mcp.fx.echo({}); mcp.fx.echo({}).then(() => 1); return "done"', { hostCall: succeeding });
    expect(result(outcome)).toBe('done');
    if (outcome.ok) expect(outcome.warnings).toEqual([]);
  });

  it('judges a call that is still running when the script returns by how it ends', async () => {
    const later = (ok: boolean): HostCall => () => new Promise((resolve, reject) => {
      setTimeout(() => (ok ? resolve('1') : reject(new HostCallError('tool', 'late failure', 'fx.slow'))), 60);
    });
    expect(failure(await run('mcp.fx.slow({}); return "done"', { hostCall: later(false) }))).toMatchObject({ kind: 'tool', tool: 'fx.slow' });
    expect(result(await run('mcp.fx.slow({}); return "done"', { hostCall: later(true) }))).toBe('done');
    expect(result(await run('mcp.fx.slow({}).catch(() => 0); return "done"', { hostCall: later(false) }))).toBe('done');
  });

  it('reports the first rejection when several went unhandled', async () => {
    const outcome = await run('mcp.fx.fail({}); mcp.fx.write_note({}); return "done"', { hostCall: failing });
    expect(failure(outcome)).toMatchObject({ kind: 'tool', tool: 'fx.fail' });
  });

  it('lets a script error take precedence over an unawaited failure', async () => {
    const outcome = await run('mcp.fx.fail({}); throw new Error("mine")', { hostCall: failing });
    expect(failure(outcome).kind).toBe('script');
    expect(failure(outcome).message).toContain('mine');
  });

  it('times out when a call the script did not await never answers', async () => {
    const outcome = await run('mcp.fx.slow({}); return "done"', { hostCall: () => new Promise(() => undefined), limits: { timeoutMs: 250 } });
    expect(failure(outcome)).toEqual({
      kind: 'timeout',
      message: 'the script finished, but 1 call(s) it did not await were still running at the time limit of 250 ms',
    });
  });
});

describe('sandbox core: calls started after the script returned', () => {
  const slowThenFast: HostCall = async (_server, tool) => {
    if (tool === 'first') await new Promise((resolve) => setTimeout(resolve, 40));
    return '{"from":"' + tool + '"}';
  };

  it('does not run them, and says so in the warnings', async () => {
    const hostCalls: string[] = [];
    const hostCall: HostCall = async (server, tool, args) => {
      hostCalls.push(`${server}.${tool}`);
      return slowThenFast(server, tool, args);
    };
    const outcome = await run('mcp.fx.first({}).then(() => mcp.fx.second({})); return "done"', { hostCall });
    expect(result(outcome)).toBe('done');
    expect(hostCalls).toEqual(['fx.first']);
    if (!outcome.ok) throw new Error('expected ok');
    expect(outcome.warnings).toEqual(['mcp.fx.second() was called after the script returned, so it was not run']);
  });

  it('lists each such call once', async () => {
    const outcome = await run(
      'mcp.fx.first({}).then(() => { mcp.fx.second({}).catch(() => 0); mcp.fx.second({}).catch(() => 0); mcp.fx.third({}).catch(() => 0); }); return 1',
      { hostCall: slowThenFast },
    );
    if (!outcome.ok) throw new Error('expected ok');
    expect(outcome.warnings).toEqual([
      'mcp.fx.second() was called after the script returned, so it was not run',
      'mcp.fx.third() was called after the script returned, so it was not run',
    ]);
  });

  it('does not count a refused call as a failure of the script, even without a catch', async () => {
    const outcome = await run('mcp.fx.first({}).then(() => mcp.fx.second({})); return 1', { hostCall: slowThenFast });
    expect(result(outcome)).toBe(1);
  });

  it('returns the value the script returned, whatever the code that ran afterwards does to it', async () => {
    const outcome = await run('const o = { a: 1 }; mcp.fx.first({}).then(() => { o.a = 2; }); return o', { hostCall: slowThenFast });
    expect(result(outcome)).toEqual({ a: 1 });
  });

  it('has no warnings when nothing ran late', async () => {
    const outcome = await run('return await mcp.fx.first({})', { hostCall: slowThenFast });
    expect(result(outcome)).toEqual({ from: 'first' });
    if (outcome.ok) expect(outcome.warnings).toEqual([]);
  });

  it('ends a continuation that spins at the run deadline', async () => {
    const outcome = await run('mcp.fx.first({}).then(() => { while (true) {} }); return 1', { hostCall: slowThenFast, limits: { timeoutMs: 400 } });
    expect(failure(outcome).kind).toBe('timeout');
  });
});

describe('sandbox core: isolation between runs', () => {
  it('does not share globals between runs', async () => {
    await run('globalThis.leak = 41; return 1');
    expect(result(await run('return typeof globalThis.leak'))).toBe('undefined');
  });

  it('keeps working after runs that were interrupted or ran out of memory', async () => {
    await run('while (true) {}', { limits: { timeoutMs: 100 } });
    await run("'x'.repeat(300 * 1024 * 1024)", { limits: { memoryMb: 32 } });
    await run('await mcp.a.b({})', { hostCall: () => new Promise(() => undefined), limits: { timeoutMs: 100 } });
    expect(result(await run('return 2 * 21'))).toBe(42);
  });
});
