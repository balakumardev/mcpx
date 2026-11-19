import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { parse } from 'yaml';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

/**
 * One walk through the whole discovery and scripting surface, driven through
 * the real built CLI (dist/cli.js, built once by the vitest global setup) with
 * a throwaway HOME and the fixture stdio MCP server:
 * install, schema cache, search, describe, types, call, call --json, exec and
 * its write gate, remove. The cases run in order and share the one install.
 * Nothing here can reach the real ~/.mcpkit or ~/.claude: every process gets
 * HOME and USERPROFILE of the temporary directory.
 */

const root = fileURLToPath(new URL('../../', import.meta.url));
const cliPath = join(root, 'dist', 'cli.js');
const fixturePath = join(root, 'test', 'fixtures', 'fixture-server.mjs');

// Every case starts the CLI and usually the fixture server as processes.
vi.setConfig({ testTimeout: 60_000 });

let home: string;
let work: string;

interface CliResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

interface Envelope {
  ok: boolean;
  result?: unknown;
  error?: { kind: string; message: string; tool?: string };
  logs: string[];
  calls: number;
  blocked: string[];
  truncated?: boolean;
}

function cli(args: string[]): CliResult {
  const run = spawnSync(process.execPath, [cliPath, ...args], {
    cwd: work,
    env: { ...process.env, HOME: home, USERPROFILE: home },
    input: '',
    encoding: 'utf-8',
    timeout: 60_000,
  });
  return { code: run.status, stdout: run.stdout, stderr: run.stderr };
}

/** Run `exec`; its stdout must be exactly one line of JSON, the envelope. */
function exec(args: string[]): { envelope: Envelope; code: number | null } {
  const { code, stdout, stderr } = cli(['exec', ...args]);
  const lines = stdout.split('\n').filter((line) => line !== '');
  expect(lines, `exec must print one JSON line, got: ${stdout} (stderr: ${stderr})`).toHaveLength(1);
  return { envelope: JSON.parse(lines[0]) as Envelope, code };
}

function readJson<T>(...segments: string[]): T {
  return JSON.parse(readFileSync(join(home, ...segments), 'utf-8')) as T;
}

