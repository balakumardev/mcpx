import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Command } from 'commander';
import type { MockInstance } from 'vitest';
import type { ToolCallOutput } from '../client.js';
import type { ServerEntry } from '../types.js';
import { describeOmittedParts } from '../tool-result.js';

function entry(overrides: Partial<ServerEntry> = {}): ServerEntry {
  return {
    name: 'srv',
    transport: { type: 'stdio', command: 'node', args: ['server.js'] },
    toolCount: 1,
    agents: ['claude-code'],
    createdAt: '2026-04-14T00:00:00.000Z',
    updatedAt: '2026-04-14T00:00:00.000Z',
    ...overrides,
  };
}

function success(text: string, value: unknown = text): ToolCallOutput {
  return { text, value, isError: false };
}

function failure(text: string): ToolCallOutput {
  return { text, value: text, isError: true };
}

describe('call results and exit status', () => {
  const mocks = {
    callTool: vi.fn(),
    callToolsChained: vi.fn(),
    connectToolSession: vi.fn(),
    callPersistentRuntime: vi.fn(),
    isPersistentRuntimeEntry: vi.fn(() => false),
    maybeAutoRefresh: vi.fn(),
    authenticateIfNeeded: vi.fn(),
  };
  let stdout: MockInstance<typeof process.stdout.write>;
  let stderr: MockInstance<typeof console.error>;
  let exit: MockInstance<typeof process.exit>;

  async function runCall(args: string[], server: ServerEntry = entry()): Promise<void> {
    vi.doMock('../config.js', () => ({ getServer: vi.fn().mockResolvedValue(server) }));
    vi.doMock('../client.js', () => ({
      callTool: mocks.callTool,
      callToolsChained: mocks.callToolsChained,
      connectToolSession: mocks.connectToolSession,
    }));
    vi.doMock('../auth.js', () => ({ authenticateIfNeeded: mocks.authenticateIfNeeded }));
    vi.doMock('../runtime-config.js', () => ({ isPersistentRuntimeEntry: mocks.isPersistentRuntimeEntry }));
    vi.doMock('../runtime-manager.js', () => ({ callPersistentRuntime: mocks.callPersistentRuntime }));
    vi.doMock('../auto-refresh.js', () => ({ maybeAutoRefresh: mocks.maybeAutoRefresh }));

    const { createCallCommand } = await import('./call.js');
    await createCallCommand().parseAsync(args, { from: 'user' });
  }

  function stdoutText(): string {
    return stdout.mock.calls.map(([chunk]) => String(chunk)).join('');
  }

  function stderrText(): string {
    return stderr.mock.calls.map(([line]) => String(line)).join('\n');
  }

  beforeEach(() => {
    vi.resetModules();
    stdout = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    stderr = vi.spyOn(console, 'error').mockImplementation(() => {});
    exit = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    for (const mock of Object.values(mocks)) mock.mockReset();
    mocks.isPersistentRuntimeEntry.mockReturnValue(false);
  });

  describe('successful calls', () => {
    it('prints the text exactly as before, without a trailing newline, and exits 0', async () => {
      mocks.callTool.mockResolvedValue(success('{"a":1}', { a: 1 }));

      await runCall(['srv', 'tool', '{"x":1}']);

      expect(mocks.callTool).toHaveBeenCalledWith(expect.any(Object), 'tool', { x: 1 }, undefined, undefined, undefined);
      expect(stdoutText()).toBe('{"a":1}');
      expect(exit).not.toHaveBeenCalled();
    });

    it('prints one line per call for a chain', async () => {
      mocks.callToolsChained.mockResolvedValue([success('one'), success(''), success('three')]);

      await runCall(['srv', 'a', '{}', '--chain', 'b', 'c']);

      expect(stdoutText()).toBe('one\nthree\n');
      expect(exit).not.toHaveBeenCalled();
    });

    it('prints the normalised value as one JSON line with --json', async () => {
      mocks.callTool.mockResolvedValue(success('Found 2', { items: [1, 2] }));

      await runCall(['srv', 'tool', '{}', '--json']);

      expect(stdoutText()).toBe('{"items":[1,2]}\n');
      expect(exit).not.toHaveBeenCalled();
    });

    it('prints a JSON string for a plain text result with --json', async () => {
      mocks.callTool.mockResolvedValue(success('hello'));

      await runCall(['srv', 'tool', '{}', '--json']);

      expect(stdoutText()).toBe('"hello"\n');
    });

    it('prints one JSON array for a chain with --json', async () => {
      mocks.callToolsChained.mockResolvedValue([success('{"token":"t"}', { token: 't' }), success('ok')]);

      await runCall(['srv', 'login', '{}', '--chain', 'search', '--json']);

      expect(stdoutText()).toBe('[{"token":"t"},"ok"]\n');
    });

    it('works with --json through a persistent runtime', async () => {
      mocks.isPersistentRuntimeEntry.mockReturnValue(true);
      mocks.callPersistentRuntime.mockResolvedValue([success('[1,2]', [1, 2])]);

      await runCall(['srv', 'tool', '{}', '--json']);

      expect(stdoutText()).toBe('[1,2]\n');
      expect(exit).not.toHaveBeenCalled();
    });
  });

  describe('a tool error (isError)', () => {
    it('goes to stderr with nothing on stdout and exit code 1 for a one-shot call', async () => {
      mocks.callTool.mockResolvedValue(failure('repo not found'));

      await runCall(['srv', 'get_repo', '{}']);

      expect(stdoutText()).toBe('');
      expect(stderrText()).toContain('Tool "get_repo" returned an error: repo not found');
      expect(exit).toHaveBeenCalledTimes(1);
      expect(exit).toHaveBeenCalledWith(1);
    });

    it('is also a failure with --json: nothing on stdout', async () => {
      mocks.callTool.mockResolvedValue(failure('nope'));

      await runCall(['srv', 'tool', '{}', '--json']);

      expect(stdoutText()).toBe('');
      expect(stderrText()).toContain('returned an error: nope');
      expect(exit).toHaveBeenCalledWith(1);
    });

    it('still names the tool when the server sent no message', async () => {
      mocks.callTool.mockResolvedValue(failure(''));

      await runCall(['srv', 'tool', '{}']);

      expect(stderrText()).toContain('Tool "tool" returned an error: (no message)');
      expect(exit).toHaveBeenCalledWith(1);
    });

    it('fails a persistent runtime call', async () => {
      mocks.isPersistentRuntimeEntry.mockReturnValue(true);
      mocks.callPersistentRuntime.mockResolvedValue([failure('runtime says no')]);

      await runCall(['srv', 'tool', '{}']);

      expect(stdoutText()).toBe('');
      expect(stderrText()).toContain('runtime says no');
      expect(exit).toHaveBeenCalledWith(1);
    });

    it('fails a keepalive call without waiting for Ctrl+C, and closes the session', async () => {
      const session = {
        callTool: vi.fn().mockResolvedValue(failure('keepalive failed')),
        callToolsChained: vi.fn(),
        close: vi.fn().mockResolvedValue(undefined),
      };
      mocks.connectToolSession.mockResolvedValue(session);

      await runCall(['srv', 'tool', '{}', '--keepalive']);

      expect(session.close).toHaveBeenCalled();
      expect(stdoutText()).toBe('');
      expect(stderrText()).toContain('keepalive failed');
      expect(stderrText()).not.toContain('Press Ctrl+C');
      expect(exit).toHaveBeenCalledWith(1);
    });

    it('names the failing step of a chain and prints nothing on stdout', async () => {
      mocks.callToolsChained.mockResolvedValue([success('{"token":"t"}'), failure('search failed')]);

      await runCall(['srv', 'login', '{}', '--chain', 'search', 'logout']);

      expect(stdoutText()).toBe('');
      expect(stderrText()).toContain('Tool "search" (step 2 of 3) returned an error: search failed');
      expect(exit).toHaveBeenCalledWith(1);
    });

    it('fails a chain run through a persistent runtime', async () => {
      mocks.isPersistentRuntimeEntry.mockReturnValue(true);
      mocks.callPersistentRuntime.mockResolvedValue([failure('first failed')]);

      await runCall(['srv', 'first', '{}', '--chain', 'second']);

      expect(stdoutText()).toBe('');
      expect(stderrText()).toContain('Tool "first" (step 1 of 2) returned an error: first failed');
      expect(exit).toHaveBeenCalledWith(1);
    });
  });

  describe('params that are not a JSON object', () => {
    /** Everything that talks to a server or to an identity provider: none of it may run for a bad argument. */
    function expectNothingConnected(): void {
      expect(mocks.maybeAutoRefresh).not.toHaveBeenCalled();
      expect(mocks.authenticateIfNeeded).not.toHaveBeenCalled();
      expect(mocks.callTool).not.toHaveBeenCalled();
      expect(mocks.callToolsChained).not.toHaveBeenCalled();
      expect(mocks.connectToolSession).not.toHaveBeenCalled();
      expect(mocks.callPersistentRuntime).not.toHaveBeenCalled();
    }

    it.each([
      ['a number', '5', 'a number'],
      ['an array', '[1]', 'an array'],
      ['null', 'null', 'null'],
      ['a string', '"x"', 'a string'],
      ['a boolean', 'true', 'a boolean'],
    ])('exits 2 with a usage message for %s, before connecting', async (_label, params, described) => {
      await runCall(['srv', 'tool', params]);

      expect(stdoutText()).toBe('');
      expect(stderrText()).toContain(`Params must be a JSON object, but are ${described}`);
      expect(stderrText()).toContain(`mcpkit call <server> <tool> '{"key":"value"}'`);
      expect(exit).toHaveBeenCalledTimes(1);
      expect(exit).toHaveBeenCalledWith(2);
      expectNothingConnected();
    });

    it('exits 2 for text that is not JSON at all, and for an empty argument', async () => {
      await runCall(['srv', 'tool', '{"a":']);
      expect(stderrText()).toContain('Params are not valid JSON');
      expect(exit).toHaveBeenCalledWith(2);
      expectNothingConnected();

      exit.mockClear();
      await runCall(['srv', 'tool', '']);
      expect(exit).toHaveBeenCalledWith(2);
      expectNothingConnected();
    });

    it('does not echo the params back, which may hold a token, whether they parse or not', async () => {
      await runCall(['srv', 'tool', '"sk-secret-token-value"']);
      expect(stderrText()).not.toContain('sk-secret-token-value');
      expect(exit).toHaveBeenCalledWith(2);

      exit.mockClear();
      stderr.mockClear();
      await runCall(['srv', 'tool', 'sk-secret-token-value']);
      expect(stderrText()).toContain('Params are not valid JSON');
      expect(stderrText()).not.toContain('sk-secret');
      expect(exit).toHaveBeenCalledWith(2);

      exit.mockClear();
      stderr.mockClear();
      await runCall(['srv', 'tool', '{"token":"sk-secret-token-value" "x":1}']);
      expect(stderrText()).toMatch(/not valid JSON \(at position \d+\)/);
      expect(stderrText()).not.toContain('sk-secret');
    });

    it('checks the params of every --chain call too, naming the step', async () => {
      await runCall(['srv', 'first', '{}', '--chain', 'second:5']);
      expect(stderrText()).toContain('Params of chain step 2 ("second") must be a JSON object, but are a number');
      expect(stderrText()).toContain(`Usage: --chain 'tool:{"key":"value"}'`);
      expect(exit).toHaveBeenCalledWith(2);
      expectNothingConnected();

      exit.mockClear();
      stderr.mockClear();
      await runCall(['srv', 'first', '{}', '--chain', 'ok', 'bad:{oops']);
      expect(stderrText()).toContain('Params of chain step 3 ("bad") are not valid JSON');
      expect(exit).toHaveBeenCalledWith(2);
      expectNothingConnected();
    });

    it('also stops before a persistent runtime or a keepalive session is started', async () => {
      mocks.isPersistentRuntimeEntry.mockReturnValue(true);
      await runCall(['srv', 'tool', '[1]']);
      expect(exit).toHaveBeenCalledWith(2);
      expectNothingConnected();

      exit.mockClear();
      await runCall(['srv', 'tool', '[1]', '--keepalive']);
      expect(exit).toHaveBeenCalledWith(2);
      expectNothingConnected();
    });

    it('still runs a call whose params are an object, including an empty one and the default', async () => {
      mocks.callTool.mockResolvedValue(success('fine'));

      await runCall(['srv', 'tool', '{"a":[1,2],"b":{"c":null}}']);
      await runCall(['srv', 'tool']);

      expect(mocks.callTool).toHaveBeenNthCalledWith(1, expect.any(Object), 'tool', { a: [1, 2], b: { c: null } }, undefined, undefined, undefined);
      expect(mocks.callTool).toHaveBeenNthCalledWith(2, expect.any(Object), 'tool', {}, undefined, undefined, undefined);
      expect(exit).not.toHaveBeenCalled();
    });
  });

  describe('non-text parts that plain output leaves out', () => {
    const image = (bytes: number, mimeType = 'image/png') => ({ type: 'image', data: Buffer.alloc(bytes, 7).toString('base64'), mimeType });
    const text = (value: string) => ({ type: 'text', text: value });
    /** What `callTool` hands `call` for a result with these parts: the client lists what it left out in `omitted`. */
    const withParts = (output: ToolCallOutput, content: unknown[]): ToolCallOutput => ({ ...output, omitted: describeOmittedParts(content) });

    it('notes an omitted image on stderr, with its size, and leaves stdout as it was', async () => {
      const screenshot = image(61969);
      const content = [text('Took a screenshot of the page'), screenshot];
      mocks.callTool.mockResolvedValue(withParts(success('Took a screenshot of the page', { content }), content));

      await runCall(['srv', 'take_screenshot', '{}']);

      expect(stdoutText()).toBe('Took a screenshot of the page');
      expect(stderrText()).toBe('[omitted: image/png 61969 bytes; use --json or mcpkit exec]');
      expect(stdoutText()).not.toContain(screenshot.data);
      expect(exit).not.toHaveBeenCalled();
    });

    it('notes a resource link and an embedded resource', async () => {
      const content = [
        text('Found it'),
        { type: 'resource_link', uri: 'file:///tmp/report.pdf', name: 'report', mimeType: 'application/pdf' },
        { type: 'resource', resource: { uri: 'mem://blob', mimeType: 'application/octet-stream', blob: Buffer.alloc(10).toString('base64') } },
        { type: 'resource', resource: { uri: 'mem://note', mimeType: 'text/plain', text: 'héllo' } },
      ];
      mocks.callTool.mockResolvedValue(withParts(success('Found it', { content }), content));

      await runCall(['srv', 'find', '{}']);

      expect(stdoutText()).toBe('Found it');
      expect(stderr.mock.calls.map(([line]) => String(line))).toEqual([
        '[omitted: resource_link file:///tmp/report.pdf; use --json or mcpkit exec]',
        '[omitted: 2 x resource, 16 bytes; use --json or mcpkit exec]',
      ]);
    });

    it('writes one line per kind of part, counting repeats and adding up their sizes', async () => {
      const content = [text('two shots'), image(1000), image(500), image(300, 'image/jpeg'), { type: 'audio', data: Buffer.alloc(40).toString('base64'), mimeType: 'audio/wav' }];
      mocks.callTool.mockResolvedValue(withParts(success('two shots', { content }), content));

      await runCall(['srv', 'shoot', '{}']);

      expect(stderr.mock.calls.map(([line]) => String(line))).toEqual([
        '[omitted: 2 x image/png, 1500 bytes; use --json or mcpkit exec]',
        '[omitted: image/jpeg 300 bytes; use --json or mcpkit exec]',
        '[omitted: audio/wav 40 bytes; use --json or mcpkit exec]',
      ]);
    });

    it('names a part of an unknown type by its type', async () => {
      const content = [text('x'), { type: 'hologram' }];
      mocks.callTool.mockResolvedValue(withParts(success('x', { content }), content));
      await runCall(['srv', 'tool', '{}']);
      expect(stderrText()).toBe('[omitted: hologram; use --json or mcpkit exec]');
    });

    it('escapes what the server wrote in the type, mime type and uri', async () => {
      const evil = 'image/png\u001b[2J\r\u0085';
      const content = [text('x'), { type: 'image', data: 'AAAA', mimeType: evil }, { type: 'resource_link', uri: 'a\u001bb' }];
      mocks.callTool.mockResolvedValue(withParts(success('x', { content }), content));
      await runCall(['srv', 'tool', '{}']);
      expect(stderrText()).not.toMatch(/[\u0000-\u0009\u000b-\u001f\u007f-\u009f]/);
      expect(stderrText()).toContain('image/png\\u001b[2J\\r\\u0085 3 bytes');
    });

    it('says nothing when plain output already holds every part, or the result is text only', async () => {
      // A result that reports nothing left out is noted as nothing, whatever its value looks like.
      mocks.callTool.mockResolvedValue(success('[{"type":"image"}]', { content: [image(10)] }));
      await runCall(['srv', 'tool', '{}']);
      expect(stderr).not.toHaveBeenCalled();

      mocks.callTool.mockResolvedValue(success('plain'));
      await runCall(['srv', 'tool', '{}']);
      expect(stderr).not.toHaveBeenCalled();
    });

    it('does not mistake a JSON text result that looks like a content list for omitted parts', async () => {
      const printed = JSON.stringify({ content: [text('x'), image(10)] });
      mocks.callTool.mockResolvedValue(success(printed, JSON.parse(printed)));
      await runCall(['srv', 'tool', '{}']);
      expect(stdoutText()).toBe(printed);
      expect(stderr).not.toHaveBeenCalled();
    });

    it('prints nothing extra with --json, which carries every part', async () => {
      const content = [text('shot'), image(30)];
      mocks.callTool.mockResolvedValue(success('shot', { content }));

      await runCall(['srv', 'take_screenshot', '{}', '--json']);

      expect(JSON.parse(stdoutText())).toEqual({ content });
      expect(stderr).not.toHaveBeenCalled();
    });

    it('notes each step of a chain, through a persistent runtime too', async () => {
      mocks.isPersistentRuntimeEntry.mockReturnValue(true);
      const content = [text('two'), image(12)];
      mocks.callPersistentRuntime.mockResolvedValue([
        success('one'),
        withParts(success('two', { content }), content),
      ]);

      await runCall(['srv', 'a', '{}', '--chain', 'b']);

      expect(stdoutText()).toBe('one\ntwo\n');
      expect(stderrText()).toBe('[omitted (step 2 of 2): image/png 12 bytes; use --json or mcpkit exec]');
    });

    it('does not note anything for a failed call', async () => {
      mocks.callTool.mockResolvedValue({ text: 'broken', value: { content: [text('broken'), image(5)] }, isError: true });
      await runCall(['srv', 'tool', '{}']);
      expect(stderrText()).not.toContain('omitted');
      expect(exit).toHaveBeenCalledWith(1);
    });
  });

  describe('help text', () => {
    function helpText(): string {
      let out = '';
      createCallCommand().configureOutput({ writeOut: (chunk) => { out += chunk; } }).outputHelp();
      return out;
    }

    // call.js is imported lazily so that the mocks above are in place.
    let createCallCommand: typeof import('./call.js').createCallCommand;
    beforeEach(async () => {
      vi.doMock('../config.js', () => ({ getServer: vi.fn() }));
      vi.doMock('../client.js', () => ({ callTool: vi.fn(), callToolsChained: vi.fn(), connectToolSession: vi.fn() }));
      vi.doMock('../auth.js', () => ({ authenticateIfNeeded: vi.fn() }));
      vi.doMock('../runtime-config.js', () => ({ isPersistentRuntimeEntry: vi.fn() }));
      vi.doMock('../runtime-manager.js', () => ({ callPersistentRuntime: vi.fn() }));
      vi.doMock('../auto-refresh.js', () => ({ maybeAutoRefresh: vi.fn() }));
      ({ createCallCommand } = await import('./call.js'));
    });

    it('says in one line that --json returns {"content":[...]} for non-text results', () => {
      const lines = helpText().split('\n').filter((line) => line.includes('--json') && line.includes('{"content":[...]}'));
      expect(lines).toHaveLength(1);
      expect(lines[0]).toMatch(/non-text/);
    });

    it('lists exit status 2 for params that are not a JSON object, and the stderr note for omitted parts', () => {
      const help = helpText();
      expect(help).toMatch(/2 when the params .*not a JSON object/s);
      expect(help).toContain('[omitted: ...]');
      expect(help).toContain('mcpkit call <server> -- <tool>');
    });
  });

  describe('a tool name that starts with a dash', () => {
    it('is read as the tool when it follows --, through a parent program like the real CLI', async () => {
      mocks.callTool.mockResolvedValue(success('ok'));
      vi.doMock('../config.js', () => ({ getServer: vi.fn().mockResolvedValue(entry()) }));
      vi.doMock('../client.js', () => ({ callTool: mocks.callTool, callToolsChained: mocks.callToolsChained, connectToolSession: mocks.connectToolSession }));
      vi.doMock('../auth.js', () => ({ authenticateIfNeeded: mocks.authenticateIfNeeded }));
      vi.doMock('../runtime-config.js', () => ({ isPersistentRuntimeEntry: mocks.isPersistentRuntimeEntry }));
      vi.doMock('../runtime-manager.js', () => ({ callPersistentRuntime: mocks.callPersistentRuntime }));
      vi.doMock('../auto-refresh.js', () => ({ maybeAutoRefresh: mocks.maybeAutoRefresh }));
      const { createCallCommand } = await import('./call.js');
      const parse = (...argv: string[]) => new Command().name('mcpkit').exitOverride().configureOutput({ writeErr: () => {} })
        .addCommand(createCallCommand().exitOverride().configureOutput({ writeErr: () => {} }))
        .parseAsync(argv, { from: 'user' });

      await parse('call', 'srv', '--', '--flag', '{"a":1}');
      await parse('call', '--json', 'srv', '--', '-x');
      await parse('call', 'srv', '--', '--', '{}');

      expect(mocks.callTool.mock.calls.map((call) => [call[1], call[2]])).toEqual([['--flag', { a: 1 }], ['-x', {}], ['--', {}]]);
      await expect(parse('call', 'srv', '--flag', '{}')).rejects.toMatchObject({ code: 'commander.unknownOption' });
    });
  });

  describe('transport errors', () => {
    it('keep exiting with code 1 and a message on stderr', async () => {
      mocks.callTool.mockRejectedValue(new Error('connection refused'));

      await runCall(['srv', 'tool', '{}']);

      expect(stdoutText()).toBe('');
      expect(stderrText()).toContain('Error: connection refused');
      expect(exit).toHaveBeenCalledWith(1);
    });

    it('never quote the credentials of the server: a header, a URL key or a launch argument', async () => {
      const remote = entry({
        transport: { type: 'http', url: 'https://host.example/mcp?api_key=URLKEY-0123456789', headers: { 'X-Api-Key': 'HEADERKEY-abcdef0123' } },
      });
      mocks.callTool.mockRejectedValue(new Error('POST https://host.example/mcp?api_key=URLKEY-0123456789 failed: x-api-key HEADERKEY-abcdef0123 rejected'));

      await runCall(['srv', 'tool', '{}'], remote);

      expect(stderrText()).toBe('Error: POST https://host.example/mcp<redacted> failed: x-api-key <redacted> rejected');
      expect(exit).toHaveBeenCalledWith(1);
    });

    it('never quote a credential written into the launch arguments of a stdio server', async () => {
      const local = entry({
        transport: { type: 'stdio', command: 'npx', args: ['mcp-remote', 'https://host.example/mcp', '--header', 'x-api-key: LAUNCHKEY-0123456789'] },
      });
      mocks.callTool.mockRejectedValue(new Error('spawn failed: npx mcp-remote https://host.example/mcp --header x-api-key: LAUNCHKEY-0123456789'));

      await runCall(['srv', 'tool', '{}'], local);

      expect(stderrText()).not.toContain('LAUNCHKEY');
      expect(stderrText()).toContain('--header x-api-key: <redacted>');
    });

    it('leave what a tool says alone: a tool error is the tool result, like its output', async () => {
      const configured = entry({ transport: { type: 'stdio', command: 'node', args: ['server.js'], env: { BASE_URL: 'https://api.example.com/v1' } } });
      mocks.callTool.mockResolvedValue(failure('GET https://api.example.com/v1/items returned 404'));

      await runCall(['srv', 'tool', '{}'], configured);

      expect(stderrText()).toBe('Error: Tool "tool" returned an error: GET https://api.example.com/v1/items returned 404');
    });

    it('keep the env hint of a missing variable: the recipe is what the message is for', async () => {
      const hinted = entry({ envHints: { MY_TOKEN: 'Mint one with `mint-token`.' } });
      mocks.callTool.mockRejectedValue(new Error('Environment variable "MY_TOKEN" is not set.\n\nHint: Mint one with `mint-token`.'));

      await runCall(['srv', 'tool', '{}'], hinted);

      expect(stderrText()).toContain('Hint: Mint one with `mint-token`.');
    });
  });
});
