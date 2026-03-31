import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createEditCommand } from './commands/edit.js';
import { createAgentSettings, loadAgentSettings } from './agent-config.js';
import { addServer, getServer, removeServer } from './config.js';
import { getGenerator } from './generators/index.js';
import { removeSkillDirectory } from './skill-file.js';
import type { GeneratedSkill, ServerEntry } from './types.js';

vi.mock('./config.js', () => ({
  addServer: vi.fn(),
  getServer: vi.fn(),
  removeServer: vi.fn(),
}));

vi.mock('./generators/index.js', () => ({
  getGenerator: vi.fn(),
}));

vi.mock('./skill-file.js', () => ({
  removeSkillDirectory: vi.fn(),
}));

vi.mock('./agent-config.js', async () => {
  const actual = await vi.importActual<typeof import('./agent-config.js')>('./agent-config.js');
  return {
    ...actual,
    loadAgentSettings: vi.fn(),
  };
});

describe('createEditCommand', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('seeds --add-agent from resolved defaults before switching to explicit', async () => {
    const entry: ServerEntry = {
      name: 'github',
      transport: { type: 'stdio', command: 'npx', args: [] },
      toolCount: 5,
      agents: ['cursor'],
      agentSelectionMode: 'defaults',
      createdAt: '2026-03-24T00:00:00.000Z',
      updatedAt: '2026-03-24T00:00:00.000Z',
    };

    vi.mocked(getServer).mockResolvedValue(structuredClone(entry));
    vi.mocked(loadAgentSettings).mockResolvedValue(createAgentSettings(['claude-code']));

    const command = createEditCommand();
    await command.parseAsync(['github', '--add-agent', 'codex'], { from: 'user' });

    expect(addServer).toHaveBeenCalledWith(expect.objectContaining({
      name: 'github',
      agents: ['claude-code', 'codex'],
      agentSelectionMode: 'explicit',
    }));
    expect(removeSkillDirectory).not.toHaveBeenCalled();
    expect(removeServer).not.toHaveBeenCalled();
  });

  it('removes skill files before saving explicit agent changes', async () => {
    const entry: ServerEntry = {
      name: 'github',
      transport: { type: 'stdio', command: 'npx', args: [] },
      toolCount: 5,
      agents: ['cursor'],
      agentSelectionMode: 'defaults',
      createdAt: '2026-03-24T00:00:00.000Z',
      updatedAt: '2026-03-24T00:00:00.000Z',
    };

    vi.mocked(getServer).mockResolvedValue(structuredClone(entry));
    vi.mocked(loadAgentSettings).mockResolvedValue(createAgentSettings(['claude-code', 'cursor']));
    vi.mocked(getGenerator).mockImplementation(async (agent) => {
      return (ctx) => ({
        agent,
        scope: ctx.scope,
        filePath: `/tmp/${ctx.serverName}/${agent}/SKILL.md`,
        content: '',
        isAppend: false,
      } satisfies GeneratedSkill);
    });

    const command = createEditCommand();
    await command.parseAsync(['github', '--remove-agent', 'cursor'], { from: 'user' });

    expect(getGenerator).toHaveBeenCalledWith('cursor');
    expect(removeSkillDirectory).toHaveBeenCalledWith('/tmp/github/cursor/SKILL.md');
    expect(addServer).toHaveBeenCalledWith(expect.objectContaining({
      name: 'github',
      agents: ['claude-code'],
      agentSelectionMode: 'explicit',
    }));

    const [removeOrder] = vi.mocked(removeSkillDirectory).mock.invocationCallOrder;
    const [saveOrder] = vi.mocked(addServer).mock.invocationCallOrder;
    expect(removeOrder).toBeLessThan(saveOrder);
  });
});
