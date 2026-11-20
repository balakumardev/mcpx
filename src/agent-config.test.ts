import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  createAgentSettings,
  entryServesAgent,
  getAgentSettingsPath,
  loadAgentSettings,
  parseAgentSelectionInput,
  resolveInstallAgentSelection,
  resolveServerAgents,
  saveAgentSettings,
} from './agent-config.js';
import { ALL_AGENTS } from './types.js';
import type { AgentType, ServerEntry } from './types.js';

describe('agent-config', () => {
  const originalHome = process.env.HOME;
  let homeDir = '';

  beforeEach(async () => {
    homeDir = await mkdtemp(join(tmpdir(), 'mcpkit-agent-config-'));
    process.env.HOME = homeDir;
  });

  afterEach(async () => {
    if (originalHome === undefined) {
      delete process.env.HOME;
    } else {
      process.env.HOME = originalHome;
    }
    await rm(homeDir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it('saves and loads agent settings', async () => {
    const settings = createAgentSettings(['claude-code', 'codex'], '2026-03-24T00:00:00.000Z');

    await saveAgentSettings(settings);

    await expect(loadAgentSettings()).resolves.toEqual(settings);
  });

  it('accepts openclaw in saved default agents', async () => {
    const settings = createAgentSettings(['openclaw'], '2026-03-24T00:00:00.000Z');

    await saveAgentSettings(settings);

    await expect(loadAgentSettings()).resolves.toEqual(settings);
  });

  it('ignores invalid settings files', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    await mkdir(join(homeDir, '.mcpkit'), { recursive: true });
    await writeFile(getAgentSettingsPath(), 'version: 1\nenabledAgents:\n  - made-up\nupdatedAt: now\n', 'utf-8');

    await expect(loadAgentSettings()).resolves.toBeNull();
    expect(warnSpy).toHaveBeenCalledOnce();
  });

  it('resolves explicit include and exclude selections', async () => {
    await expect(resolveInstallAgentSelection({
      includeAgents: ['claude-code', 'cursor'],
      excludeAgents: ['cursor'],
      detectedAgents: ['codex'],
      settings: createAgentSettings(['codex']),
      stdinIsTTY: false,
      stdoutIsTTY: false,
    })).resolves.toMatchObject({
      agents: ['claude-code'],
      selectionMode: 'explicit',
      source: 'explicit',
    });
  });

  it('uses saved defaults as the base set for exclude-only installs', async () => {
    await expect(resolveInstallAgentSelection({
      includeAgents: [],
      excludeAgents: ['cursor'],
      detectedAgents: ['claude-code', 'cursor', 'codex'],
      settings: createAgentSettings(['claude-code', 'cursor']),
      stdinIsTTY: false,
      stdoutIsTTY: false,
    })).resolves.toMatchObject({
      agents: ['claude-code'],
      selectionMode: 'explicit',
      source: 'explicit',
    });
  });

  it('uses interactive onboarding on first run and returns settings to save', async () => {
    const promptForAgents = vi.fn().mockResolvedValue(['cursor', 'codex']);

    const result = await resolveInstallAgentSelection({
      includeAgents: [],
      excludeAgents: [],
      detectedAgents: ['cursor'],
      settings: null,
      stdinIsTTY: true,
      stdoutIsTTY: true,
      promptForAgents,
    });

    expect(result).toMatchObject({
      agents: ['cursor', 'codex'],
      selectionMode: 'defaults',
      source: 'interactive',
    });
    expect(result.settingsToSave?.enabledAgents).toEqual(['cursor', 'codex']);
    expect(promptForAgents).toHaveBeenCalledWith({
      currentAgents: ['cursor'],
      detectedAgents: ['cursor'],
      isFirstRun: true,
    });
  });

  it('falls back to detected agents in non-interactive installs without settings', async () => {
    await expect(resolveInstallAgentSelection({
      includeAgents: [],
      excludeAgents: [],
      detectedAgents: ['cursor', 'codex'],
      settings: null,
      stdinIsTTY: false,
      stdoutIsTTY: false,
    })).resolves.toMatchObject({
      agents: ['cursor', 'codex'],
      selectionMode: 'defaults',
      source: 'detected',
    });
  });

  it('falls back to claude-code when nothing is configured or detected', async () => {
    await expect(resolveInstallAgentSelection({
      includeAgents: [],
      excludeAgents: [],
      detectedAgents: [],
      settings: null,
      stdinIsTTY: false,
      stdoutIsTTY: false,
    })).resolves.toMatchObject({
      agents: ['claude-code'],
      selectionMode: 'defaults',
      source: 'fallback',
    });
  });

  it('uses saved defaults for defaults-managed servers and ignores later detections', () => {
    const entry: ServerEntry = {
      name: 'github',
      transport: { type: 'stdio', command: 'npx', args: [] },
      toolCount: 10,
      agents: ['cursor'],
      agentSelectionMode: 'defaults',
      createdAt: '2026-03-24T00:00:00.000Z',
      updatedAt: '2026-03-24T00:00:00.000Z',
    };

    expect(resolveServerAgents(entry, createAgentSettings(['claude-code']))).toEqual({
      agents: ['claude-code'],
      selectionMode: 'defaults',
      source: 'defaults',
    });
  });

  it('keeps explicit server agents even when defaults change', () => {
    const entry: ServerEntry = {
      name: 'github',
      transport: { type: 'stdio', command: 'npx', args: [] },
      toolCount: 10,
      agents: ['cursor'],
      agentSelectionMode: 'explicit',
      createdAt: '2026-03-24T00:00:00.000Z',
      updatedAt: '2026-03-24T00:00:00.000Z',
    };

    expect(resolveServerAgents(entry, createAgentSettings(['claude-code']))).toEqual({
      agents: ['cursor'],
      selectionMode: 'explicit',
      source: 'explicit',
    });
  });

  describe('entryServesAgent: the agents that a server is installed for are the agents that resolveServerAgents writes its skill for', () => {
    const server = (extra: Partial<ServerEntry>): ServerEntry => ({
      name: 'github',
      transport: { type: 'stdio', command: 'npx', args: [] },
      toolCount: 1,
      agents: ['claude-code'],
      createdAt: '2026-03-24T00:00:00.000Z',
      updatedAt: '2026-03-24T00:00:00.000Z',
      ...extra,
    });
    const served = (entry: ServerEntry, settings: ReturnType<typeof createAgentSettings> | null): AgentType[] => ALL_AGENTS.filter((agent) => entryServesAgent(entry, settings, agent));

    it('agrees with resolveServerAgents for every agent, in every mode and settings case', () => {
      const settingsCases = [null, createAgentSettings(['claude-code', 'cursor'], '2026-03-24T00:00:00.000Z')];
      const entries = [
        server({ agentSelectionMode: 'defaults' }),
        server({}),
        server({ agentSelectionMode: 'defaults', agents: [] }),
        server({ agentSelectionMode: 'explicit', agents: ['codex', 'hermes'] }),
        server({ agentSelectionMode: 'explicit', agents: [] }),
      ];
      for (const settings of settingsCases) {
        for (const entry of entries) {
          expect(served(entry, settings)).toEqual(ALL_AGENTS.filter((agent) => resolveServerAgents(entry, settings).agents.includes(agent)));
        }
      }
    });

    it('follows the saved defaults for a server in defaults mode, whatever its stored list says; an explicit list is respected', () => {
      const settings = createAgentSettings(['claude-code', 'cursor'], '2026-03-24T00:00:00.000Z');
      expect(served(server({ agentSelectionMode: 'defaults', agents: ['claude-code'] }), settings)).toEqual(['claude-code', 'cursor']);
      expect(served(server({ agents: ['codex'] }), settings)).toEqual(['claude-code', 'cursor']);
      expect(served(server({ agentSelectionMode: 'explicit', agents: ['claude-code'] }), settings)).toEqual(['claude-code']);
    });

    it('has no "an empty list serves every agent": an empty list is Claude Code, a stored list is used without saved defaults', () => {
      expect(served(server({ agents: [] }), null)).toEqual(['claude-code']);
      expect(served(server({ agentSelectionMode: 'explicit', agents: [] }), null)).toEqual(['claude-code']);
      expect(served(server({ agents: ['codex', 'cursor'] }), null)).toEqual(['cursor', 'codex']);
    });

    it('counts a missing list as an empty one and serves no agent for a list that names an unknown one', () => {
      expect(served(server({ agents: undefined as unknown as AgentType[] }), null)).toEqual(['claude-code']);
      expect(served(server({ agents: ['claude-code', 'not-an-agent' as AgentType] }), null)).toEqual([]);
    });
  });

  it('parses agent selection input by index and name', () => {
    expect(parseAgentSelectionInput('2 codex', ['claude-code'])).toEqual(['cursor', 'codex']);
  });

  it('parses openclaw by name', () => {
    expect(parseAgentSelectionInput('openclaw', ['claude-code'])).toEqual(['openclaw']);
  });
});
