import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { buildSkillContent } from './generators/index.js';
import type { GeneratorContext, ToolInfo } from './types.js';

const REQUIRES_ID = { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] };

function tool(name: string, extra: Partial<ToolInfo> = {}): ToolInfo {
  return { name, description: `Does ${name}.`, inputSchema: REQUIRES_ID, ...extra };
}

function context(tools: ToolInfo[], extra: Partial<GeneratorContext> = {}): GeneratorContext {
  return { serverName: 'demo', tools, transport: { type: 'stdio', command: 'node', args: [] }, scope: 'global', ...extra };
}

/** The command inside the "Example:" fence, which both formats print once. */
function exampleCall(content: string): string {
  const lines = content.split('\n');
  const at = lines.indexOf('Example:');
  expect(at, 'an Example: block').toBeGreaterThanOrEqual(0);
  expect(lines[at + 1]).toBe('```bash');
  return lines[at + 2];
}

function frontmatterDescription(content: string): string {
  const frontmatter = parse(/^---\n([\s\S]*?)\n---/.exec(content)?.[1] ?? '') as { description: string };
  return frontmatter.description;
}

const FORMATS = ['full', 'compact'] as const;

describe.each(FORMATS)('example tool choice (%s format)', (format) => {
  const build = (tools: ToolInfo[]) => buildSkillContent(context(tools), { format });

  it('prefers a read-only tool over an earlier write tool', () => {
    const content = build([
      tool('add_label', { annotations: { readOnlyHint: false, destructiveHint: true } }),
      tool('get_label', { annotations: { readOnlyHint: true } }),
    ]);
    expect(exampleCall(content)).toContain(' get_label ');
    expect(exampleCall(content)).not.toContain('add_label');
  });

  it('takes the first read-only tool when several are marked', () => {
    const content = build([
      tool('add_label'),
      tool('get_label', { annotations: { readOnlyHint: true } }),
      tool('list_labels', { annotations: { readOnlyHint: true } }),
    ]);
    expect(exampleCall(content)).toContain(' get_label ');
  });

  it('keeps the first tool with required parameters when no tool carries a hint', () => {
    const content = build([tool('add_label'), tool('get_label')]);
    expect(exampleCall(content)).toContain(' add_label ');
  });

  it('keeps the first tool when every tool is a write', () => {
    const content = build([
      tool('add_label', { annotations: { readOnlyHint: false } }),
      tool('remove_label', { annotations: { readOnlyHint: false, destructiveHint: true } }),
    ]);
    expect(exampleCall(content)).toContain(' add_label ');
  });

  it('only trusts a hint that is exactly true', () => {
    const lax = { readOnlyHint: 'true' } as unknown as ToolInfo['annotations'];
    const content = build([tool('add_label'), tool('get_label', { annotations: lax })]);
    expect(exampleCall(content)).toContain(' add_label ');
  });

  it('keeps the eligibility rule: a read-only tool without required parameters is not an example', () => {
    const content = build([
      tool('add_label'),
      tool('list_labels', { annotations: { readOnlyHint: true }, inputSchema: { type: 'object', properties: {} } }),
    ]);
    expect(exampleCall(content)).toContain(' add_label ');
  });

  it('prints no example when no tool has required parameters', () => {
    const content = build([tool('list_labels', { annotations: { readOnlyHint: true }, inputSchema: { type: 'object' } })]);
    expect(content).not.toContain('Example:');
  });
});

describe('example tool choice on a large server', () => {
  it('does not show the first of many write tools when read-only ones exist', () => {
    const tools = [
      ...Array.from({ length: 30 }, (_, i) => tool(`write_${i}`, { annotations: { readOnlyHint: false } })),
      tool('fetch_thing', { annotations: { readOnlyHint: true } }),
    ];
    // 31 tools: the auto format is the compact one
    expect(exampleCall(buildSkillContent(context(tools)))).toContain(' fetch_thing ');
  });
});

