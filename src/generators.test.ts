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
});
