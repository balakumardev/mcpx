import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { COMPACT_TOOL_THRESHOLD, SCRIPTING_BLOCK, buildSkillContent } from './generators/index.js';
import type { GeneratorContext, ToolInfo } from './types.js';

const SECTION_5 = [
  '## Scripting several calls',
  '',
  'If you have a code-execution tool (for example Claude Code with Code Mode), script the calls: each `mcpkit call <server> <tool> \'<json>\' --json` is an ordinary Bash call, so your permission rules and hooks still apply per call. Otherwise batch them with `mcpkit exec --allow-read-only script.js`: the script is the body of an async function and calls `mcp["<server>"].<tool>({...})`; `mcpkit types <server>` prints the typed API. Writes need `--allow <server>.<tool>`; `--allow-writes` allows everything.',
].join('\n');

function simpleTools(count: number): ToolInfo[] {
  return Array.from({ length: count }, (_, i) => ({
    name: `tool_${i}`,
    description: `Does thing number ${i}. Extra detail that only the full format repeats.`,
    inputSchema: { type: 'object', properties: { id: { type: 'string', description: 'Identifier' } }, required: ['id'] },
  }));
}

function context(tools: ToolInfo[], extra: Partial<GeneratorContext> = {}): GeneratorContext {
  return { serverName: 'demo', tools, transport: { type: 'stdio', command: 'node', args: [] }, scope: 'global', ...extra };
}

/** Sixty tools shaped like a real API server: long descriptions, described parameters, enums and arrays. */
function realisticTools(count = 60): ToolInfo[] {
  const resources = ['issue', 'pull_request', 'repository', 'branch', 'release', 'workflow', 'comment', 'label', 'milestone', 'user'];
  const verbs = ['create', 'get', 'list', 'update', 'delete', 'search'];
  const tools: ToolInfo[] = [];
  for (const resource of resources) {
    for (const verb of verbs) {
      if (tools.length === count) return tools;
      const noun = resource.replace('_', ' ');
      tools.push({
        name: `${verb}_${resource}`,
        description: `${verb[0].toUpperCase()}${verb.slice(1)} a ${noun} in a repository. This operation talks to the hosting API on behalf of the authenticated user, honours the rate limits of the account and returns the ${noun} as JSON. Use it when the task names a specific ${noun}; for bulk work prefer the list and search tools.`,
        inputSchema: {
          type: 'object',
          properties: {
            owner: { type: 'string', description: 'Account name of the repository owner, for example an organisation or a user' },
            repo: { type: 'string', description: 'Repository name without the owner prefix' },
            [`${resource}_id`]: { type: 'integer', description: `Numeric identifier of the ${noun}` },
            title: { type: 'string', description: `Short summary shown in the ${noun} list` },
            body: { type: 'string', description: 'Markdown body, up to 65536 characters' },
            state: { type: 'string', enum: ['open', 'closed', 'all'], description: 'Filter or set the lifecycle state' },
            labels: { type: 'array', items: { type: 'string' }, description: 'Label names to attach' },
            page: { type: 'integer', description: 'Page number for paginated results, starting at 1' },
          },
          required: ['owner', 'repo'],
        },
      });
    }
  }
  return tools;
}

function frontmatter(content: string): Record<string, unknown> {
  return parse(/^---\n([\s\S]*?)\n---/.exec(content)?.[1] ?? '') as Record<string, unknown>;
}

describe('skill format selection', () => {
  it('uses the full format up to the threshold and the compact format above it', () => {
    expect(COMPACT_TOOL_THRESHOLD).toBe(15);
    const atThreshold = buildSkillContent(context(simpleTools(15)));
    expect(atThreshold).toContain('## When to Use');
    expect(atThreshold).toContain('**Parameters:**');
    expect(atThreshold).not.toContain('## Tools (');

    const above = buildSkillContent(context(simpleTools(16)));
    expect(above).toContain('## Tools (16)');
    expect(above).not.toContain('## When to Use');
    expect(above).not.toContain('**Parameters:**');
  });

  it('honours an explicit format over the tool count', () => {
    expect(buildSkillContent(context(simpleTools(40)), { format: 'full' })).toContain('**Parameters:**');
    expect(buildSkillContent(context(simpleTools(2)), { format: 'compact' })).toContain('## Tools (2)');
    expect(buildSkillContent(context(simpleTools(40)), { format: 'auto' })).toContain('## Tools (40)');
    expect(buildSkillContent(context(simpleTools(40)))).toBe(buildSkillContent(context(simpleTools(40)), { format: 'compact' }));
  });
});

