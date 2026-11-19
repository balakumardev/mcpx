import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { MockInstance } from 'vitest';
import type { ServerEntry } from '../types.js';

/**
 * `call` from the MCP SDK up to stdout and stderr: only the SDK's transport and client are replaced,
 * so the client turns each raw result into a `ToolCallOutput` and `call` prints it, exactly as in use.
 */

const png = (bytes: number, mimeType = 'image/png') => ({ type: 'image', data: Buffer.alloc(bytes, 7).toString('base64'), mimeType });
const text = (value: string) => ({ type: 'text', text: value });

function entry(): ServerEntry {
  return {
    name: 'srv',
    transport: { type: 'stdio', command: 'mock-server', args: [] },
    toolCount: 1,
    agents: ['claude-code'],
    createdAt: '2026-04-14T00:00:00.000Z',
    updatedAt: '2026-04-14T00:00:00.000Z',
  };
}

describe('call output for results with non-text parts', () => {
  let results: Record<string, unknown>[] = [];
  let stdout: MockInstance<typeof process.stdout.write>;
  let stderr: MockInstance<typeof console.error>;
  let exit: MockInstance<typeof process.exit>;
  const persistent = { enabled: false, outputs: [] as unknown[] };

  async function runCall(...args: string[]): Promise<void> {
    vi.resetModules();
    (globalThis as typeof globalThis & { __PKG_VERSION__?: string }).__PKG_VERSION__ = 'test';
    vi.doMock('@modelcontextprotocol/sdk/client/index.js', () => ({
      Client: class {
        connect = vi.fn(async () => {});
        callTool = vi.fn(async () => results.shift());
      },
    }));
    vi.doMock('@modelcontextprotocol/sdk/client/stdio.js', () => ({ StdioClientTransport: class { close = vi.fn(async () => {}); } }));
    vi.doMock('../config.js', () => ({ getServer: vi.fn().mockResolvedValue(entry()) }));
    vi.doMock('../auth.js', () => ({ authenticateIfNeeded: vi.fn() }));
    vi.doMock('../runtime-config.js', () => ({ isPersistentRuntimeEntry: () => persistent.enabled }));
    vi.doMock('../runtime-manager.js', () => ({ callPersistentRuntime: vi.fn(async () => persistent.outputs) }));
    vi.doMock('../auto-refresh.js', () => ({ maybeAutoRefresh: vi.fn() }));

    const { createCallCommand } = await import('./call.js');
    await createCallCommand().parseAsync(['srv', ...args], { from: 'user' });
  }

  const stdoutText = () => stdout.mock.calls.map(([chunk]) => String(chunk)).join('');
  const stderrLines = () => stderr.mock.calls.map(([line]) => String(line));

  beforeEach(() => {
    results = [];
    persistent.enabled = false;
    stdout = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    stderr = vi.spyOn(console, 'error').mockImplementation(() => {});
    exit = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never);
  });

  afterEach(() => {
    delete (globalThis as typeof globalThis & { __PKG_VERSION__?: string }).__PKG_VERSION__;
    vi.doUnmock('@modelcontextprotocol/sdk/client/index.js');
    vi.doUnmock('@modelcontextprotocol/sdk/client/stdio.js');
    vi.restoreAllMocks();
    vi.resetModules();
  });

  const note = (description: string) => `[omitted: ${description}; use --json or mcpkit exec]`;

  describe('plain output', () => {
    it('an image-only result prints nothing on stdout, never the base64, and notes the image', async () => {
      const shot = png(61969);
      results = [{ content: [shot] }];

      await runCall('screenshot', '{}');

      expect(stdoutText()).toBe('');
      expect(stdoutText()).not.toContain(shot.data);
      expect(stderrLines()).toEqual([note('image/png 61969 bytes')]);
      expect(exit).not.toHaveBeenCalled();
    });

    it('a text-only result prints the text and says nothing on stderr', async () => {
      results = [{ content: [text('hello'), text('world')] }];

      await runCall('say', '{}');

      expect(stdoutText()).toBe('hello\nworld');
      expect(stderrLines()).toEqual([]);
    });

    it('a text-and-image result prints the text and notes the image', async () => {
      const shot = png(300);
      results = [{ content: [text('Took a screenshot'), shot] }];

      await runCall('screenshot', '{}');

      expect(stdoutText()).toBe('Took a screenshot');
      expect(stdoutText()).not.toContain(shot.data);
      expect(stderrLines()).toEqual([note('image/png 300 bytes')]);
    });

    it('a structured-content-and-image result prints the structured content and notes the image', async () => {
      const shot = png(48);
      results = [{ structuredContent: { width: 800, height: 600 }, content: [shot] }];

      await runCall('screenshot', '{}');

      expect(JSON.parse(stdoutText())).toEqual({ width: 800, height: 600 });
      expect(stdoutText()).not.toContain(shot.data);
      expect(stderrLines()).toEqual([note('image/png 48 bytes')]);
    });

    it('a structured, text and image result notes the image once', async () => {
      results = [{ structuredContent: { ok: true }, content: [text('{"ok":true}'), png(9)] }];

      await runCall('screenshot', '{}');

      expect(stdoutText()).toBe('{"ok":true}');
      expect(stderrLines()).toEqual([note('image/png 9 bytes')]);
    });

    it('several images are counted in one note, and other kinds each get their own', async () => {
      results = [{
        content: [png(1000), png(500), { type: 'audio', data: Buffer.alloc(40).toString('base64'), mimeType: 'audio/wav' }],
      }];

      await runCall('shoot', '{}');

      expect(stdoutText()).toBe('');
      expect(stderrLines()).toEqual([note('2 x image/png, 1500 bytes'), note('audio/wav 40 bytes')]);
    });

    it('a resource link and an embedded resource are noted, and their content is not printed', async () => {
      results = [{
        content: [
          { type: 'resource_link', uri: 'file:///tmp/report.pdf', name: 'report' },
          { type: 'resource', resource: { uri: 'mem://blob', blob: Buffer.alloc(10).toString('base64') } },
        ],
      }];

      await runCall('find', '{}');

      expect(stdoutText()).toBe('');
      expect(stderrLines()).toEqual([note('resource_link file:///tmp/report.pdf'), note('resource mem://blob 10 bytes')]);
    });

    it('notes each step of a chain, and keeps the base64 out of what $prev hands on', async () => {
      const shot = png(12);
      results = [{ content: [shot] }, { content: [text('two'), png(5)] }];

      await runCall('first', '{}', '--chain', 'second:{"seen":"$prev._text"}');

      expect(stdoutText()).toBe('two\n');
      expect(stderrLines()).toEqual([
        '[omitted (step 1 of 2): image/png 12 bytes; use --json or mcpkit exec]',
        '[omitted (step 2 of 2): image/png 5 bytes; use --json or mcpkit exec]',
      ]);
    });

    it('notes what a persistent runtime reports as left out, step by step, exactly as it does for a call made here', async () => {
      persistent.enabled = true;
      persistent.outputs = [
        { text: '{"w":3}', value: { w: 3 }, isError: false, omitted: ['image/png 21 bytes'] },
        { text: 'two', value: 'two', isError: false, omitted: ['2 x image/png, 30 bytes', 'audio/wav 4 bytes'] },
      ];

      await runCall('first', '{}', '--chain', 'second:{}');

      expect(stdoutText()).toBe('{"w":3}\ntwo\n');
      expect(stderrLines()).toEqual([
        '[omitted (step 1 of 2): image/png 21 bytes; use --json or mcpkit exec]',
        '[omitted (step 2 of 2): 2 x image/png, 30 bytes; use --json or mcpkit exec]',
        '[omitted (step 2 of 2): audio/wav 4 bytes; use --json or mcpkit exec]',
      ]);
    });

    it('says nothing for a persistent runtime result that reports nothing left out, whatever its value looks like', async () => {
      persistent.enabled = true;
      // The value alone must not be read for parts any more: the runtime says what it left out.
      persistent.outputs = [{ text: '', value: { content: [png(21)] }, isError: false }];

      await runCall('screenshot', '{}');

      expect(stdoutText()).toBe('');
      expect(stderrLines()).toEqual([]);
    });
  });

  describe('a tool error', () => {
    it('with an image: exit 1, nothing on stdout, the message on stderr and no note', async () => {
      results = [{ isError: true, content: [text('page crashed'), png(33)] }];

      await runCall('screenshot', '{}');

      expect(stdoutText()).toBe('');
      expect(stderrLines()).toHaveLength(1);
      expect(stderrLines()[0]).toContain('Tool "screenshot" returned an error: page crashed');
      expect(exit).toHaveBeenCalledWith(1);
    });

    it('that is only an image has no message to show', async () => {
      results = [{ isError: true, content: [png(33)] }];

      await runCall('screenshot', '{}');

      expect(stdoutText()).toBe('');
      expect(stderrLines()[0]).toContain('returned an error: (no message)');
      expect(exit).toHaveBeenCalledWith(1);
    });
  });

  describe('--json', () => {
    it('prints an image-only result as {"content":[...]} with the raw part, and no note', async () => {
      const shot = png(30);
      results = [{ content: [shot] }];

      await runCall('screenshot', '{}', '--json');

      expect(JSON.parse(stdoutText())).toEqual({ content: [shot] });
      expect(stderrLines()).toEqual([]);
    });

    it('prints a text-and-image result as {"content":[...]} and a structured one as its structured content', async () => {
      const shot = png(30);
      results = [{ content: [text('shot'), shot] }, { structuredContent: { w: 1 }, content: [png(2)] }];

      await runCall('screenshot', '{}', '--json');
      expect(JSON.parse(stdoutText())).toEqual({ content: [text('shot'), shot] });

      stdout.mockClear();
      await runCall('screenshot', '{}', '--json');
      expect(JSON.parse(stdoutText())).toEqual({ w: 1 });
      expect(stderrLines()).toEqual([]);
    });
  });
});
