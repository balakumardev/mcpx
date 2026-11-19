import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdir, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { Command } from 'commander';
import { stringify } from 'yaml';
import { discoverTools } from '../client.js';
import { saveSchemaCache } from '../schema-store.js';
import type { ServerEntry, ToolInfo } from '../types.js';
import { createDescribeCommand } from './describe.js';

vi.mock('../client.js', () => ({
  discoverTools: vi.fn(),
}));

vi.mock('../auth.js', () => ({
  authenticateIfNeeded: vi.fn(),
  createOAuthProvider: vi.fn(),
}));

const ESC = '\u001b';
const BEL = '\u0007';
const CSI_C1 = '\u009b';
const NEL = '\u0085';
const LINE_SEPARATOR = String.fromCharCode(0x2028);
const PARAGRAPH_SEPARATOR = String.fromCharCode(0x2029);

/** Everything a terminal or a line reader could act on, apart from the newline and tab that text needs. */
const UNSAFE = new RegExp(`[\\u0000-\\u0008\\u000b-\\u001f\\u007f-\\u009f${LINE_SEPARATOR}${PARAGRAPH_SEPARATOR}]`);

const hostile = (label: string): string =>
  `${label}${ESC}[2J${ESC}]0;pwned${BEL}${CSI_C1}31m\r${NEL}${LINE_SEPARATOR}${PARAGRAPH_SEPARATOR}\u007f\u0000\u0008`;

function entry(name: string): ServerEntry {
  return {
    name,
    transport: { type: 'stdio', command: 'mcpkit-test-never-spawned', args: [] },
    toolCount: 0,
    agents: [],
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  };
}

const hostileTool: ToolInfo = {
  name: 'evil_tool',
  title: hostile('Title'),
  description: `${hostile('First line')}\n\tSecond line, indented\nThird line`,
  inputSchema: {
    type: 'object',
    properties: {
      [hostile('key')]: { type: 'string', description: hostile('param doc'), default: hostile('default'), enum: [hostile('enum member'), 'ok'] },
      plain: { type: 'integer', title: `${NEL}${LINE_SEPARATOR}` },
    },
    required: [hostile('key')],
  },
  outputSchema: { type: 'object', properties: { [hostile('out')]: { const: hostile('const') } } },
  annotations: { title: hostile('annotation title'), readOnlyHint: true, [hostile('extra key')]: hostile('extra value') } as ToolInfo['annotations'],
};

