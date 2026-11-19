import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Command } from 'commander';
import { stringify } from 'yaml';
import { discoverTools } from '../client.js';
import { generateMcpTypes } from '../codegen/mcp-types.js';
import { loadSchemaCache, saveSchemaCache, schemaCachePath } from '../schema-store.js';
import type { ServerEntry, ToolInfo } from '../types.js';
import { createDescribeCommand } from './describe.js';
import { createTypesCommand } from './gen-types.js';
import { createSearchCommand } from './search.js';

vi.mock('../client.js', () => ({
  discoverTools: vi.fn(),
}));

vi.mock('../auth.js', () => ({
  authenticateIfNeeded: vi.fn(),
  createOAuthProvider: vi.fn(),
}));

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

function tool(name: string, description: string, extra: Partial<ToolInfo> = {}): ToolInfo {
  return { name, description, inputSchema: { type: 'object' }, ...extra };
}

const githubTools: ToolInfo[] = [
  tool('create_issue', 'Create a new issue in a repository. Supports labels.', {
    title: 'Create issue',
    inputSchema: {
      type: 'object',
      properties: { owner: { type: 'string' }, repo: { type: 'string' }, title: { type: 'string' }, state: { enum: ['open', 'closed'] } },
      required: ['owner', 'repo', 'title', 'state'],
    },
    outputSchema: { type: 'object', properties: { number: { type: 'integer' } }, required: ['number'] },
    annotations: { readOnlyHint: false, destructiveHint: false },
  }),
  tool('list_issues', 'List the issues of a repository', { annotations: { readOnlyHint: true } }),
  tool('close_issue', 'Close an issue'),
  tool('update_issue', 'Update an issue'),
  tool('delete_repo', 'Delete a repository'),
  tool('get_user', 'Get a user profile'),
  tool('search_code', 'Search code across repositories'),
  tool('merge_pull_request', 'Merge a pull request'),
];

const slackTools: ToolInfo[] = [
  tool('post_message', 'Post a message to a channel. Needs a channel id.'),
  tool('create_issue_reminder', 'Remind a channel about an open issue'),
];

