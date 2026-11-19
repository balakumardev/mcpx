import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { sourceUrl } from '../test-utils.js';

/**
 * The same results, through the real CLI, from a real MCP server built on the SDK: once with the
 * call made in the CLI process, once through a persistent runtime (a daemon that holds the MCP
 * session and answers over a socket). Both have to print the same stdout and the same stderr notes.
 */

const SERVER = `
import { McpServer } from ${JSON.stringify(sourceUrl('node_modules/@modelcontextprotocol/sdk/dist/esm/server/mcp.js'))};
import { StdioServerTransport } from ${JSON.stringify(sourceUrl('node_modules/@modelcontextprotocol/sdk/dist/esm/server/stdio.js'))};
import { z } from ${JSON.stringify(sourceUrl('node_modules/zod/index.js'))};

const data = Buffer.alloc(4000, 9).toString('base64');
const image = { type: 'image', data, mimeType: 'image/png' };
const server = new McpServer({ name: 'parts', version: '1.0.0' });
const tool = (name, outputSchema, result) => server.registerTool(
  name,
  { description: name, inputSchema: {}, ...(outputSchema ? { outputSchema } : {}) },
  async () => result,
);
tool('shot', undefined, { content: [image] });
tool('shot_text', undefined, { content: [{ type: 'text', text: 'Took a screenshot' }, image] });
tool('shot_struct', { w: z.number() }, { structuredContent: { w: 3 }, content: [image] });
tool('shot_struct_text', { w: z.number() }, { structuredContent: { w: 3 }, content: [{ type: 'text', text: '{"w":3}' }, image] });
tool('shots', undefined, { content: [image, image, { type: 'audio', data, mimeType: 'audio/wav' }] });
tool('links', undefined, { content: [
  { type: 'resource_link', uri: 'file:///tmp/report.pdf', name: 'report' },
  { type: 'resource', resource: { uri: 'mem://blob', blob: Buffer.alloc(10).toString('base64') } },
] });
tool('shot_err', undefined, { isError: true, content: [{ type: 'text', text: 'page crashed' }, image] });
await server.connect(new StdioServerTransport());
`;

const MINI_CLI = `
globalThis.__PKG_VERSION__ = 'test';
const { Command } = await import(${JSON.stringify(sourceUrl('node_modules/commander/esm.mjs'))});
const { createCallCommand } = await import(${JSON.stringify(sourceUrl('src/commands/call.ts'))});
const { createRuntimeCommand } = await import(${JSON.stringify(sourceUrl('src/commands/runtime.ts'))});
const program = new Command().name('mcpkit');
program.addCommand(createCallCommand());
program.addCommand(createRuntimeCommand());
program.parse();
`;

const IMAGE_BYTES = 4000;
const note = (description: string, step = '') => `[omitted${step}: ${description}; use --json or mcpkit exec]`;
const imageNote = note(`image/png ${IMAGE_BYTES} bytes`);

interface Outcome { code: number | null; stdout: string; stderr: string }