describe('compact skill content', () => {
  const tools = [
    { name: 'create_issue', description: 'Create a new issue. Supports labels, assignees and milestones.', inputSchema: { type: 'object', properties: { title: { type: 'string' }, count: { type: 'integer' } }, required: ['title', 'count'] } },
    { name: 'no_description', description: '', inputSchema: { type: 'object' } },
    { name: 'long_one', description: `${'Very long sentence '.repeat(20)}ends here.`, inputSchema: { type: 'object' } },
    ...simpleTools(14),
  ];
  const content = buildSkillContent(context(tools, { description: 'Issue tracker tools' }));

  it('keeps the frontmatter, the native-tools warning and the call syntax', () => {
    expect(content.startsWith('---\nname: mcpkit-demo\ndescription: "Issue tracker tools"\n---\n')).toBe(true);
    expect(content).toContain('# demo (MCP Server)');
    expect(content).toContain('NOT native MCP tools');
    expect(content).toContain('mcp__demo__*');
    expect(content).toContain(`mcpkit call demo <tool_name> '<json_params>'`);
  });

  it('shows a ready example built from the first tool with required parameters', () => {
    expect(content).toContain(`mcpkit call demo create_issue '{"title":"<title>","count":0}'`);
  });

  it('documents discovery and scripting, with the scripting block word for word', () => {
    expect(SCRIPTING_BLOCK).toBe(SECTION_5);
    expect(content).toContain(SECTION_5);
    expect(content).toContain('mcpkit search <keywords> --server demo');
    expect(content).toContain('mcpkit describe demo <tool_name>');
    expect(content).toContain('mcpkit types demo');
  });

  it('lists one line per tool with the first sentence only, capped at 140 characters', () => {
    const lines = content.split('\n').filter((line) => line.startsWith('- `'));
    expect(lines).toHaveLength(tools.length);
    expect(lines).toContain('- `create_issue` - Create a new issue.');
    expect(lines).toContain('- `no_description`');
    const long = lines.find((line) => line.startsWith('- `long_one`')) ?? '';
    expect(long.slice('- `long_one` - '.length).length).toBeLessThanOrEqual(140);
    expect(long.endsWith('…')).toBe(true);
    expect(content).not.toContain('Supports labels');
  });

  it('has no parameter tables and never repeats a description', () => {
    expect(content).not.toContain('| Param |');
    expect(content).not.toContain('**Usage:**');
    expect(content.split('Does thing number 3.')).toHaveLength(2);
  });

  it('mentions a param provider and an enabled persistent runtime in one line each', () => {
    const withExtras = buildSkillContent(context(tools, {
      paramProvider: { command: 'token-helper' },
      runtime: { mode: 'persistent', idleTimeoutSec: 900, callTimeoutSec: 3600 },
    }));
    expect(withExtras).toContain('token-helper');
    expect(withExtras).toContain('persistent background daemon (idle timeout 15m, call timeout 1h)');
    expect(withExtras).toContain('mcpkit runtime stop demo');
    expect(content).not.toContain('persistent background daemon');
  });
});

describe('full skill content', () => {
  it('also carries the scripting block, placed before the tool list', () => {
    const content = buildSkillContent(context(simpleTools(2)));
    expect(content).toContain(SECTION_5);
    expect(content.indexOf(SECTION_5)).toBeLessThan(content.indexOf('## Tools'));
  });
});

