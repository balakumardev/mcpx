// A small stdio MCP server for tests: `node test/fixtures/fixture-server.mjs`.
// When FIXTURE_START_LOG names a file, every process start appends one line to it (its pid),
// so a test can count how many times the server was started. FIXTURE_CALL_LOG does the
// same for `slow`: a line when a call starts and one when it ends. FIXTURE_SLEEPER names a file:
// the server then starts a long-lived grandchild that holds the server's stdio pipes (as the
// real server under `npx` does) and appends its pid to that file; with FIXTURE_SLEEPER_IGNORE_TERM=1 it
// ignores SIGTERM, so only SIGKILL ends it. FIXTURE_FREEZE=1 stops the
// server (SIGSTOP) right after it starts, before it can answer the MCP handshake.
import { spawn } from 'node:child_process';
import { appendFileSync } from 'node:fs';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

if (process.env.FIXTURE_START_LOG) appendFileSync(process.env.FIXTURE_START_LOG, `${process.pid}\n`);

if (process.env.FIXTURE_FREEZE === '1') process.kill(process.pid, 'SIGSTOP');

if (process.env.FIXTURE_SLEEPER) {
  const ignoreTerm = process.env.FIXTURE_SLEEPER_IGNORE_TERM === '1' ? "process.on('SIGTERM', () => {});" : '';
  const sleeper = spawn(process.execPath, ['-e', `${ignoreTerm} setTimeout(() => {}, 600000)`], { stdio: 'inherit' });
  appendFileSync(process.env.FIXTURE_SLEEPER, `${sleeper.pid}\n`);
}

const server = new McpServer({ name: 'mcpkit-fixture', version: '1.0.0' });

const text = (value) => ({ content: [{ type: 'text', text: value }] });

// Read-only, with structured content and an output schema.
server.registerTool(
  'echo',
  {
    title: 'Echo',
    description: 'Return the message it is given.',
    inputSchema: { message: z.string() },
    outputSchema: { message: z.string() },
    annotations: { readOnlyHint: true },
  },
  async ({ message }) => ({
    content: [{ type: 'text', text: JSON.stringify({ message }) }],
    structuredContent: { message },
  }),
);

// Plain text result.
server.registerTool(
  'add',
  {
    description: 'Add two numbers; the result is plain text.',
    inputSchema: { a: z.number(), b: z.number() },
  },
  async ({ a, b }) => text(String(a + b)),
);

// A JSON document returned as text.
server.registerTool(
  'list_items',
  { description: 'List three items as a JSON document.' },
  async () => text(JSON.stringify([{ id: 1, name: 'one' }, { id: 2, name: 'two' }, { id: 3, name: 'three' }])),
);

// Always reports a tool error.
server.registerTool(
  'fail',
  { description: 'Always fails with isError.' },
  async () => ({ isError: true, content: [{ type: 'text', text: 'deliberate failure' }] }),
);

// A write: declared not read-only and destructive.
server.registerTool(
  'write_note',
  {
    description: 'Pretend to write a note.',
    inputSchema: { text: z.string() },
    annotations: { readOnlyHint: false, destructiveHint: true },
  },
  async ({ text: body }) => text(JSON.stringify({ written: body })),
);

server.registerTool(
  'slow',
  { description: 'Answer after a delay.', inputSchema: { ms: z.number() } },
  async ({ ms }) => {
    const log = (what) => process.env.FIXTURE_CALL_LOG && appendFileSync(process.env.FIXTURE_CALL_LOG, `slow ${ms} ${what}\n`);
    log('start');
    await new Promise((resolve) => setTimeout(resolve, ms));
    log('done');
    return text(JSON.stringify({ waited: ms }));
  },
);

server.registerTool(
  'big',
  { description: 'Return a large text result of the given size in kilobytes.', inputSchema: { kb: z.number() } },
  async ({ kb }) => text('x'.repeat(kb * 1024)),
);

// Only with FIXTURE_CRASH_TOOL=1 (the tool list is otherwise fixed): a tool that closes its
// own connection instead of answering, because the process exits.
if (process.env.FIXTURE_CRASH_TOOL === '1') {
  server.registerTool(
    'crash',
    { description: 'Exit the server process without answering.' },
    async () => {
      setTimeout(() => process.exit(0), 20);
      return new Promise(() => undefined);
    },
  );
}

await server.connect(new StdioServerTransport());