describe('mcpkit describe prints server-provided text safely', () => {
  let stdout: string[] = [];
  let stderr: string[] = [];

  beforeEach(async () => {
    stdout = [];
    stderr = [];
    vi.spyOn(console, 'log').mockImplementation((...parts) => { stdout.push(parts.join(' ')); });
    vi.spyOn(console, 'error').mockImplementation((...parts) => { stderr.push(parts.join(' ')); });
    await mkdir(join(homedir(), '.mcpkit'), { recursive: true });
    await writeFile(join(homedir(), '.mcpkit', 'servers.yaml'), stringify({ version: 1, servers: { srv: entry('srv') } }), 'utf-8');
    await saveSchemaCache('srv', [hostileTool]);
  });

  afterEach(() => {
    process.exitCode = undefined;
    vi.restoreAllMocks();
    vi.clearAllMocks();
  });

  async function describeTool(...extra: string[]): Promise<string> {
    await createDescribeCommand().parseAsync(['srv', 'evil_tool', ...extra], { from: 'user' });
    expect(discoverTools).not.toHaveBeenCalled();
    expect(process.exitCode).toBeUndefined();
    return stdout.join('\n');
  }

  it('writes no escape, carriage return, C1 control or Unicode line separator to stdout', async () => {
    const text = await describeTool();
    expect(text).not.toMatch(UNSAFE);
    expect(Buffer.from(text, 'utf-8').includes(Buffer.from([0x1b]))).toBe(false);
    expect(Buffer.from(text, 'utf-8').includes(Buffer.from([0x0d]))).toBe(false);
    expect(Buffer.from(text, 'utf-8').includes(Buffer.from([0xc2, 0x85]))).toBe(false);
    expect(Buffer.from(text, 'utf-8').includes(Buffer.from([0xe2, 0x80, 0xa8]))).toBe(false);
    expect(Buffer.from(text, 'utf-8').includes(Buffer.from([0xe2, 0x80, 0xa9]))).toBe(false);
  });

  it('shows each hostile character as a visible \\uNNNN escape in the title, description, annotations and example', async () => {
    const text = await describeTool();
    const escaped = '[2J\\u001b]0;pwned\\u0007\\u009b31m\\r\\u0085\\u2028\\u2029\\u007f\\u0000\\b';
    expect(text).toContain(`Title: Title\\u001b${escaped}`);
    expect(text).toContain(`annotation title\\u001b${escaped}`);
    expect(text).toContain('readOnlyHint: true');
    expect(text).toContain(`extra key\\u001b${escaped}`);
    expect(text).toContain(`extra value\\u001b${escaped}`);
    expect(text).toContain('Example:');
  });

  it('keeps the newlines and tabs of a multi-line description', async () => {
    const text = await describeTool();
    expect(text).toMatch(/\nFirst line[^\n]*\n\tSecond line, indented\nThird line\n/);
  });

  it('keeps the Parameters and Output schema blocks valid JSON that parses back to the original schema', async () => {
    const text = await describeTool();
    const parameters = /Parameters \(JSON Schema\):\n([\s\S]*?)\n\nOutput schema:/.exec(text)?.[1] ?? '';
    const output = /Output schema:\n([\s\S]*?)\n\nAnnotations/.exec(text)?.[1] ?? '';
    expect(JSON.parse(parameters)).toEqual(hostileTool.inputSchema);
    expect(JSON.parse(output)).toEqual(hostileTool.outputSchema);
  });

  it('leaves the example line a single shell line with no raw control character', async () => {
    const text = await describeTool();
    const example = /Example:\n  (mcpkit call [^\n]*)$/.exec(text)?.[1] ?? '';
    expect(example.startsWith('mcpkit call srv evil_tool ')).toBe(true);
    expect(example).not.toMatch(UNSAFE);
  });

  it('prints a hostile name as escapes in the title line and in the not-found message', async () => {
    await createDescribeCommand().parseAsync(['srv', hostile('nope')], { from: 'user' });
    expect(stdout).toEqual([]);
    expect(stderr.join('\n')).not.toMatch(UNSAFE);
    expect(process.exitCode).toBe(1);
  });

  it('is unchanged for ordinary text', async () => {
    await saveSchemaCache('srv', [{
      name: 'plain', description: 'Line one.\n\nLine two\twith a tab.', inputSchema: { type: 'object', properties: { a: { type: 'string', description: 'Quote " and \\ backslash' } } },
    }]);
    await createDescribeCommand().parseAsync(['srv', 'plain'], { from: 'user' });
    expect(stdout[0]).toContain('Line one.\n\nLine two\twith a tab.');
    expect(stdout[0]).toContain(JSON.stringify({ type: 'object', properties: { a: { type: 'string', description: 'Quote " and \\ backslash' } } }, null, 2));
  });

  it('keeps --json output as it was: the raw strings in one line of JSON', async () => {
    const json = JSON.parse(await describeTool('--json')) as { description: string };
    expect(json.description).toBe(hostileTool.description);
  });

  describe('reads a name that starts with a dash after the -- terminator', () => {
    it('describes a tool called --flag', async () => {
      await saveSchemaCache('srv', [{ name: '--flag', description: 'A dash tool', inputSchema: { type: 'object' } }]);
      const program = new Command().name('mcpkit').exitOverride().configureOutput({ writeErr: () => {} });
      program.addCommand(createDescribeCommand().exitOverride().configureOutput({ writeErr: () => {} }));
      await program.parseAsync(['describe', 'srv', '--', '--flag'], { from: 'user' });
      expect(stdout[0]).toContain('srv.--flag');
      expect(stdout[0]).toContain(`mcpkit call srv -- --flag '{}'`);
      expect(process.exitCode).toBeUndefined();
    });
  });
});