describe('call output for results with non-text parts, from a real MCP server', () => {
  const originalHome = process.env.HOME;
  let homeDir = '';

  function cli(...args: string[]): Promise<Outcome> {
    return new Promise((resolve, reject) => {
      const child = spawn(process.execPath, ['--import', 'tsx', join(homeDir, 'mini-cli.mjs'), ...args], {
        cwd: process.cwd(),
        env: { ...process.env, HOME: homeDir, USERPROFILE: homeDir },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      let stdout = '';
      let stderr = '';
      child.stdout.on('data', (chunk) => { stdout += chunk; });
      child.stderr.on('data', (chunk) => { stderr += chunk; });
      child.once('error', reject);
      child.once('close', (code) => resolve({ code, stdout, stderr }));
    });
  }

  const stderrLines = (outcome: Outcome) => outcome.stderr.split('\n').filter(Boolean);

  beforeAll(async () => {
    homeDir = await mkdtemp(join(tmpdir(), 'mcpkit-omitted-'));
    process.env.HOME = homeDir;
    await writeFile(join(homeDir, 'mini-cli.mjs'), MINI_CLI, 'utf-8');
    await writeFile(join(homeDir, 'parts-server.mjs'), SERVER, 'utf-8');
    const now = new Date().toISOString();
    const server = (name: string, runtime: string[]) => [
      `  ${name}:`,
      `    name: ${name}`,
      '    transport:',
      '      type: stdio',
      `      command: ${JSON.stringify(process.execPath)}`,
      `      args: [${JSON.stringify(join(homeDir, 'parts-server.mjs'))}]`,
      ...runtime,
      '    toolCount: 7',
      '    agents: [cursor]',
      `    createdAt: ${now}`,
      `    updatedAt: ${now}`,
    ];
    await mkdir(join(homeDir, '.mcpkit'), { recursive: true });
    await writeFile(join(homeDir, '.mcpkit', 'servers.yaml'), [
      'version: 1',
      'servers:',
      ...server('inproc', []),
      ...server('daemon', ['    runtime:', '      mode: persistent', '      idleTimeoutSec: 60', '      callTimeoutSec: 30']),
      '',
    ].join('\n'), 'utf-8');
  });

  afterAll(async () => {
    await cli('runtime', 'stop', 'daemon').catch(() => undefined);
    if (originalHome === undefined) delete process.env.HOME;
    else process.env.HOME = originalHome;
    await rm(homeDir, { recursive: true, force: true });
  });

  describe.each([['in the CLI process', 'inproc'], ['through a persistent runtime', 'daemon']])('%s', (_label, server) => {
    it('an image-only result prints nothing on stdout, never the base64, and notes the image', async () => {
      const outcome = await cli('call', server, 'shot', '{}');

      expect(outcome.code).toBe(0);
      expect(outcome.stdout).toBe('');
      expect(stderrLines(outcome)).toEqual([imageNote]);
    }, 30_000);

    it('a text-and-image result prints the text and notes the image', async () => {
      const outcome = await cli('call', server, 'shot_text', '{}');

      expect(outcome.stdout).toBe('Took a screenshot');
      expect(stderrLines(outcome)).toEqual([imageNote]);
    }, 30_000);

    it('a structured-content-and-image result prints the structured content and notes the image', async () => {
      const outcome = await cli('call', server, 'shot_struct', '{}');

      expect(JSON.parse(outcome.stdout)).toEqual({ w: 3 });
      expect(stderrLines(outcome)).toEqual([imageNote]);
    }, 30_000);

    it('a structured, text and image result prints the text and notes the image once', async () => {
      const outcome = await cli('call', server, 'shot_struct_text', '{}');

      expect(outcome.stdout).toBe('{"w":3}');
      expect(stderrLines(outcome)).toEqual([imageNote]);
    }, 30_000);

    it('several images are counted in one note, and other kinds each get their own', async () => {
      const outcome = await cli('call', server, 'shots', '{}');

      expect(outcome.stdout).toBe('');
      expect(stderrLines(outcome)).toEqual([
        note(`2 x image/png, ${2 * IMAGE_BYTES} bytes`),
        note(`audio/wav ${IMAGE_BYTES} bytes`),
      ]);
    }, 30_000);

    it('a resource link and an embedded resource are noted, and their content is not printed', async () => {
      const outcome = await cli('call', server, 'links', '{}');

      expect(outcome.stdout).toBe('');
      expect(stderrLines(outcome)).toEqual([note('resource_link file:///tmp/report.pdf'), note('resource mem://blob 10 bytes')]);
    }, 30_000);

    it('notes each step of a chain', async () => {
      const outcome = await cli('call', server, 'shot_struct', '{}', '--chain', 'shot_text:{}');

      expect(outcome.stdout).toContain('Took a screenshot');
      expect(stderrLines(outcome)).toEqual([
        note(`image/png ${IMAGE_BYTES} bytes`, ' (step 1 of 2)'),
        note(`image/png ${IMAGE_BYTES} bytes`, ' (step 2 of 2)'),
      ]);
    }, 30_000);

    it('a tool error with an image: exit 1, nothing on stdout, the message on stderr and no note', async () => {
      const outcome = await cli('call', server, 'shot_err', '{}');

      expect(outcome.code).toBe(1);
      expect(outcome.stdout).toBe('');
      expect(outcome.stderr).toContain('Tool "shot_err" returned an error: page crashed');
      expect(outcome.stderr).not.toContain('[omitted');
    }, 30_000);

    it('--json prints the raw parts of an image-only result and the structured content of a structured one, with no note', async () => {
      const imageOnly = await cli('call', server, 'shot', '{}', '--json');
      const structured = await cli('call', server, 'shot_struct', '{}', '--json');

      expect(JSON.parse(imageOnly.stdout)).toEqual({
        content: [{ type: 'image', data: Buffer.alloc(IMAGE_BYTES, 9).toString('base64'), mimeType: 'image/png' }],
      });
      expect(JSON.parse(structured.stdout)).toEqual({ w: 3 });
      expect(imageOnly.stderr).toBe('');
      expect(structured.stderr).toBe('');
    }, 30_000);
  });
});
