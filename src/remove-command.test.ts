import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createRemoveCommand } from './commands/remove.js';
import { createAgentSettings } from './agent-config.js';
import { getServer, removeServer, updateServer } from './config.js';
import { getGenerator } from './generators/index.js';
import { stopRuntime } from './runtime-manager.js';
import { removeSchemaCache } from './schema-store.js';
import { removeSkillDirectory } from './skill-file.js';
import { loadAgentSettings } from './agent-config.js';
import type { GeneratedSkill, ServerEntry } from './types.js';

vi.mock('./config.js', () => ({
  updateServer: vi.fn(),
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

vi.mock('./schema-store.js', () => ({
  removeSchemaCache: vi.fn(),
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
    // Only the agent fields are patched onto the stored entry, so concurrent edits survive.
    expect(updateServer).toHaveBeenCalledWith('github', expect.any(Function));
    const stored = { ...structuredClone(entry), transport: { type: 'stdio' as const, command: 'edited-meanwhile', args: [] } };
    vi.mocked(updateServer).mock.calls[0][1](stored);
    expect(stored).toMatchObject({
      name: 'github',
      agents: ['claude-code'],
      agentSelectionMode: 'explicit',
      transport: { command: 'edited-meanwhile' },
    });
    expect(removeServer).not.toHaveBeenCalled();
    expect(stopRuntime).not.toHaveBeenCalled();
    expect(removeSchemaCache).not.toHaveBeenCalled();
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
    expect(removeSchemaCache).toHaveBeenCalledWith('browsermcp');
  });

  it('removes the schema cache when the last agent is removed', async () => {
    const entry: ServerEntry = {
      name: 'solo',
      transport: { type: 'stdio', command: 'npx', args: [] },
      toolCount: 2,
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

    await createRemoveCommand().parseAsync(['solo', '--agent', 'cursor'], { from: 'user' });

    expect(removeServer).toHaveBeenCalledWith('solo');
    expect(removeSchemaCache).toHaveBeenCalledWith('solo');
  });

  it('does not fail the removal when the schema cache cannot be deleted', async () => {
    const entry: ServerEntry = {
      name: 'stuck',
      transport: { type: 'stdio', command: 'npx', args: [] },
      toolCount: 2,
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
    vi.mocked(removeSchemaCache).mockRejectedValueOnce(new Error('EACCES'));
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never);
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    await createRemoveCommand().parseAsync(['stuck'], { from: 'user' });

    expect(removeServer).toHaveBeenCalledWith('stuck');
    expect(exitSpy).not.toHaveBeenCalled();
    expect(errorSpy).toHaveBeenCalledTimes(1);
    expect(String(errorSpy.mock.calls[0][0])).toContain('could not remove the tool schema cache');
    exitSpy.mockRestore();
    errorSpy.mockRestore();
  });
});