describe('frontmatter description names the registered server', () => {
  const bare = { type: 'object' };
  const lookup = [
    tool('get_contact_details', { description: 'Get all details of a contact', inputSchema: bare }),
    tool('current_datetime', { description: 'Get current date and time for timezone', inputSchema: bare }),
    tool('add_contact', { description: 'Add contact to list', inputSchema: bare }),
  ];
  const CAPABILITIES = 'get all details of a contact, get current date and time for timezone, add contact to list';

  describe.each(FORMATS)('%s format', (format) => {
    const build = (extra: Partial<GeneratorContext>) =>
      frontmatterDescription(buildSkillContent(context(lookup, extra), { format }));

    it('adds the registered name on the tool-derived path when the server calls itself something else', () => {
      const description = build({ serverName: 'mailmodo', serverMeta: { name: 'Demo' } });
      expect(description).toContain('mailmodo');
      expect(description.startsWith('Demo tools')).toBe(true);
      expect(description).toContain('via mcpkit');
      expect(description).toContain(CAPABILITIES);
    });

    it('adds the registered name on the instructions path', () => {
      const description = build({ serverName: 'mailmodo', serverMeta: { name: 'Demo', instructions: 'Email marketing contacts and lists.' } });
      expect(description).toContain('Demo');
      expect(description).toContain('mailmodo');
      expect(description).toContain('Email marketing contacts and lists.');
    });

    it('adds the registered name on the npm package description path', () => {
      const description = build({ serverName: 'mailmodo', serverMeta: { name: 'Demo', packageDescription: 'MCP server for contact tools' } });
      expect(description).toContain('MCP server for contact tools');
      expect(description).toContain('mailmodo');
    });

    it('matches the registered name case-insensitively and leaves the text alone when it is there', () => {
      const description = build({ serverName: 'reddit', serverMeta: { name: 'Reddit-MCP-Buddy', instructions: 'Browse posts.' } });
      expect(description).toBe('Reddit-MCP-Buddy via mcpkit — Browse posts.');
    });

    it('leaves the tool-derived description byte-identical when the registered name is already in the server name', () => {
      expect(build({ serverName: 'reddit', serverMeta: { name: 'reddit-mcp-buddy' } }))
        .toBe(`Reddit-mcp-buddy tools via mcpkit — ${CAPABILITIES}. Use this when you need to work with reddit-mcp-buddy.`);
    });

    it('leaves the no-metadata description byte-identical (the registered name is the domain)', () => {
      expect(build({ serverName: 'mailmodo' }))
        .toBe(`Mailmodo tools via mcpkit — ${CAPABILITIES}. Use this when you need to work with mailmodo.`);
    });

    it('does not count the name as present when it is only part of another word', () => {
      const description = build({ serverName: 'git', serverMeta: { name: 'Digital', instructions: 'Digital things.' } });
      expect(description).toContain('(git)');
    });

    it('leaves a user-provided description exactly as given', () => {
      expect(build({ serverName: 'mailmodo', serverMeta: { name: 'Demo' }, description: 'Send newsletters' })).toBe('Send newsletters');
    });

    it('does not add the name again when the server reports none and the name is already the domain', () => {
      const description = build({ serverName: 'mailmodo' });
      expect(description.match(/mailmodo/gi)).toHaveLength(2);
      expect(description).not.toContain('(mailmodo)');
    });

    it('keeps the name inside the length limit even when the instructions are long', () => {
      const description = build({ serverName: 'mailmodo', serverMeta: { name: 'Demo', instructions: 'x'.repeat(1200) } });
      expect(description.length).toBeLessThanOrEqual(401);
      expect(description).toContain('mailmodo');
    });

    it('keeps the name when the instructions mention it only beyond the length limit', () => {
      const description = build({ serverName: 'mailmodo', serverMeta: { name: 'Demo', instructions: `${'x '.repeat(300)}mailmodo` } });
      expect(description.length).toBeLessThanOrEqual(401);
      expect(description).toContain('mailmodo');
    });

    it('leads with the name when a verbose package description pushes the tag past the length limit', () => {
      const description = build({ serverName: 'mailmodo', serverMeta: { name: 'Demo', packageDescription: 'word '.repeat(100).trim() } });
      expect(description.startsWith('mailmodo: ')).toBe(true);
      expect(description.length).toBeLessThanOrEqual(401);
    });

    it.each([
      'we"ird: name # {x}',
      "it's [odd] | > *name",
      'back\\slash',
      'two\nlines',
    ])('keeps the frontmatter a valid YAML string for the name %j', (name) => {
      const content = buildSkillContent(context(lookup, { serverName: name, serverMeta: { name: 'Demo' } }), { format });
      const flat = name.replace(/\s+/g, ' ');
      expect(frontmatterDescription(content)).toContain(flat);
      expect(content.split('\n').filter((line) => line.startsWith('description:'))).toHaveLength(1);
    });
  });
});
