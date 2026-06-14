import { beforeEach, describe, expect, it, vi } from 'vitest';

const writeSkillFile = vi.fn<(filePath: string, content: string) => Promise<void>>();
const homedir = vi.fn<() => string>();

vi.mock('./skill-file.js', () => ({
  writeSkillFile,
  removeSkillDirectory: vi.fn(),
}));

vi.mock('node:os', async () => {
  const actual = await vi.importActual<typeof import('node:os')>('node:os');
  return {
    ...actual,
    homedir,
  };
});

describe('meta-skill', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    homedir.mockReturnValue('/tmp/home');
    writeSkillFile.mockResolvedValue();
    delete process.env.HERMES_HOME;
  });

  it('documents the key mcpkit CLI workflows', async () => {
    const { buildMetaSkillContent } = await import('./meta-skill.js');
    const content = buildMetaSkillContent();

    expect(content).toContain('name: mcpkit-cli');
    expect(content).toContain('## Add / install a new MCP server');
    expect(content).toContain('mcpkit install');
    expect(content).toContain('mcpkit call <server> <tool>');
    expect(content).toContain('--chain');
    expect(content).toContain('## Persistent runtime mode');
    expect(content).toContain('--runtime persistent');
    expect(content).toContain('mcpkit runtime status');
    expect(content).toContain('mcpkit runtime stop');
    expect(content).toContain('mcpkit edit');
    expect(content).toContain('mcpkit sync');
    // Lists hermes among the supported agents
    expect(content).toContain('hermes');
  });

  it('writes the meta-skill to each target agent skill directory', async () => {
    const { writeMetaSkill } = await import('./meta-skill.js');
    await writeMetaSkill({ agents: ['claude-code', 'hermes'], scope: 'global' });

    const paths = writeSkillFile.mock.calls.map(([filePath]) => filePath);
    expect(paths).toContain('/tmp/home/.claude/skills/mcpkit-cli/SKILL.md');
    expect(paths).toContain('/tmp/home/.hermes/skills/mcpkit-cli/SKILL.md');
    // Content is the authored meta-skill, not per-server tool boilerplate
    expect(writeSkillFile.mock.calls[0][1]).toContain('name: mcpkit-cli');
  });

  it('does not write anything in dry-run mode', async () => {
    const { writeMetaSkill } = await import('./meta-skill.js');
    await writeMetaSkill({ agents: ['claude-code'], scope: 'global', dryRun: true });

    expect(writeSkillFile).not.toHaveBeenCalled();
  });

  it('dedupes repeated agents', async () => {
    const { writeMetaSkill } = await import('./meta-skill.js');
    await writeMetaSkill({ agents: ['claude-code', 'claude-code'], scope: 'global' });

    expect(writeSkillFile).toHaveBeenCalledTimes(1);
  });

  it('is a no-op when no agents are given', async () => {
    const { writeMetaSkill } = await import('./meta-skill.js');
    await writeMetaSkill({ agents: [], scope: 'global' });

    expect(writeSkillFile).not.toHaveBeenCalled();
  });
});
