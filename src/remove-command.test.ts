import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createRemoveCommand } from './commands/remove.js';
import { createAgentSettings } from './agent-config.js';
import { addServer, getServer, removeServer } from './config.js';
import { getGenerator } from './generators/index.js';
import { stopRuntime } from './runtime-manager.js';
import { removeSkillDirectory } from './skill-file.js';
import { loadAgentSettings } from './agent-config.js';
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

vi.mock('./runtime-manager.js', () => ({
  stopRuntime: vi.fn(),
}));

vi.mock('./agent-config.js', async () => {
  const actual = await vi.importActual<typeof import('./agent-config.js')>('./agent-config.js');
  return {
    ...actual,
    loadAgentSettings: vi.fn(),
  };
});

describe('createRemoveCommand', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('converts defaults-managed servers to explicit when removing one agent', async () => {
    const entry: ServerEntry = {
      name: 'github',
      transport: { type: 'stdio', command: 'npx', args: [] },
      toolCount: 5,
      agents: ['claude-code', 'cursor'],
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

    const command = createRemoveCommand();
    await command.parseAsync(['github', '--agent', 'cursor'], { from: 'user' });

    expect(removeSkillDirectory).toHaveBeenCalledWith('/tmp/github/cursor/SKILL.md');
    expect(addServer).toHaveBeenCalledWith(expect.objectContaining({
      name: 'github',
      agents: ['claude-code'],
      agentSelectionMode: 'explicit',
    }));
    expect(removeServer).not.toHaveBeenCalled();
    expect(stopRuntime).not.toHaveBeenCalled();
  });

  it('stops the runtime before removing the server from the registry', async () => {
    const entry: ServerEntry = {
      name: 'browsermcp',
      transport: { type: 'stdio', command: 'npx', args: [] },
      runtime: { mode: 'persistent', idleTimeoutSec: 900 },
      toolCount: 5,
      agents: ['cursor'],
      agentSelectionMode: 'explicit',
      createdAt: '2026-03-24T00:00:00.000Z',
      updatedAt: '2026-03-24T00:00:00.000Z',
    };

    vi.mocked(getServer).mockResolvedValue(structuredClone(entry));
    vi.mocked(loadAgentSettings).mockResolvedValue(createAgentSettings(['cursor']));
    vi.mocked(getGenerator).mockImplementation(async (agent) => {
      return (ctx) => ({
        agent,
        scope: ctx.scope,
        filePath: `/tmp/${ctx.serverName}/${agent}/SKILL.md`,
        content: '',
        isAppend: false,
      } satisfies GeneratedSkill);
    });

    const command = createRemoveCommand();
    await command.parseAsync(['browsermcp'], { from: 'user' });

    expect(stopRuntime).toHaveBeenCalledWith('browsermcp', { removeLog: true });
    expect(removeServer).toHaveBeenCalledWith('browsermcp');
  });
});
