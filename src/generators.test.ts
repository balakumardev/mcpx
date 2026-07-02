import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { GeneratorContext } from './types.js';

const existsSync = vi.fn<(path: string) => boolean>();
const homedir = vi.fn<() => string>();

vi.mock('node:fs', async () => {
  const actual = await vi.importActual<typeof import('node:fs')>('node:fs');
  return {
    ...actual,
    existsSync,
  };
});

vi.mock('node:os', async () => {
  const actual = await vi.importActual<typeof import('node:os')>('node:os');
  return {
    ...actual,
    homedir,
  };
});

describe('generators', () => {
  const ctx: GeneratorContext = {
    serverName: 'github',
    tools: [],
    transport: { type: 'stdio', command: 'npx', args: [] },
    scope: 'global',
  };

  beforeEach(() => {
    vi.clearAllMocks();
    homedir.mockReturnValue('/tmp/home');
    existsSync.mockReturnValue(false);
    delete process.env.HERMES_HOME;
  });

  it('detects OpenClaw when ~/.openclaw exists', async () => {
    const { detectAgents } = await import('./generators/index.js');
    existsSync.mockImplementation((path) => path === '/tmp/home/.openclaw');

    expect(detectAgents()).toEqual(['openclaw']);
  });

  it('generates OpenClaw global skills in ~/.openclaw/skills', async () => {
    const { getGenerator } = await import('./generators/index.js');
    const generate = await getGenerator('openclaw');

    expect(generate(ctx).filePath).toBe('/tmp/home/.openclaw/skills/mcpkit-github/SKILL.md');
  });

  it('generates OpenClaw project skills in workspace skills/', async () => {
    const { getGenerator } = await import('./generators/index.js');
    const generate = await getGenerator('openclaw');

    expect(generate({ ...ctx, scope: 'project' }).filePath)
      .toBe(`${process.cwd()}/skills/mcpkit-github/SKILL.md`);
  });

  it('detects Hermes when ~/.hermes exists', async () => {
    const { detectAgents } = await import('./generators/index.js');
    existsSync.mockImplementation((path) => path === '/tmp/home/.hermes');

    expect(detectAgents()).toEqual(['hermes']);
  });

  it('detects Hermes via the HERMES_HOME override', async () => {
    const { detectAgents } = await import('./generators/index.js');
    process.env.HERMES_HOME = '/custom/hermes';
    existsSync.mockImplementation((path) => path === '/custom/hermes');

    expect(detectAgents()).toEqual(['hermes']);
  });

  it('generates Hermes global skills in ~/.hermes/skills', async () => {
    const { getGenerator } = await import('./generators/index.js');
    const generate = await getGenerator('hermes');

    expect(generate(ctx).filePath).toBe('/tmp/home/.hermes/skills/mcpkit-github/SKILL.md');
  });

  it('honors HERMES_HOME for global Hermes skills', async () => {
    const { getGenerator } = await import('./generators/index.js');
    process.env.HERMES_HOME = '/custom/hermes';
    const generate = await getGenerator('hermes');

    expect(generate(ctx).filePath).toBe('/custom/hermes/skills/mcpkit-github/SKILL.md');
  });

  it('generates Hermes project skills in workspace .hermes/skills', async () => {
    const { getGenerator } = await import('./generators/index.js');
    const generate = await getGenerator('hermes');

    expect(generate({ ...ctx, scope: 'project' }).filePath)
      .toBe(`${process.cwd()}/.hermes/skills/mcpkit-github/SKILL.md`);
  });

  it('includes mcpkit usage guidance in generated skill content', async () => {
    const { buildSkillContent } = await import('./generators/index.js');

    const content = buildSkillContent({
      ...ctx,
      tools: [
        {
          name: 'browser_snapshot',
          description: 'Capture accessibility snapshot of the current page',
          inputSchema: { type: 'object', properties: {} },
        },
      ],
    });

    expect(content).toContain('## How to Use mcpkit');
    expect(content).toContain('mcpkit list github');
    expect(content).toContain('mcpkit view github');
    // Without runtime config, should show "available" (not enabled) for stdio
    expect(content).toContain('### Persistent runtime (available)');
    expect(content).toContain('mcpkit edit github --runtime persistent');
  });

  it('shows persistent runtime as enabled when runtime config is provided', async () => {
    const { buildSkillContent } = await import('./generators/index.js');

    const content = buildSkillContent({
      ...ctx,
      runtime: { mode: 'persistent', idleTimeoutSec: 900, callTimeoutSec: 3600 },
      tools: [
        {
          name: 'browser_snapshot',
          description: 'Capture accessibility snapshot',
          inputSchema: { type: 'object', properties: {} },
        },
      ],
    });

    expect(content).toContain('### Persistent runtime (enabled)');
    expect(content).toContain('persistent background daemon');
    expect(content).toContain('Idle timeout: **15m**');
    expect(content).toContain('Call timeout: **1h**');
    expect(content).toContain('mcpkit runtime status github');
    expect(content).toContain('mcpkit runtime stop github');
    // Should NOT show the "enable" command when already enabled
    expect(content).not.toContain('### Persistent runtime (available)');
  });

  it('shows param provider info when configured', async () => {
    const { buildSkillContent } = await import('./generators/index.js');

    const content = buildSkillContent({
      ...ctx,
      paramProvider: { command: 'eiamcli iamticket' },
      tools: [
        {
          name: 'search',
          description: 'Search for things',
          inputSchema: { type: 'object', properties: {} },
        },
      ],
    });

    expect(content).toContain('### Auto-injected parameters');
    expect(content).toContain('eiamcli iamticket');
    expect(content).toContain('do **not** need to pass these params manually');
  });

  it('generates concrete example params for tools with required fields', async () => {
    const { buildSkillContent } = await import('./generators/index.js');

    const content = buildSkillContent({
      ...ctx,
      tools: [
        {
          name: 'navigate',
          description: 'Navigate to a URL',
          inputSchema: {
            type: 'object',
            properties: {
              url: { type: 'string', description: 'Target URL' },
              timeout: { type: 'number', description: 'Timeout in ms' },
            },
            required: ['url'],
          },
        },
      ],
    });

    // Tool usage example should show real params
    expect(content).toContain(`mcpkit call github navigate '{"url": "<url>"}'`);
    // Should not show empty '{}' for tools with required params
    expect(content).not.toContain(`mcpkit call github navigate '{}'`);
  });

  it('samples across the whole tool list for multi-domain servers (not just alphabetical head)', async () => {
    const { buildSkillContent } = await import('./generators/index.js');

    // Model a real aggregator (like DAST): several domains, none dominant (>40%).
    // Alphabetically-early "add_*" tools must not crowd out later domains.
    const mk = (name: string) => ({ name, description: `${name.replace(/_/g, ' ')} action`, inputSchema: { type: 'object', properties: {} } });
    const tools = [
      ...Array.from({ length: 6 }, (_, i) => mk(`add_item_${i}`)),
      ...Array.from({ length: 8 }, (_, i) => mk(`experiment_op_${i}`)),
      ...Array.from({ length: 7 }, (_, i) => mk(`metric_op_${i}`)),
      ...Array.from({ length: 6 }, (_, i) => mk(`route_op_${i}`)),
      ...Array.from({ length: 5 }, (_, i) => mk(`schema_op_${i}`)),
    ];

    const content = buildSkillContent({
      serverName: 'agg',
      tools,
      transport: { type: 'stdio', command: 'npx', args: [] },
      scope: 'global',
    });

    const descLine = content.split('\n').find(l => l.startsWith('description:')) || '';
    // Breadth signal: later domains must surface, not only alphabetically-first "add".
    expect(descLine).toMatch(/experiment|metric|route|schema/);
    // "Use this for tasks involving <domains>" clause lists multiple prefixes.
    expect(content).toContain('Use this for tasks involving');
  });

  it('ignores proxy/bridge package descriptions and leads with tool signal', async () => {
    const { buildSkillContent } = await import('./generators/index.js');

    const mk = (name: string) => ({ name, description: `${name.replace(/_/g, ' ')} action`, inputSchema: { type: 'object', properties: {} } });
    const content = buildSkillContent({
      serverName: 'dast-orch',
      // mcp-remote-style package metadata: describes the shim, not the tools.
      serverMeta: { name: 'mcp-orchestrator', packageDescription: 'Remote proxy for Model Context Protocol, allowing local-only clients to connect to remote servers' },
      tools: [
        ...Array.from({ length: 6 }, (_, i) => mk(`experiment_op_${i}`)),
        ...Array.from({ length: 6 }, (_, i) => mk(`metric_op_${i}`)),
        ...Array.from({ length: 5 }, (_, i) => mk(`schema_op_${i}`)),
      ],
      transport: { type: 'stdio', command: 'npx', args: [] },
      scope: 'global',
    });

    const descLine = content.split('\n').find(l => l.startsWith('description:')) || '';
    // Should NOT lead with the proxy boilerplate…
    expect(descLine).not.toMatch(/^description:\s*"Remote proxy/);
    // …and SHOULD carry the real domains.
    expect(descLine).toMatch(/experiment|metric|schema/);
  });

  it('clamps overly long frontmatter descriptions', async () => {    const { buildSkillContent } = await import('./generators/index.js');

    const content = buildSkillContent({
      serverName: 'verbose',
      serverMeta: { name: 'verbose', instructions: 'x'.repeat(1200) },
      tools: [{ name: 'a_do', description: 'Do a thing', inputSchema: { type: 'object', properties: {} } }],
      transport: { type: 'stdio', command: 'npx', args: [] },
      scope: 'global',
    });

    const descLine = content.split('\n').find(l => l.startsWith('description:')) || '';
    // description: "<...>"  — content between quotes should be clamped (<= ~400 + ellipsis)
    const inner = descLine.replace(/^description:\s*"/, '').replace(/"$/, '');
    expect(inner.length).toBeLessThanOrEqual(402);
    expect(inner.endsWith('…')).toBe(true);
  });
});