/** Type-check `consumer` against the emitted declarations, the way an editor would. */
function typeErrors(declarations: string, consumer: string): string[] {
  const dir = join(work, 'typecheck');
  mkdirSync(dir, { recursive: true });
  const declarationsFile = join(dir, 'mcp.d.ts');
  const consumerFile = join(dir, 'consumer.ts');
  writeFileSync(declarationsFile, declarations);
  writeFileSync(consumerFile, consumer);

  const program = ts.createProgram([declarationsFile, consumerFile], {
    strict: true,
    noEmit: true,
    target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.ESNext,
    lib: ['lib.es2022.d.ts'],
    types: [],
  });
  return ts.getPreEmitDiagnostics(program).map((diagnostic) => ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n'));
}

beforeAll(() => {
  expect(existsSync(cliPath), `${cliPath} is missing: the vitest global setup (test/setup/build-dist.ts) builds it`).toBe(true);
  home = mkdtempSync(join(realpathSync(tmpdir()), 'mch-int-'));
  work = join(home, 'work');
  mkdirSync(work);
});

afterAll(() => {
  rmSync(home, { recursive: true, force: true });
});

describe('code mode through the built CLI', () => {
  it('installs the fixture server and writes the registry entry and the skill files', () => {
    const spec = JSON.stringify({ mcpServers: { fx: { command: process.execPath, args: [fixturePath] } } });
    const { code, stdout, stderr } = cli(['install', spec, '--agent', 'claude-code', '--scope', 'global']);

    expect(code, stderr).toBe(0);
    expect(stdout).toContain('Found 7 tool(s)');

    const registry = parse(readFileSync(join(home, '.mcpkit', 'servers.yaml'), 'utf-8')) as {
      servers: Record<string, { transport: { type: string; command: string }; toolCount: number }>;
    };
    expect(registry.servers.fx.transport).toMatchObject({ type: 'stdio', command: process.execPath });
    expect(registry.servers.fx.toolCount).toBe(7);

    expect(existsSync(join(home, '.claude', 'skills', 'mcpkit-fx', 'SKILL.md'))).toBe(true);
    const guide = readFileSync(join(home, '.claude', 'skills', 'mcpkit-cli', 'SKILL.md'), 'utf-8');
    for (const command of ['mcpkit search', 'mcpkit describe', 'mcpkit types', 'mcpkit exec', '--allow-read-only']) {
      expect(guide).toContain(command);
    }
  });

  it('caches the tool schemas with outputSchema and annotations', () => {
    const cache = readJson<{
      version: number;
      server: string;
      fetchedAt: string;
      tools: Array<{ name: string; outputSchema?: { properties?: Record<string, unknown> }; annotations?: Record<string, unknown> }>;
    }>('.mcpkit', 'schemas', 'fx.json');

    expect(cache.version).toBe(1);
    expect(cache.server).toBe('fx');
    expect(Number.isNaN(Date.parse(cache.fetchedAt))).toBe(false);
    expect(cache.tools.map((tool) => tool.name).sort()).toEqual(['add', 'big', 'echo', 'fail', 'list_items', 'slow', 'write_note']);

    const echo = cache.tools.find((tool) => tool.name === 'echo');
    expect(echo?.outputSchema?.properties).toHaveProperty('message');
    expect(echo?.annotations).toMatchObject({ readOnlyHint: true });
    expect(cache.tools.find((tool) => tool.name === 'write_note')?.annotations).toMatchObject({ readOnlyHint: false, destructiveHint: true });
  });

  it('searches the cache offline by name and by description', () => {
    const byName = cli(['search', 'echo', '--json']);
    expect(byName.code, byName.stderr).toBe(0);
    const hits = JSON.parse(byName.stdout) as Array<{ server: string; tool: string }>;
    expect(hits[0]).toMatchObject({ server: 'fx', tool: 'echo' });

    const byDescription = cli(['search', 'kilobytes', '--server', 'fx']);
    expect(byDescription.code, byDescription.stderr).toBe(0);
    expect(byDescription.stdout).toContain('fx.big');

    const nothing = cli(['search', 'qqqxyz']);
    expect(nothing.stdout).not.toContain('fx.');
  });

  it('describes a tool with its schemas, annotations and a ready example', () => {
    const text = cli(['describe', 'fx', 'echo']);
    expect(text.code, text.stderr).toBe(0);
    expect(text.stdout).toContain('Parameters (JSON Schema)');
    expect(text.stdout).toContain('Output schema');
    expect(text.stdout).toContain('server-declared, untrusted');
    expect(text.stdout).toContain(`mcpkit call fx echo '{"message":`);

    const json = cli(['describe', 'fx', 'echo', '--json']);
    expect(JSON.parse(json.stdout)).toMatchObject({
      server: 'fx',
      tool: 'echo',
      inputSchema: { required: ['message'] },
      annotations: { readOnlyHint: true },
    });

    const unknown = cli(['describe', 'fx', 'ech']);
    expect(unknown.code).toBe(1);
    expect(unknown.stderr + unknown.stdout).toContain('echo');
  });

  it('emits declarations that compile, type the arguments and the output, and reject wrong calls', () => {
    const { code, stdout, stderr } = cli(['types', 'fx']);
    expect(code, stderr).toBe(0);
    expect(stdout).toContain('declare const mcp');

    const valid = `
      export async function run(): Promise<void> {
        const echoed = await mcp.fx.echo({ message: 'x' });
        const text: string = echoed.message;
        const sum: unknown = await mcp.fx.add({ a: 1, b: 2 });
        const items: unknown = await mcp.fx.list_items();
        void [text, sum, items];
      }
    `;
    expect(typeErrors(stdout, valid)).toEqual([]);

    // The types are not all `any`: wrong arguments, a wrong output type and an unknown tool are errors.
    expect(typeErrors(stdout, `void mcp.fx.echo({ message: 1 });`).join('\n')).toContain('not assignable');
    expect(typeErrors(stdout, `async function f() { const n: number = (await mcp.fx.echo({ message: 'x' })).message; void n; }`)).not.toEqual([]);
    expect(typeErrors(stdout, `void mcp.fx.no_such_tool();`)).not.toEqual([]);

    const narrowed = cli(['types', 'fx', '--tools', 'echo,add']);
    expect(narrowed.stdout).toContain('echo(');
    expect(narrowed.stdout).toContain('add(');
    expect(narrowed.stdout).not.toContain('write_note');
  });

  it('prints the plain result of a successful call, and the same value as JSON with --json', () => {
    const plain = cli(['call', 'fx', 'add', '{"a":1,"b":2}']);
    expect(plain.code, plain.stderr).toBe(0);
    expect(plain.stdout).toBe('3');

    const structured = cli(['call', 'fx', 'echo', '{"message":"hi"}', '--json']);
    expect(structured.code, structured.stderr).toBe(0);
    expect(JSON.parse(structured.stdout)).toEqual({ message: 'hi' });

    const jsonText = cli(['call', 'fx', 'list_items', '{}', '--json']);
    expect(jsonText.code, jsonText.stderr).toBe(0);
    expect(JSON.parse(jsonText.stdout)).toEqual([
      { id: 1, name: 'one' },
      { id: 2, name: 'two' },
      { id: 3, name: 'three' },
    ]);
  });

  it('exits 1 with nothing on stdout when the tool reports an error', () => {
    for (const extra of [[], ['--json']]) {
      const failed = cli(['call', 'fx', 'fail', '{}', ...extra]);
      expect(failed.code).toBe(1);
      expect(failed.stdout).toBe('');
      expect(failed.stderr).toContain('deliberate failure');
    }
  });

  it('runs a read-only tool through exec with --allow-read-only', () => {
    const { envelope, code } = exec(['--allow-read-only', '-c', 'return await mcp.fx.echo({ message: "hi" })']);
    expect(code).toBe(0);
    expect(envelope).toEqual({ ok: true, result: { message: 'hi' }, logs: [], calls: 1, blocked: [], truncated: false });
  });

  it('blocks a tool without a read-only hint under --allow-read-only, and a write by default', () => {
    const unannotated = exec(['--allow-read-only', '-c', 'return await mcp.fx.add({ a: 1, b: 2 })']);
    expect(unannotated.code).toBe(1);
    expect(unannotated.envelope.ok).toBe(false);
    expect(unannotated.envelope.error).toMatchObject({ kind: 'blocked', tool: 'fx.add' });
    expect(unannotated.envelope.blocked).toEqual(['fx.add']);

    const write = exec(['-c', 'return await mcp.fx.write_note({ text: "x" })']);
    expect(write.code).toBe(1);
    expect(write.envelope.error).toMatchObject({ kind: 'blocked', tool: 'fx.write_note' });
    expect(write.envelope.error?.message).toContain('--allow fx.write_note');

    // A script that catches the block still reports it.
    const caught = exec(['-c', 'try { await mcp.fx.write_note({ text: "x" }); } catch (error) { return "caught"; }']);
    expect(caught.code).toBe(0);
    expect(caught.envelope).toMatchObject({ ok: true, result: 'caught', blocked: ['fx.write_note'] });
  });

  it('allows a write with --allow server.tool and with --allow-writes', () => {
    const allowed = exec(['--allow', 'fx.write_note', '-c', 'return await mcp.fx.write_note({ text: "x" })']);
    expect(allowed.code).toBe(0);
    expect(allowed.envelope).toMatchObject({ ok: true, result: { written: 'x' }, blocked: [] });

    const everything = exec(['--allow-writes', '-c', 'return await mcp.fx.write_note({ text: "y" })']);
    expect(everything.code).toBe(0);
    expect(everything.envelope).toMatchObject({ ok: true, result: { written: 'y' } });
  });

  it('reports tool and script failures in the envelope with exit 1, and usage errors with exit 2', () => {
    const toolFailure = exec(['--allow', 'fx.fail', '-c', 'return await mcp.fx.fail({})']);
    expect(toolFailure.code).toBe(1);
    expect(toolFailure.envelope.error).toMatchObject({ kind: 'tool', tool: 'fx.fail' });
    expect(toolFailure.envelope.error?.message).toContain('deliberate failure');

    const scriptFailure = exec(['-c', 'console.log("before"); throw new Error("boom");']);
    expect(scriptFailure.code).toBe(1);
    expect(scriptFailure.envelope.error).toMatchObject({ kind: 'script' });
    expect(scriptFailure.envelope.error?.message).toContain('boom');
    expect(scriptFailure.envelope.logs).toEqual(['before']);

    const usage = cli(['exec']);
    expect(usage.code).toBe(2);
    expect(usage.stdout).toBe('');
  });

  it('removes the server together with its schema cache and skill files', () => {
    expect(existsSync(join(home, '.mcpkit', 'schemas', 'fx.json'))).toBe(true);

    const { code, stderr } = cli(['remove', 'fx']);
    expect(code, stderr).toBe(0);

    expect(existsSync(join(home, '.mcpkit', 'schemas', 'fx.json'))).toBe(false);
    expect(existsSync(join(home, '.claude', 'skills', 'mcpkit-fx'))).toBe(false);
    const registry = parse(readFileSync(join(home, '.mcpkit', 'servers.yaml'), 'utf-8')) as { servers?: Record<string, unknown> } | null;
    expect(registry?.servers ?? {}).not.toHaveProperty('fx');
  });
});
