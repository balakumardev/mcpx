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
});