describe('the read-only line of the scripting section', () => {
  const noHints = (server: string): string =>
    `This server declares no read-only hints, so --allow-read-only allows nothing here: allow tools one by one, for example --allow ${server}.<tool>.`;
  const someHints = (declared: number, total: number, server: string): string =>
    `${declared} of ${total} tools declare readOnlyHint (--allow-read-only covers only those); allow the others with --allow ${server}.<tool>.`;
  const everyHint = (total: number): string => `${total} of ${total} tools declare readOnlyHint (--allow-read-only covers only those).`;

  /** `count` simple tools of which the first `hinted` declare readOnlyHint true, the next one declares false. */
  function hinted(count: number, hintedCount: number): ToolInfo[] {
    return simpleTools(count).map((tool, index) => {
      if (index < hintedCount) return { ...tool, annotations: { readOnlyHint: true } };
      if (index === hintedCount) return { ...tool, annotations: { readOnlyHint: false, destructiveHint: true } };
      return tool;
    });
  }

  describe.each([['full', 8], ['compact', 30]] as const)('%s format', (format, count) => {
    const build = (tools: ToolInfo[], extra: Partial<GeneratorContext> = {}): string => buildSkillContent(context(tools, extra), { format });

    it('says that --allow-read-only allows nothing when no tool declares readOnlyHint, even when some declare false', () => {
      expect(build(simpleTools(count))).toContain(noHints('demo'));
      expect(build(hinted(count, 0))).toContain(noHints('demo'));
      expect(build(hinted(count, 0))).not.toContain('declare readOnlyHint');
    });

    it('counts the tools that declare readOnlyHint true, out of all of them', () => {
      expect(build(hinted(count, 3))).toContain(someHints(3, count, 'demo'));
      expect(build(hinted(count, 3))).not.toContain('declares no read-only hints');
      expect(build(hinted(count, 1))).toContain(someHints(1, count, 'demo'));
    });

    it('leaves out "the others" when every tool declares it', () => {
      const content = build(hinted(count, count));
      expect(content).toContain(everyHint(count));
      expect(content).not.toContain('allow the others');
      expect(content).not.toContain('declares no read-only hints');
    });

    it('is one line right after the scripting block, before the tools, and appears once', () => {
      const content = build(hinted(count, 2));
      expect(content).toContain(`${SECTION_5}\n\n${someHints(2, count, 'demo')}\n`);
      expect(content.split('declare readOnlyHint')).toHaveLength(2);
      expect(content.indexOf(someHints(2, count, 'demo'))).toBeLessThan(content.indexOf('## Tools'));
    });

    it('uses the registered server name, shell-quoted, and keeps hostile names on one line', () => {
      expect(build(simpleTools(count), { serverName: 'my server' })).toContain(noHints("'my server'"));
      expect(build(hinted(count, 2), { serverName: "it's" })).toContain(someHints(2, count, `'it'\\''s'`));
      const hostile = build(simpleTools(count), { serverName: 'srv\n## Injected' });
      expect(hostile).toContain(noHints("$'srv\\n## Injected'"));
      expect(hostile.split('\n').filter((line) => /^#{1,6}\s*Injected/.test(line))).toEqual([]);
    });

    it('reads a server with no tools as one that declares no hints', () => {
      expect(build([])).toContain(noHints('demo'));
    });
  });

  it('is the same in the formats auto picks from the tool count', () => {
    expect(buildSkillContent(context(hinted(15, 4)))).toContain(someHints(4, 15, 'demo'));
    expect(buildSkillContent(context(hinted(16, 4)))).toContain(someHints(4, 16, 'demo'));
  });
});

describe('the search hint above the compact tool list', () => {
  const hint = (server: string): string => `Not sure which tool you need? mcpkit search <words> --server ${server} ranks this server's tools (the list below is only names).`;

  it('sits on its own line immediately above the Tools heading', () => {
    const content = buildSkillContent(context(simpleTools(20)), { format: 'compact' });
    expect(content).toContain(`${hint('demo')}\n\n## Tools (20)\n`);
    expect(content.split('Not sure which tool you need?')).toHaveLength(2);
  });

  it('comes after the daemon line and names the registered server, shell-quoted', () => {
    const content = buildSkillContent(context(simpleTools(20), {
      serverName: 'my server',
      runtime: { mode: 'persistent', idleTimeoutSec: 900, callTimeoutSec: 3600 },
    }), { format: 'compact' });
    expect(content).toContain(`${hint("'my server'")}\n\n## Tools (20)\n`);
    expect(content.indexOf('persistent background daemon')).toBeLessThan(content.indexOf('Not sure which tool you need?'));
  });

  it('is not in the full format, which already lists every parameter', () => {
    expect(buildSkillContent(context(simpleTools(5)), { format: 'full' })).not.toContain('Not sure which tool you need?');
  });

  it('together with the read-only line adds under 400 bytes to a compact skill', () => {
    const added = [hint('demo'), 'This server declares no read-only hints, so --allow-read-only allows nothing here: allow tools one by one, for example --allow demo.<tool>.'];
    expect(added.reduce((sum, line) => sum + Buffer.byteLength(`${line}\n\n`), 0)).toBeLessThan(400);
    const content = buildSkillContent(context(simpleTools(20)), { format: 'compact' });
    for (const line of added) expect(content).toContain(line);
  });
});

describe('compact size on a realistic server', () => {
  it('is under a quarter of the full format for sixty tools', () => {
    const tools = realisticTools(60);
    expect(tools).toHaveLength(60);
    const full = Buffer.byteLength(buildSkillContent(context(tools), { format: 'full' }));
    const compact = Buffer.byteLength(buildSkillContent(context(tools), { format: 'compact' }));
    expect(compact).toBeLessThan(full * 0.25);
  });
});

describe('frontmatter description quoting', () => {
  const awkward = [
    'He said "hello"',
    'back\\slash and \\n literal',
    'two\nlines: with colon # and hash',
    "single 'quotes' and: [brackets] {braces} - dash",
    'tab\there, nbsp , nel\u0085, line sep  para sep , del\u007f, nul-free control\u0001',
    '> folded or | literal start',
    '*alias &anchor !tag @at `tick',
  ];

  it.each(awkward)('round-trips %j through the YAML parser in both formats', (description) => {
    for (const format of ['full', 'compact'] as const) {
      const content = buildSkillContent(context(simpleTools(2), { description }), { format });
      expect(frontmatter(content).description, format).toBe(description);
      expect(frontmatter(content).name).toBe('mcpkit-demo');
    }
  });

  it('keeps the plain one-line quoted form for ordinary text', () => {
    const content = buildSkillContent(context(simpleTools(2), { description: 'Plain text — with a dash' }));
    expect(content.split('\n').find((line) => line.startsWith('description:'))).toBe('description: "Plain text — with a dash"');
  });
});

describe('names with control characters', () => {
  // Each of these must stay inside one line: a heading or a fence on a new line would be read as structure.
  const separators: Array<[string, string]> = [
    ['LF', '\n'],
    ['CR', '\r'],
    ['CRLF', '\r\n'],
    ['line separator', String.fromCharCode(0x2028)],
    ['paragraph separator', String.fromCharCode(0x2029)],
    ['NEL', '\u0085'],
    ['VT', '\u000b'],
    ['FF', '\u000c'],
  ];
  const lineBreaks = /\r\n|[\n\r\p{Zl}\p{Zp}\u0085\u000b\u000c]/u;
  // Only the line feed that joins the generated lines may remain in the output.
  const strayControl = /[\u0000-\u0009\u000b-\u001f\u007f-\u009f\p{Zl}\p{Zp}]/u;

  function injectedLines(content: string): string[] {
    return content.split(lineBreaks).filter((line) => /^\s*#{1,6}\s*Injected/.test(line));
  }

  function hostileContext(separator: string): GeneratorContext {
    return context([{
      name: `x${separator}## Injected`,
      description: 'Does a thing.',
      inputSchema: { type: 'object', properties: { [`p${separator}## Injected`]: { type: 'string' } }, required: [`p${separator}## Injected`] },
    }], {
      serverName: `srv${separator}# Injected`,
      serverMeta: { name: `Meta${separator}# Injected` },
    });
  }

  describe.each(['full', 'compact'] as const)('%s format', (format) => {
    it.each(separators)('never starts a line from a name containing a %s', (_label, separator) => {
      const content = buildSkillContent(hostileContext(separator), { format });
      expect(injectedLines(content)).toEqual([]);
      expect(content).not.toMatch(strayControl);
    });

    it('keeps the tool, server and property names readable as escapes', () => {
      const content = buildSkillContent(hostileContext('\n'), { format });
      expect(content).toContain('x\\n## Injected');
      expect(content).toContain('srv\\n# Injected');
      expect(content).toContain('Meta\\n# Injected');
    });

    it('keeps the frontmatter a single name line that parses back to the real server name', () => {
      const content = buildSkillContent(hostileContext('\n'), { format });
      expect(frontmatter(content).name).toBe('mcpkit-srv\n# Injected');
      expect(content.split('\n').filter((line) => line.startsWith('name:'))).toHaveLength(1);
    });

    it('leaves ordinary names untouched', () => {
      const content = buildSkillContent(context([{
        name: 'create-issue.v2',
        description: 'Create an issue.',
        inputSchema: { type: 'object', properties: { 'repo/name': { type: 'string' } }, required: ['repo/name'] },
      }], { serverName: 'my-server_1.0', serverMeta: { name: 'My Server ✓' } }), { format });
      expect(content).toContain('name: mcpkit-my-server_1.0\n');
      expect(content).toContain('# My Server ✓ (MCP Server)');
      expect(content).toContain('create-issue.v2');
      expect(content).toContain('"repo/name"');
    });
  });
});
