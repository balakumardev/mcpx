import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildCallCommand, buildSkillContent } from './generators/index.js';
import type { SkillFormat } from './generators/index.js';
import type { GeneratorContext, ToolInfo } from './types.js';

// Agents copy the example lines of a skill into a shell, so each of them has to
// parse back to the real names whatever characters a server put in them.

const SHELLS = ['/bin/bash', ...['/bin/zsh', '/usr/bin/zsh'].filter((shell) => existsSync(shell)).slice(0, 1)];

const hostileNames: Array<[string, string]> = [
  ['command substitution', 'x$(touch PWNED)'],
  ['backticks', 'x`touch PWNED`'],
  ['quotes', `it's "quoted"`],
  ['space', 'a b'],
  ['semicolon', 'a;touch PWNED'],
  ['ampersand and pipe', 'a&touch PWNED|cat'],
  ['newline', 'a\ntouch PWNED'],
  ['dollar variable', '$HOME${IFS}x'],
];

let workDir = '';

beforeEach(() => { workDir = mkdtempSync(join(tmpdir(), 'mcpkit-shell-safety-')); });
afterEach(() => { rmSync(workDir, { recursive: true, force: true }); });

function context(serverName: string, tools: ToolInfo[]): GeneratorContext {
  return { serverName, tools, transport: { type: 'stdio', command: 'node', args: [] }, scope: 'global' };
}

function toolWith(name: string, property: string): ToolInfo {
  return {
    name,
    description: 'Does a thing.',
    inputSchema: { type: 'object', properties: { [property]: { type: 'string' } }, required: [property] },
  };
}

/** Every `mcpkit ...` command a skill shows: fenced lines and the inline one in the notice. */
function commandLines(content: string): string[] {
  const lines: string[] = [];
  let fenced = false;
  for (const line of content.split('\n')) {
    if (line.startsWith('```')) { fenced = !fenced; continue; }
    if (fenced && line.startsWith('mcpkit ')) lines.push(line);
    const inline = /^> All tools must be invoked via Bash using `(mcpkit .*)`\.$/.exec(line);
    if (inline) lines.push(inline[1]);
  }
  return lines;
}

/**
 * The arguments `mcpkit` receives when `shell` runs `line`. `mcpkit` is a shell
 * function here, so anything the line makes the shell execute (a command
 * substitution, a second command) happens in `workDir` and shows up as a file.
 */
function argumentsOf(shell: string, line: string): string[] {
  const runnable = line.replace(/<(?:tool_name|tool_a|keywords|seconds)>/g, 'X');
  const output = execFileSync(shell, ['-c', `mcpkit() { printf '%s\\0' "$@"; }\n${runnable}\n`], { cwd: workDir });
  return output.toString('utf-8').split('\0').slice(0, -1);
}

describe.each(SHELLS)('generated skill commands in %s', (shell) => {
  describe.each(['full', 'compact'] as SkillFormat[])('%s format', (format) => {
    it.each(hostileNames)('runs nothing and passes the real names for a tool and server with %s', (_label, name) => {
      const property = "it's";
      const content = buildSkillContent(context(`srv ${name}`, [toolWith(name, property)]), { format });
      const lines = commandLines(content);
      expect(lines.length).toBeGreaterThan(5);

      for (const line of lines) {
        expect(argumentsOf(shell, line), line).toContain(`srv ${name}`);
      }
      expect(readdirSync(workDir)).toEqual([]);

      const example = lines
        .map((line) => argumentsOf(shell, line))
        .find((args) => args[0] === 'call' && args[2] === name && args[3]?.startsWith('{') && args[3] !== '{}');
      expect(example).toBeDefined();
      expect(Object.keys(JSON.parse(example?.[3] ?? '{}'))).toEqual([property]);
    });

    it('keeps the example JSON valid for a property name with a quote and a backslash', () => {
      const property = 'a"b\\c';
      const content = buildSkillContent(context('demo', [toolWith('tool', property)]), { format });
      const example = commandLines(content)
        .map((line) => argumentsOf(shell, line))
        .find((args) => args[0] === 'call' && args[2] === 'tool' && args[3] !== '{}');
      expect(Object.keys(JSON.parse(example?.[3] ?? '{}'))).toEqual([property]);
    });
  });

  it('quotes the server and tool in buildCallCommand', () => {
    const args = argumentsOf(shell, buildCallCommand('s$(touch PWNED)', 'x`touch PWNED`'));
    expect(args).toEqual(['call', 's$(touch PWNED)', 'x`touch PWNED`', '{}']);
    expect(readdirSync(workDir)).toEqual([]);
  });
});

describe('ordinary names', () => {
  it('stay bare in the command lines, and the JSON stays single-quoted with its spacing', () => {
    const content = buildSkillContent(context('my-server_1.0', [toolWith('create-issue.v2', 'repo/name')]), { format: 'full' });
    expect(content).toContain(`mcpkit call my-server_1.0 create-issue.v2 '{"repo/name": "<repo/name>"}'`);
    expect(content).toContain("`mcpkit call my-server_1.0 <tool_name> '<json_params>'`");
    expect(content).toContain('mcpkit list my-server_1.0   # List available tools on this server');
  });
});
