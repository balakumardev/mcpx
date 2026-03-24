import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  createAgentSettings,
  getAgentSettingsPath,
  loadAgentSettings,
  parseAgentSelectionInput,
  resolveInstallAgentSelection,
  resolveServerAgents,
  saveAgentSettings,
} from './agent-config.js';
import type { ServerEntry } from './types.js';

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

  it('parses agent selection input by index and name', () => {
    expect(parseAgentSelectionInput('2 codex', ['claude-code'])).toEqual(['cursor', 'codex']);
  });
});