describe('search, describe and types commands', () => {
  const originalHome = process.env.HOME;
  let homeDir = '';
  let stdout: string[] = [];
  let stderr: string[] = [];

  async function registerServers(...names: string[]): Promise<void> {
    await mkdir(join(homeDir, '.mcpkit'), { recursive: true });
    const servers = Object.fromEntries(names.map((name) => [name, entry(name)]));
    await writeFile(join(homeDir, '.mcpkit', 'servers.yaml'), stringify({ version: 1, servers }), 'utf-8');
  }

  /** Registers servers that carry the given registry description; a value of undefined registers one without. */
  async function registerDescribed(descriptions: Record<string, string | undefined>): Promise<void> {
    await mkdir(join(homeDir, '.mcpkit'), { recursive: true });
    const servers = Object.fromEntries(Object.entries(descriptions).map(([name, description]) => [name, { ...entry(name), ...(description === undefined ? {} : { description }) }]));
    await writeFile(join(homeDir, '.mcpkit', 'servers.yaml'), stringify({ version: 1, servers }), 'utf-8');
  }

  async function run(command: Command, ...args: string[]): Promise<void> {
    await command.parseAsync(args, { from: 'user' });
  }

  beforeEach(async () => {
    homeDir = await mkdtemp(join(tmpdir(), 'mcpkit-discovery-'));
    process.env.HOME = homeDir;
    stdout = [];
    stderr = [];
    vi.spyOn(console, 'log').mockImplementation((...parts) => { stdout.push(parts.join(' ')); });
    vi.spyOn(console, 'error').mockImplementation((...parts) => { stderr.push(parts.join(' ')); });
    vi.mocked(discoverTools).mockResolvedValue({ tools: githubTools, serverMeta: {} });
  });

  afterEach(async () => {
    process.exitCode = undefined;
    if (originalHome === undefined) delete process.env.HOME;
    else process.env.HOME = originalHome;
    await rm(homeDir, { recursive: true, force: true });
    vi.restoreAllMocks();
    vi.clearAllMocks();
  });

  describe('search', () => {
    beforeEach(async () => {
      await registerServers('github', 'slack', 'uncached');
      await saveSchemaCache('github', githubTools);
      await saveSchemaCache('slack', slackTools);
    });

    it('ranks matches across servers as "server.tool - first sentence", best first', async () => {
      await run(createSearchCommand(), 'create', 'issue');
      expect(stdout).toEqual([
        'github.create_issue - Create a new issue in a repository.',
        'slack.create_issue_reminder - Remind a channel about an open issue',
        'github.close_issue - Close an issue',
        'github.update_issue - Update an issue',
        'github.list_issues - List the issues of a repository',
      ]);
      expect(process.exitCode).toBeUndefined();
    });

    it('puts an exact tool name first however it is written, and finds other forms of a word', async () => {
      for (const query of [['get_user'], ['getUser'], ['GET', 'USER'], ['github.get_user']]) {
        stdout = [];
        await run(createSearchCommand(), ...query);
        expect(stdout[0], query.join(' ')).toBe('github.get_user - Get a user profile');
      }
      stdout = [];
      await run(createSearchCommand(), 'merging');
      expect(stdout).toEqual(['github.merge_pull_request - Merge a pull request']);
    });

    it('prints nothing for one-letter and stop-word queries instead of every tool that has the letter', async () => {
      for (const query of ['a', 'to', 'the of']) {
        stdout = [];
        stderr = [];
        await run(createSearchCommand(), query);
        expect(stdout, query).toEqual([]);
        expect(stderr.join('\n')).toContain('No tools matched');
      }
    });

    describe('the same tool on several servers', () => {
      beforeEach(async () => {
        await registerServers('github', 'github-personal', 'slack');
        await saveSchemaCache('github-personal', githubTools);
      });

      it('lists it once, the tool first and every server named equally, with a line saying what each server is', async () => {
        await run(createSearchCommand(), 'merge', 'pull');
        expect(stdout).toEqual([
          'merge_pull_request on github, github-personal - Merge a pull request',
          '  same tool on 2 servers: github = (no description); github-personal = (no description)',
        ]);
      });

      it('lists every copy with --no-collapse, each as an ordinary server.tool line', async () => {
        await run(createSearchCommand(), 'merge', 'pull', '--no-collapse');
        expect(stdout).toEqual([
          'github.merge_pull_request - Merge a pull request',
          'github-personal.merge_pull_request - Merge a pull request',
        ]);
      });

      it('adds an alsoIn array and a servers array to the JSON of a collapsed hit and nothing to the others', async () => {
        await run(createSearchCommand(), 'reminder', '--json');
        expect(JSON.parse(stdout[0])).toEqual([
          { server: 'slack', tool: 'create_issue_reminder', score: expect.any(Number), summary: 'Remind a channel about an open issue' },
        ]);

        stdout = [];
        await run(createSearchCommand(), 'merge', '--json');
        expect(JSON.parse(stdout[0])).toEqual([
          {
            server: 'github',
            tool: 'merge_pull_request',
            score: expect.any(Number),
            summary: 'Merge a pull request',
            alsoIn: ['github-personal'],
            servers: [{ server: 'github' }, { server: 'github-personal' }],
          },
        ]);

        stdout = [];
        await run(createSearchCommand(), 'merge', '--json', '--no-collapse');
        expect(JSON.parse(stdout[0]).map((hit: Record<string, unknown>) => [hit.server, hit.alsoIn, hit.servers])).toEqual([
          ['github', undefined, undefined],
          ['github-personal', undefined, undefined],
        ]);
      });

      it('puts the server a qualified name asks for first, among all the servers', async () => {
        await run(createSearchCommand(), 'github-personal.merge_pull_request');
        expect(stdout).toEqual([
          'merge_pull_request on github-personal, github - Merge a pull request',
          '  same tool on 2 servers: github-personal = (no description); github = (no description)',
        ]);
      });
    });

    describe('the same tool on a work and a personal registration of one server', () => {
      const workText = 'Composio MCP (WORK — someone@work.com). Google Workspace: Slides, Sheets, Docs, Gmail. Tools: GMAIL_*.';
      const personalText = 'Composio MCP (PERSONAL Google account). Google Workspace: Slides, Sheets, Docs, Gmail. Tools: GMAIL_*.';
      const gmailProfile = tool('GMAIL_GET_PROFILE', 'Get the Gmail profile of the connected account. Needs no arguments.');

      beforeEach(async () => {
        await registerDescribed({ composio: workText, 'composio-personal': personalText, mailbox: undefined });
        await saveSchemaCache('composio', [gmailProfile]);
        await saveSchemaCache('composio-personal', [gmailProfile]);
        await saveSchemaCache('mailbox', [gmailProfile]);
      });

      it('makes the choice explicit: the tool first, both servers equal, each with the start of its description', async () => {
        await run(createSearchCommand(), 'GMAIL_GET_PROFILE', '--server', 'composio-personal');
        expect(stdout).toEqual(['composio-personal.GMAIL_GET_PROFILE - Get the Gmail profile of the connected account.']);

        stdout = [];
        await run(createSearchCommand(), 'gmail profile');
        expect(stdout).toEqual([
          'GMAIL_GET_PROFILE on composio, composio-personal, mailbox - Get the Gmail profile of the connected account.',
          '  same tool on 3 servers: composio = Composio MCP (WORK — someone@work.com). Google Workspace: Sl; '
            + 'composio-personal = Composio MCP (PERSONAL Google account). Google Workspace: Sl; mailbox = (no description)',
        ]);
        expect(stdout[0]).not.toMatch(/^composio\./);
      });

      it('lists all the servers in the JSON, the hit server first, with the description cut to 120 characters and omitted when there is none', async () => {
        await run(createSearchCommand(), 'gmail profile', '--json');
        const [result] = JSON.parse(stdout[0]) as Array<Record<string, unknown>>;
        expect(result).toEqual({
          server: 'composio',
          tool: 'GMAIL_GET_PROFILE',
          score: expect.any(Number),
          summary: 'Get the Gmail profile of the connected account.',
          alsoIn: ['composio-personal', 'mailbox'],
          servers: [
            { server: 'composio', description: workText },
            { server: 'composio-personal', description: personalText },
            { server: 'mailbox' },
          ],
        });
      });

      it('trims a long description to 120 characters in the JSON and escapes control characters in both outputs', async () => {
        await registerDescribed({ composio: `WORK ${'x'.repeat(200)}`, 'composio-personal': 'PERSONAL\u001b[2J\u0085end', mailbox: undefined });
        await run(createSearchCommand(), 'gmail profile', '--json');
        const servers = (JSON.parse(stdout[0]) as Array<{ servers: Array<{ server: string; description?: string }> }>)[0].servers;
        expect(servers[0].description).toHaveLength(120);
        expect(servers[0].description?.startsWith('WORK xxx')).toBe(true);
        expect(servers[1].description).toBe('PERSONAL\u001b[2J\u0085end');
        expect(stdout[0]).not.toMatch(/[\p{Cc}\p{Zl}\p{Zp}]/u);

        stdout = [];
        await run(createSearchCommand(), 'gmail profile');
        expect(stdout[1]).toContain('composio-personal = PERSONAL\\u001b[2J\\u0085end');
        for (const line of stdout) expect(line).not.toMatch(/[\p{Cc}\p{Zl}\p{Zp}]/u);
      });
    });

    it('reads only the caches, and says which registered servers it could not search', async () => {
      await run(createSearchCommand(), 'issue');
      expect(discoverTools).not.toHaveBeenCalled();
      expect(stderr.join('\n')).toContain('no schema cache: uncached');
      expect(stdout.join('\n')).not.toContain('uncached');
    });

    it('ignores caches of servers that are no longer registered', async () => {
      await saveSchemaCache('gone', [tool('issue_ghost', 'Ghost issue tool')]);
      await run(createSearchCommand(), 'issue');
      expect(stdout.join('\n')).not.toContain('gone');
    });

    it('applies --limit and prints JSON with --json', async () => {
      await run(createSearchCommand(), 'issue', '--limit', '2', '--json');
      expect(stderr.join('\n')).toContain('no schema cache');
      expect(stdout).toHaveLength(1);
      const results = JSON.parse(stdout[0]) as Array<Record<string, unknown>>;
      expect(results).toHaveLength(2);
      expect(results[0]).toEqual({ server: 'github', tool: 'create_issue', score: expect.any(Number), summary: 'Create a new issue in a repository.' });
    });

    it('prints nothing on stdout and exits 0 when nothing matches', async () => {
      await run(createSearchCommand(), 'zzzqqq');
      expect(stdout).toEqual([]);
      expect(stderr.join('\n')).toContain('No tools matched');
      expect(process.exitCode).toBeUndefined();

      stdout = [];
      await run(createSearchCommand(), 'zzzqqq', '--json');
      expect(stdout).toEqual(['[]']);
    });

    it('with --server fetches and caches the tools of a server without a cache', async () => {
      vi.mocked(discoverTools).mockResolvedValue({ tools: githubTools, serverMeta: {} });
      await run(createSearchCommand(), 'merge', '--server', 'uncached');
      expect(discoverTools).toHaveBeenCalledTimes(1);
      expect(stdout).toEqual(['uncached.merge_pull_request - Merge a pull request']);
      expect((await loadSchemaCache('uncached'))?.tools).toHaveLength(githubTools.length);

      stdout = [];
      await run(createSearchCommand(), 'merge', '--server', 'uncached');
      expect(discoverTools).toHaveBeenCalledTimes(1);
      expect(stdout).toHaveLength(1);
    });

    it('fails with exit code 1 and nearest names for an unknown --server, leaving stdout empty', async () => {
      await run(createSearchCommand(), 'issue', '--server', 'githb');
      expect(stdout).toEqual([]);
      expect(stderr.join('\n')).toContain('Server "githb" not found');
      expect(stderr.join('\n')).toContain('github');
      expect(process.exitCode).toBe(1);
    });

    it('reports a failed live fetch on stderr with exit code 1', async () => {
      vi.mocked(discoverTools).mockRejectedValue(new Error('connection refused'));
      await run(createSearchCommand(), 'issue', '--server', 'uncached');
      expect(stdout).toEqual([]);
      expect(stderr.join('\n')).toContain('connection refused');
      expect(process.exitCode).toBe(1);
    });

    it('rejects a --limit that is not a positive integer', async () => {
      const command = createSearchCommand().exitOverride().configureOutput({ writeErr: () => {}, writeOut: () => {} });
      await expect(run(command, 'issue', '--limit', '0')).rejects.toMatchObject({ code: 'commander.invalidArgument' });
      await expect(run(createSearchCommand().exitOverride().configureOutput({ writeErr: () => {} }), 'issue', '--limit', 'abc'))
        .rejects.toMatchObject({ code: 'commander.invalidArgument' });
    });
  });

  describe('describe', () => {
    beforeEach(async () => {
      await registerServers('github', 'uncached');
      await saveSchemaCache('github', githubTools);
    });

    it('prints description, parameters, output schema, labelled annotations and a ready example', async () => {
      await run(createDescribeCommand(), 'github', 'create_issue');
      expect(stdout).toHaveLength(1);
      const text = stdout[0];
      expect(text.startsWith('github.create_issue\nTitle: Create issue\n')).toBe(true);
      expect(text).toContain('Create a new issue in a repository. Supports labels.');
      expect(text).toContain('Parameters (JSON Schema):');
      expect(text).toContain(JSON.stringify(githubTools[0].inputSchema, null, 2));
      expect(text).toContain(`Output schema:\n${JSON.stringify(githubTools[0].outputSchema, null, 2)}`);
      expect(text).toContain('Annotations (server-declared, untrusted):\n  readOnlyHint: false\n  destructiveHint: false');
      expect(text).toContain(`Example:\n  mcpkit call github create_issue '{"owner":"<owner>","repo":"<repo>","title":"<title>","state":"open"}'`);
      expect(process.exitCode).toBeUndefined();
    });

    it('says when the output schema and annotations are not declared', async () => {
      await run(createDescribeCommand(), 'github', 'close_issue');
      expect(stdout[0]).toContain('Output schema:\nnot declared');
      expect(stdout[0]).toContain('Annotations (server-declared, untrusted):\n  none declared');
      expect(stdout[0]).toContain(`mcpkit call github close_issue '{}'`);
    });

    it('prints a machine-readable object with --json', async () => {
      await run(createDescribeCommand(), 'github', 'create_issue', '--json');
      expect(JSON.parse(stdout[0])).toEqual({
        server: 'github',
        tool: 'create_issue',
        title: 'Create issue',
        description: githubTools[0].description,
        inputSchema: githubTools[0].inputSchema,
        outputSchema: githubTools[0].outputSchema,
        annotations: githubTools[0].annotations,
        example: `mcpkit call github create_issue '{"owner":"<owner>","repo":"<repo>","title":"<title>","state":"open"}'`,
      });
    });

    describe('a long output schema', () => {
      /** A schema that pretty-prints to `lines` lines: an enum of `lines - 4` members. */
      const schemaOfLines = (lines: number): Record<string, unknown> => ({ enum: Array.from({ length: lines - 4 }, (_, index) => `v${index}`) });
      const printed = (schema: Record<string, unknown>): string[] => JSON.stringify(schema, null, 2).split('\n');

      async function describeWith(outputSchema: Record<string, unknown>, ...flags: string[]): Promise<string> {
        const tools = [tool('big_output', 'Returns a lot', { outputSchema, annotations: { readOnlyHint: true } })];
        await saveSchemaCache('github', tools);
        stdout = [];
        await run(createDescribeCommand(), 'github', 'big_output', ...flags);
        return stdout[0];
      }

      it('prints the first 60 lines of it and says how many more there are in text mode', async () => {
        const schema = schemaOfLines(160);
        expect(printed(schema)).toHaveLength(160);
        const text = await describeWith(schema);
        const block = /Output schema:\n([\s\S]*?)\n\nAnnotations/.exec(text)?.[1].split('\n') ?? [];
        expect(block).toHaveLength(61);
        expect(block.slice(0, 60)).toEqual(printed(schema).slice(0, 60));
        expect(block[60]).toBe('... 100 more lines; use --json for the full output schema');
        expect(text).toContain('Annotations (server-declared, untrusted):\n  readOnlyHint: true');
        expect(text).toContain("Example:\n  mcpkit call github big_output '{}'");
      });

      it('prints a schema of exactly 60 lines whole and cuts one of 61 lines with a singular "1 more line"', async () => {
        const sixty = schemaOfLines(60);
        const whole = await describeWith(sixty);
        expect(whole).toContain(`Output schema:\n${JSON.stringify(sixty, null, 2)}\n\nAnnotations`);
        expect(whole).not.toContain('more line');

        const cut = await describeWith(schemaOfLines(61));
        expect(cut).toContain(`${printed(schemaOfLines(61)).slice(0, 60).join('\n')}\n... 1 more line; use --json for the full output schema\n\nAnnotations`);
      });

      it('leaves --json whole, and a long input schema whole in text mode', async () => {
        const schema = schemaOfLines(160);
        expect(JSON.parse(await describeWith(schema, '--json')).outputSchema).toEqual(schema);

        const tools = [tool('big_input', 'Takes a lot', { inputSchema: schemaOfLines(160) })];
        await saveSchemaCache('github', tools);
        stdout = [];
        await run(createDescribeCommand(), 'github', 'big_input');
        expect(stdout[0]).toContain(`Parameters (JSON Schema):\n${JSON.stringify(schemaOfLines(160), null, 2)}\n\nOutput schema:`);
        expect(stdout[0]).not.toContain('more line');
      });
    });

    it('suggests the five nearest names for an unknown tool and exits 1', async () => {
      await run(createDescribeCommand(), 'github', 'creat_issu');
      expect(stdout).toEqual([]);
      const message = stderr.join('\n');
      expect(message).toContain('Tool "creat_issu" not found on server "github"');
      const nearest = /Nearest: ([^.]+)\./.exec(message)?.[1].split(', ') ?? [];
      expect(nearest).toHaveLength(5);
      expect(nearest[0]).toBe('create_issue');
      expect(process.exitCode).toBe(1);
    });

    it('exits 1 for an unknown server', async () => {
      await run(createDescribeCommand(), 'nope', 'create_issue');
      expect(stdout).toEqual([]);
      expect(stderr.join('\n')).toContain('Server "nope" not found');
      expect(process.exitCode).toBe(1);
    });

    it('fetches and caches the tools of a server that has no cache yet', async () => {
      await run(createDescribeCommand(), 'uncached', 'get_user');
      expect(discoverTools).toHaveBeenCalledTimes(1);
      expect(stdout[0]).toContain('uncached.get_user');
      expect(await readFile(schemaCachePath('uncached'), 'utf-8')).toContain('"get_user"');
    });
  });

  describe('types', () => {
    beforeEach(async () => {
      await registerServers('github', 'slack');
      await saveSchemaCache('github', githubTools);
      await saveSchemaCache('slack', slackTools);
    });

    it('prints the declarations of the named server to stdout only', async () => {
      await run(createTypesCommand(), 'github');
      expect(stdout).toEqual([generateMcpTypes([{ server: 'github', tools: githubTools }]).trimEnd()]);
      expect(stderr).toEqual([]);
      expect(stdout[0]).toContain('declare const mcp: {');
      expect(stdout[0]).toContain('create_issue(args: {');
      expect(stdout[0]).not.toContain('post_message');
    });

    it('covers every cached server when none is named, and de-duplicates repeated names', async () => {
      await run(createTypesCommand());
      expect(stdout[0]).toContain('  github: {');
      expect(stdout[0]).toContain('  slack: {');
      expect(discoverTools).not.toHaveBeenCalled();
      expect(stderr).toEqual([]);

      stdout = [];
      await run(createTypesCommand(), 'slack', 'slack');
      expect(stdout[0].match(/slack: \{/g)).toHaveLength(1);
    });

    it('never connects to a registered server without a schema cache when none is named, and says so', async () => {
      await registerServers('github', 'slack', 'uncached', 'also-uncached');
      await run(createTypesCommand());
      expect(discoverTools).not.toHaveBeenCalled();
      expect(stdout[0]).toContain('  github: {');
      expect(stdout[0]).toContain('  slack: {');
      expect(stdout[0]).not.toContain('uncached');
      expect(stderr).toHaveLength(1);
      expect(stderr[0]).toBe('Not included, no schema cache: uncached, also-uncached. Run `mcpkit update <server>` or name the server explicitly.');
      expect(process.exitCode).toBeUndefined();
    });

    it('ignores caches of servers that are no longer registered', async () => {
      await saveSchemaCache('gone', [tool('ghost_tool', 'Ghost')]);
      await run(createTypesCommand());
      expect(stdout[0]).not.toContain('gone');
      expect(stdout[0]).not.toContain('ghost_tool');
    });

    it('exits 1 saying what to run when servers are registered but none has a cache, without connecting', async () => {
      await registerServers('uncached');
      await run(createTypesCommand());
      expect(discoverTools).not.toHaveBeenCalled();
      expect(stdout).toEqual([]);
      expect(stderr.join('\n')).toContain('No server has a schema cache. Run `mcpkit update <server>`');
      expect(process.exitCode).toBe(1);
    });

    it('fetches and caches a server named on the command line that has no cache', async () => {
      await registerServers('github', 'uncached');
      await run(createTypesCommand(), 'uncached');
      expect(discoverTools).toHaveBeenCalledTimes(1);
      expect(stdout[0]).toContain('  uncached: {');
      expect(stdout[0]).toContain('get_user(');
      expect((await loadSchemaCache('uncached'))?.tools).toHaveLength(githubTools.length);
      expect(process.exitCode).toBeUndefined();
    });

    it('filters with --tools, comma separated and repeated, and drops servers left without tools', async () => {
      await run(createTypesCommand(), '--tools', 'create_issue,get_user', '--tools', 'post_message');
      expect(stdout[0]).toContain('create_issue(');
      expect(stdout[0]).toContain('get_user(');
      expect(stdout[0]).toContain('post_message(');
      expect(stdout[0]).not.toContain('list_issues(');

      stdout = [];
      await run(createTypesCommand(), '--tools', 'post_message');
      expect(stdout[0]).not.toContain('github');
    });

    it('fails with exit code 1 for an unknown tool, printing nothing on stdout', async () => {
      await run(createTypesCommand(), 'github', '--tools', 'create_issue,nope_tool');
      expect(stdout).toEqual([]);
      expect(stderr.join('\n')).toContain('Tool "nope_tool" not found');
      expect(process.exitCode).toBe(1);
    });

    it('fails with exit code 1 for an unknown server', async () => {
      await run(createTypesCommand(), 'github', 'nope');
      expect(stdout).toEqual([]);
      expect(stderr.join('\n')).toContain('Server "nope" not found');
      expect(process.exitCode).toBe(1);
    });

    it('writes to a file with --out and keeps stdout empty', async () => {
      const out = join(homeDir, 'mcp.d.ts');
      await run(createTypesCommand(), 'slack', '--out', out);
      expect(stdout).toEqual([]);
      expect(await readFile(out, 'utf-8')).toBe(generateMcpTypes([{ server: 'slack', tools: slackTools }]));
      expect(stderr.join('\n')).toContain('Wrote 2 tool declarations for 1 server(s)');
      expect(process.exitCode).toBeUndefined();
    });

    it('exits 1 when a server named on the command line cannot be loaded', async () => {
      await registerServers('github', 'slack', 'down');
      vi.mocked(discoverTools).mockRejectedValue(new Error('server is down'));
      await run(createTypesCommand(), 'github', 'down');
      expect(stdout).toEqual([]);
      expect(stderr.join('\n')).toContain('Could not load the tools of "down": server is down');
      expect(process.exitCode).toBe(1);
    });

    it('fails when no server is registered', async () => {
      await registerServers();
      await run(createTypesCommand());
      expect(discoverTools).not.toHaveBeenCalled();
      expect(stdout).toEqual([]);
      expect(stderr.join('\n')).toContain('No servers registered');
      expect(process.exitCode).toBe(1);
    });
  });

  describe('names that are not registered servers', () => {
    beforeEach(async () => {
      await registerServers('github');
      await saveSchemaCache('github', githubTools);
    });

    // Plain objects inherit these keys, so `servers[name]` would find a function or Object.prototype.
    const inherited = ['constructor', 'toString', '__proto__', 'hasOwnProperty', 'valueOf'];

    async function expectUnknownServer(name: string): Promise<void> {
      expect(stdout).toEqual([]);
      expect(stderr.join('\n')).toContain(`Server "${name}" not found`);
      expect(stderr.join('\n')).not.toMatch(/TypeError|Cannot read|is not a function|Could not load/);
      expect(discoverTools).not.toHaveBeenCalled();
      expect(process.exitCode).toBe(1);
    }

    it.each(inherited)('describe reports "%s" as an unknown server', async (name) => {
      await run(createDescribeCommand(), name, 'create_issue');
      await expectUnknownServer(name);
    });

    it.each(inherited)('types reports "%s" as an unknown server', async (name) => {
      await run(createTypesCommand(), name);
      await expectUnknownServer(name);
    });

    it('types reports an inherited name among valid ones as unknown, and prints nothing', async () => {
      await run(createTypesCommand(), 'github', 'constructor');
      await expectUnknownServer('constructor');
    });

    it.each(inherited)('search --server reports "%s" as an unknown server', async (name) => {
      await run(createSearchCommand(), 'issue', '--server', name);
      await expectUnknownServer(name);
    });
  });

  describe('names with control characters', () => {
    // A server name is checked when the registry loads, so the hostile text lives in tool names, titles and descriptions.
    const hostileServer = 'srv';
    const hostileTool = 'x\r\n## Injected\u001b[2J';
    const hostileTools: ToolInfo[] = [
      tool(hostileTool, 'Does a thing.\n\n## Injected\nMore text.', {
        title: 'Title\n## Injected',
        inputSchema: { type: 'object', properties: { 'p\n## Injected': { type: 'string' } }, required: ['p\n## Injected'] },
        annotations: { 'k\n## Injected': true } as ToolInfo['annotations'],
      }),
    ];
    const lineBreaks = /\r\n|[\n\r\p{Zl}\p{Zp}\u0085]/u;

    function everyLineIsClean(lines: string[]): void {
      for (const line of lines) {
        expect(line.split(lineBreaks).filter((part) => /^\s*#{1,6}\s*Injected/.test(part))).toEqual([]);
        expect(line).not.toContain('\u001b');
      }
    }

    beforeEach(async () => {
      await registerServers(hostileServer);
      await saveSchemaCache(hostileServer, hostileTools);
    });

    it('search prints one escaped line per hit and keeps the real names in --json', async () => {
      await run(createSearchCommand(), 'does', 'thing');
      expect(stdout).toEqual(['srv.x\\r\\n## Injected\\u001b[2J - Does a thing.']);

      stdout = [];
      await run(createSearchCommand(), 'does', 'thing', '--json');
      expect(JSON.parse(stdout[0])).toEqual([expect.objectContaining({ server: hostileServer, tool: hostileTool })]);
    });

    it('describe escapes the header, title, annotation names and the example, and keeps the description as written', async () => {
      await run(createDescribeCommand(), hostileServer, hostileTool);
      expect(process.exitCode).toBeUndefined();
      const lines = stdout[0].split('\n');
      expect(lines[0]).toBe('srv.x\\r\\n## Injected\\u001b[2J');
      expect(lines[1]).toBe('Title: Title\\n## Injected');
      expect(lines).toContain('  k\\n## Injected: true');
      expect(lines.find((line) => line.startsWith('  mcpkit call '))).toContain(`mcpkit call srv $'x\\r\\n## Injected\\x1b[2J'`);
      // The description is free text: its own line breaks are kept (and none of the escaped fields add any).
      expect(lines).toContain('Does a thing.');
      expect(lines.filter((line) => /^\s*#{1,6}\s*Injected/.test(line))).toEqual(['## Injected']);
    });

    it('describe --json keeps the real names', async () => {
      await run(createDescribeCommand(), hostileServer, hostileTool, '--json');
      expect(JSON.parse(stdout[0])).toMatchObject({ server: hostileServer, tool: hostileTool });
    });

    it('error messages escape the names they quote', async () => {
      await run(createDescribeCommand(), hostileServer, 'x\n## Injected');
      expect(process.exitCode).toBe(1);
      everyLineIsClean(stderr);
      expect(stderr.join('\n')).toContain('Tool "x\\n## Injected" not found on server "srv".');
      expect(stderr.join('\n')).toContain('Nearest: x\\r\\n## Injected\\u001b[2J.');

      stderr = [];
      await run(createDescribeCommand(), 'y\n## Injected', 'z');
      everyLineIsClean(stderr);
      expect(stderr.join('\n')).toContain('Server "y\\n## Injected" not found.');
      expect(stderr.join('\n')).toContain('Nearest: srv.');
    });

    it('types declares such names as quoted, escaped keys', async () => {
      await run(createTypesCommand(), hostileServer);
      everyLineIsClean(stdout);
      expect(stdout[0]).toContain('srv: {');
      expect(stdout[0]).toContain('"x\\r\\n## Injected\\u001b[2J"(args: {');
      expect(stdout[0]).toContain('"p\\n## Injected": string');
    });
  });

  describe('a registry entry whose server name is invalid', () => {
    // The name is not a name at all: a newline and a heading, an escape sequence, NEL and DEL.
    const badName = 'bad\n# Injected\u001b[2J\u0085\u007f';
    let warnings: string[] = [];

    /** Nothing the bad name carries reaches the terminal as itself: no line break before its heading, no escape sequence, no NEL or DEL. */
    function expectNothingRaw(...streams: string[][]): void {
      for (const line of streams.flat()) {
        expect(line).not.toContain('\n# Injected');
        expect(line).not.toContain('\u001b[2J');
        expect(line).not.toMatch(/[\u0085\u007f]/);
      }
    }

    beforeEach(async () => {
      warnings = [];
      vi.spyOn(console, 'warn').mockImplementation((...parts) => { warnings.push(parts.join(' ')); });
      await registerServers('srv', badName);
      await saveSchemaCache('srv', [tool('do_thing', 'Does a thing.')]);
      await saveSchemaCache(badName, [tool('evil_tool', 'Does a thing too.')]);
    });

    it('search skips it with one escaped warning and never lists its tools, even when a cache for it exists', async () => {
      await run(createSearchCommand(), 'does', 'thing');
      expect(stdout).toEqual(['srv.do_thing - Does a thing.']);
      expect(warnings).toHaveLength(1);
      expect(warnings[0]).toContain('skipping server "bad\\n# Injected\\u001b[2J');
      expect(warnings[0]).toContain('left unchanged in servers.yaml');
      expectNothingRaw(stdout, stderr, warnings);

      stdout = [];
      await run(createSearchCommand(), 'does', 'thing', '--json');
      expect(JSON.parse(stdout[0]).map((hit: { server: string }) => hit.server)).toEqual(['srv']);
      expectNothingRaw(stdout, stderr, warnings);
    });

    it('search --server treats it as an unknown server, and quotes its name escaped', async () => {
      await run(createSearchCommand(), 'does', '--server', badName);
      expect(process.exitCode).toBe(1);
      expect(stdout).toEqual([]);
      expect(stderr.join('\n')).toContain('Server "bad\\n# Injected\\u001b[2J');
      expect(stderr.join('\n')).toContain('Nearest: srv.');
      expectNothingRaw(stdout, stderr, warnings);
    });

    it('describe skips it, describes the valid server as usual and reports the bad name as unknown, escaped', async () => {
      await run(createDescribeCommand(), 'srv', 'do_thing');
      expect(process.exitCode).toBeUndefined();
      expect(stdout[0].split('\n')[0]).toBe('srv.do_thing');
      expect(warnings).toHaveLength(1);

      stdout = [];
      await run(createDescribeCommand(), badName, 'evil_tool');
      expect(process.exitCode).toBe(1);
      expect(stdout).toEqual([]);
      expect(stderr.join('\n')).toContain('Server "bad\\n# Injected\\u001b[2J');
      expectNothingRaw(stdout, stderr, warnings);
    });

    it('types declares only the valid servers, and refuses the bad name as unknown', async () => {
      await run(createTypesCommand());
      expect(process.exitCode).toBeUndefined();
      expect(stdout[0]).toContain('srv: {');
      expect(stdout[0]).not.toContain('evil_tool');
      expect(stdout[0]).not.toContain('Injected');
      expect(warnings).toHaveLength(1);

      stdout = [];
      await run(createTypesCommand(), badName);
      expect(process.exitCode).toBe(1);
      expect(stdout).toEqual([]);
      expectNothingRaw(stdout, stderr, warnings);
    });

    it('leaves the entry in servers.yaml untouched', async () => {
      const before = await readFile(join(homeDir, '.mcpkit', 'servers.yaml'), 'utf-8');
      await run(createSearchCommand(), 'does', 'thing');
      await run(createDescribeCommand(), 'srv', 'do_thing');
      await run(createTypesCommand());
      expect(await readFile(join(homeDir, '.mcpkit', 'servers.yaml'), 'utf-8')).toBe(before);
      expect(before).toContain('Injected');
    });
  });

  describe('search output for hostile tool and description text on a valid server', () => {
    const hostileTool = 'x\r\n## Injected\u001b[2J';
    const nel = '\u0085';
    const lineSep = String.fromCharCode(0x2028);
    const anyLineBreak = /[\n\r\v\f\u001c-\u001e\u0085\u2028\u2029]/;

    beforeEach(async () => {
      await registerServers('srv');
      await saveSchemaCache('srv', [
        tool(hostileTool, 'Does a thing.\n\n## Injected\nMore text.'),
        tool(`do${nel}it`, `Does${lineSep}a thing here.`),
      ]);
    });

    it('prints one escaped line per hit', async () => {
      await run(createSearchCommand(), 'does', 'thing');
      expect(stdout).toHaveLength(2);
      expect(stdout).toContain('srv.x\\r\\n## Injected\\u001b[2J - Does a thing.');
      for (const line of stdout) {
        expect(line).not.toMatch(anyLineBreak);
        expect(line).not.toContain('\u001b');
      }
    });

    it('keeps the real names in --json, on one line with no raw separator', async () => {
      await run(createSearchCommand(), 'does', 'thing', '--json');
      expect(stdout).toHaveLength(1);
      expect(stdout[0]).not.toMatch(anyLineBreak);
      expect(JSON.parse(stdout[0]).map((hit: { tool: string }) => hit.tool).sort()).toEqual([`do${nel}it`, hostileTool].sort());
    });
  });

  describe('--json output with Unicode line separators', () => {
    const nel = '\u0085';
    const lineSep = String.fromCharCode(0x2028);
    const paraSep = String.fromCharCode(0x2029);
    const separatorTool = `do${nel}it`;
    const separatorServer = 'srv';
    const separatorTools: ToolInfo[] = [
      tool(separatorTool, `Does${lineSep}a thing${paraSep}here${nel}now.`, {
        title: `Ti${paraSep}tle`,
        inputSchema: { type: 'object', properties: { [`p${lineSep}q`]: { type: 'string', description: `d${nel}e` } }, required: [`p${lineSep}q`] },
        annotations: { title: `a${lineSep}b`, readOnlyHint: true },
      }),
    ];
    // What Python's str.splitlines() and most line readers treat as a line break.
    const anyLineBreak = /[\n\r\v\f\u001c-\u001e\u0085\u2028\u2029]/;

    beforeEach(async () => {
      await registerServers(separatorServer);
      await saveSchemaCache(separatorServer, separatorTools);
    });

    it('search --json is one line with no raw separator, and parses back to the real values', async () => {
      await run(createSearchCommand(), 'does', 'thing', '--json');
      expect(stdout).toHaveLength(1);
      expect(stdout[0]).not.toMatch(anyLineBreak);
      expect(JSON.parse(stdout[0])).toEqual([
        { server: separatorServer, tool: separatorTool, score: expect.any(Number), summary: expect.any(String) },
      ]);
    });

    it('describe --json is one line with no raw separator, and parses back to the real values', async () => {
      await run(createDescribeCommand(), separatorServer, separatorTool, '--json');
      expect(stdout).toHaveLength(1);
      expect(stdout[0]).not.toMatch(anyLineBreak);
      expect(JSON.parse(stdout[0])).toMatchObject({
        server: separatorServer,
        tool: separatorTool,
        title: `Ti${paraSep}tle`,
        description: `Does${lineSep}a thing${paraSep}here${nel}now.`,
        inputSchema: separatorTools[0].inputSchema,
        annotations: { title: `a${lineSep}b`, readOnlyHint: true },
      });
    });
  });
});
